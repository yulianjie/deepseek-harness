import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { discoverSshAliases, isSshAlias } from './ssh-config.mjs';

const LOOPBACK = '127.0.0.1';
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SSH_OPTIONS = [
  'BatchMode=yes', 'StrictHostKeyChecking=yes', 'VerifyHostKeyDNS=no', 'UpdateHostKeys=no',
  'NoHostAuthenticationForLocalhost=no', 'PermitLocalCommand=no', 'RemoteCommand=none',
  'ControlMaster=no', 'ControlPersist=no', 'ControlPath=none', 'ForkAfterAuthentication=no',
  'ForwardAgent=no', 'ForwardX11=no', 'Tunnel=no', 'GatewayPorts=no', 'EscapeChar=none',
  'ConnectTimeout=10', 'ConnectionAttempts=1', 'ServerAliveInterval=10', 'ServerAliveCountMax=2',
];

function systemSshExecutable() {
  const windows = process.platform === 'win32';
  const filename = windows ? 'ssh.exe' : 'ssh';
  const system = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH') : '/usr/bin';
  const fromPath = (process.env.PATH ?? '').split(path.delimiter).filter(path.isAbsolute);
  for (const directory of [system, ...fromPath]) {
    const candidate = path.join(directory, filename);
    try {
      if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
    } catch (error) {
      if (!['ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  // An absolute fallback keeps Windows CreateProcess from searching the project cwd.
  return path.join(system, filename);
}

export class ConnectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConnectionError';
    this.code = code;
  }
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConnectionError('INVALID_PORT', 'SSH forward requires a numeric port from 1 to 65535.');
  }
}

/** Every destination occupies one argv entry. Remote commands contain no user data. */
export function buildSshArgs(alias, { mode = 'script', configPath, localPort, remotePort } = {}) {
  if (!isSshAlias(alias)) throw new ConnectionError('INVALID_ALIAS', 'Enter a literal OpenSSH Host alias or hostname.');
  const args = ['-T'];
  if (configPath) args.push('-F', configPath);
  for (const option of SSH_OPTIONS) args.push('-o', option);
  switch (mode) {
    case 'config':
      args.push('-G', '-o', 'ClearAllForwardings=no');
      break;
    case 'script':
      args.push('-o', 'ClearAllForwardings=yes', '-o', 'SessionType=default', '-o', 'StdinNull=no');
      break;
    case 'tunnel':
      assertPort(localPort);
      assertPort(remotePort);
      args.push('-v', '-N', '-n', '-o', 'ExitOnForwardFailure=yes', '-o', 'ClearAllForwardings=no',
        '-L', `${LOOPBACK}:${localPort}:${LOOPBACK}:${remotePort}`);
      break;
    default:
      throw new TypeError('Unsupported OpenSSH operation.');
  }
  args.push('--', alias);
  if (mode === 'script') args.push('sh -s');
  return args;
}

export function parseSshConfig(output) {
  const result = Object.create(null);
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    (result[key] ??= []).push(match[2]);
  }
  return result;
}

export function diagnoseSshFailure(stderr, fallback = 'SSH_FAILED') {
  stderr = stderr.split(/\r?\n/).filter((line) => !/^debug[123]:/.test(line)).join('\n');
  if (/remote host identification has changed|offending .*key|host key.*(?:changed|revoked)/i.test(stderr)) {
    return new ConnectionError('SSH_HOST_KEY_CHANGED', 'The SSH host key changed or was revoked. Verify the new fingerprint with the host administrator.');
  }
  if (/host key verification failed|no .*host key is known|strict checking/i.test(stderr)) {
    return new ConnectionError('SSH_HOST_KEY_UNVERIFIED', 'Verify the SSH host fingerprint in an interactive OpenSSH session to register it in known_hosts.');
  }
  if (/permission denied.*(?:keyboard-interactive|password)|authentication.*(?:keyboard-interactive|password)/i.test(stderr)) {
    return new ConnectionError('SSH_INTERACTIVE_AUTH_REQUIRED', 'SSH requires an interactive authentication method. Configure a key or an authenticated SSH agent for the host.');
  }
  if (/permission denied|no supported authentication|authentication failed|agent refused/i.test(stderr)) {
    return new ConnectionError('SSH_AUTH_FAILED', 'OpenSSH could not authenticate. Check the host user, key and SSH agent.');
  }
  if (/could not resolve hostname|name or service not known|nodename nor servname provided/i.test(stderr)) {
    return new ConnectionError('SSH_HOST_NOT_FOUND', 'OpenSSH could not resolve the host. Check the SSH Host alias and HostName.');
  }
  if (/bad owner or permissions|unprotected private key file/i.test(stderr)) {
    return new ConnectionError('SSH_BAD_PERMISSIONS', 'OpenSSH refused an SSH configuration or key file with insecure permissions. Check its ownership and access controls.');
  }
  if (/address already in use|cannot listen to port|could not request local forwarding/i.test(stderr)) {
    return new ConnectionError('SSH_FORWARD_BIND_FAILED', 'OpenSSH could not bind its loopback forward.');
  }
  if (/connection (?:[^\r\n]*? )?(?:timed out|refused|reset|closed)|operation timed out|network is unreachable|no route to host/i.test(stderr)) {
    return new ConnectionError('SSH_NETWORK_ERROR', 'OpenSSH could not reach the host or the connection ended.');
  }
  return new ConnectionError(fallback, fallback === 'SSH_TUNNEL_CLOSED'
    ? 'The OpenSSH tunnel ended.'
    : 'OpenSSH failed. Check the alias and its configuration with the system ssh command.');
}

function spawnSsh(executable, args) {
  return spawn(executable, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // Isolate /dev/tty prompts and allow owned ProxyJump/ProxyCommand children to be closed together.
    detached: process.platform !== 'win32',
    env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never', LC_ALL: 'C', LANG: 'C' },
  });
}

function killSsh(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill();
    else process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function spawnFailure(error) {
  return error.code === 'ENOENT'
    ? new ConnectionError('SSH_NOT_FOUND', 'Install the system OpenSSH client and make ssh available in PATH.')
    : new ConnectionError('SSH_SPAWN_FAILED', 'The system OpenSSH client could not be started.');
}

function captureSsh(executable, args, { signal, input, timeout, onStderr, config = false }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawnSsh(executable, args);
    const stdout = [];
    const stderr = [];
    const stderrDecoder = onStderr ? new StringDecoder('utf8') : undefined;
    let bytes = 0;
    let failure;
    const stop = (error) => {
      failure ??= error;
      killSsh(child);
    };
    const abort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(new ConnectionError('SSH_TIMEOUT', 'The SSH operation timed out.')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => { failure ??= spawnFailure(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (stderrDecoder) {
        const tail = stderrDecoder.end();
        try { if (tail) onStderr(tail); } catch (error) { return reject(error); }
      }
      const details = Buffer.concat(stderr).toString('utf8');
      if (code === 0) return resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: details });
      if (!config && code !== 255) {
        return reject(new ConnectionError('SSH_REMOTE_SCRIPT_FAILED', `The remote setup script exited with status ${code}.`));
      }
      reject(diagnoseSshFailure(details, config ? 'SSH_CONFIG_FAILED' : 'SSH_FAILED'));
    });
    function collect(chunk, destination) {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) return stop(new ConnectionError('SSH_OUTPUT_LIMIT', 'OpenSSH produced too much diagnostic output.'));
      destination.push(chunk);
    }
    child.stdout.on('data', (chunk) => collect(chunk, stdout));
    child.stderr.on('data', (chunk) => {
      collect(chunk, stderr);
      if (!failure && stderrDecoder) {
        const text = stderrDecoder.write(chunk);
        try { if (text) onStderr(text); } catch (error) { stop(error); }
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function allocatePort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK, port: 0, exclusive: true }, () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startTunnel(executable, args, port, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawnSsh(executable, args);
    child.stdin.on('error', () => {});
    child.stdin.end();
    child.stdout.resume();
    let stderr = '';
    let ready = false;
    let requestedClose = false;
    let failure;
    let settleClosed;
    const closed = new Promise((resolveClosed) => { settleClosed = resolveClosed; });
    const close = () => {
      requestedClose = true;
      killSsh(child);
      return closed;
    };
    const abort = () => { failure = signal.reason; killSsh(child); };
    const timer = setTimeout(() => {
      failure = new ConnectionError('SSH_TIMEOUT', 'OpenSSH timed out while starting its loopback tunnel.');
      killSsh(child);
    }, 30_000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-32_768);
      // With ExitOnForwardFailure the client only enters its loop after the listener was created.
      const listening = stderr.lastIndexOf(`Local forwarding listening on ${LOOPBACK} port ${port}.`);
      if (!ready && !failure && listening >= 0 && stderr.indexOf('debug1: Entering interactive session.', listening) >= 0) {
        ready = true;
        clearTimeout(timer);
        resolve({ port, closed, close });
      }
    });
    child.once('error', (error) => { failure ??= spawnFailure(error); });
    child.once('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const error = failure ?? diagnoseSshFailure(stderr, 'SSH_TUNNEL_CLOSED');
      settleClosed(requestedClose ? undefined : error);
      if (!ready) reject(error);
    });
  });
}

export class OpenSsh {
  constructor({ executable = systemSshExecutable(), configPath, home } = {}) {
    this.executable = executable;
    this.configPath = configPath;
    this.home = home;
  }

  discover() {
    return discoverSshAliases({ home: this.home, configPath: this.configPath });
  }

  async resolve(alias, { signal } = {}) {
    const args = buildSshArgs(alias, { mode: 'config', configPath: this.configPath });
    const { stdout } = await captureSsh(this.executable, args, { signal, timeout: 15_000, config: true });
    const settings = parseSshConfig(stdout);
    const hostname = settings.hostname?.[0];
    const user = settings.user?.[0];
    const port = Number(settings.port?.[0]);
    if (!hostname || !user || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConnectionError('SSH_CONFIG_FAILED', 'OpenSSH returned an incomplete host configuration.');
    }
    return { alias, hostname, user, port, settings };
  }

  runScript(alias, script, { signal, onStderr, timeout = 600_000 } = {}) {
    if (typeof script !== 'string' && !Buffer.isBuffer(script)) throw new TypeError('Expected a remote script.');
    const args = buildSshArgs(alias, { configPath: this.configPath });
    return captureSsh(this.executable, args, { signal, input: script, onStderr, timeout });
  }

  async openTunnel(alias, remotePort, { signal } = {}) {
    assertPort(remotePort);
    const { settings } = await this.resolve(alias, { signal });
    // ClearAllForwardings=yes would clear the command-line -L as well.
    if (settings.localforward || settings.remoteforward || settings.dynamicforward) {
      throw new ConnectionError('SSH_CONFIGURED_FORWARD', 'Use a dedicated SSH alias without configured LocalForward, RemoteForward or DynamicForward rules.');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const localPort = await allocatePort();
      const args = buildSshArgs(alias, { mode: 'tunnel', configPath: this.configPath, localPort, remotePort });
      try {
        return await startTunnel(this.executable, args, localPort, signal);
      } catch (error) {
        if (error.code !== 'SSH_FORWARD_BIND_FAILED' || attempt === 2) throw error;
      }
    }
  }
}
