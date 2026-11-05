import { spawn } from 'node:child_process';
import { constants, statSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { startAskpass } from './askpass.mjs';
import { discoverSshAliases, isSshAlias } from './ssh-config.mjs';

const LOOPBACK = '127.0.0.1';
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SSH_OPTIONS = [
  'StrictHostKeyChecking=yes', 'VerifyHostKeyDNS=no', 'UpdateHostKeys=no',
  'NoHostAuthenticationForLocalhost=no', 'PermitLocalCommand=no', 'RemoteCommand=none',
  'ControlMaster=no', 'ControlPersist=no', 'ControlPath=none', 'ForkAfterAuthentication=no',
  'ForwardAgent=no', 'ForwardX11=no', 'Tunnel=no', 'GatewayPorts=no', 'EscapeChar=none',
  'ConnectTimeout=10', 'ConnectionAttempts=1', 'ServerAliveInterval=10', 'ServerAliveCountMax=2',
];
const PASSWORD_OPTIONS = [
  'BatchMode=no', 'PreferredAuthentications=password', 'PasswordAuthentication=yes',
  'KbdInteractiveAuthentication=no', 'PubkeyAuthentication=no', 'HostbasedAuthentication=no',
  'GSSAPIAuthentication=no', 'NumberOfPasswordPrompts=1',
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

/** Identify the effective SSH account and routing options for a remembered password. */
export function resolvedPasswordTarget({ hostname, user, port, settings }) {
  return JSON.stringify([hostname, user, port, settings.proxyjump, settings.proxycommand, settings.hostkeyalias]);
}

export function passwordTargetChanged() {
  return new ConnectionError('SSH_PASSWORD_TARGET_CHANGED', 'SSH 连接目标已更改。请确认主机配置并手动输入密码。');
}

function checkPasswordTarget(authentication, config) {
  if (authentication?.target !== undefined && authentication.target !== resolvedPasswordTarget(config)) {
    throw passwordTargetChanged();
  }
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConnectionError('INVALID_PORT', 'SSH forward requires a numeric port from 1 to 65535.');
  }
}

function invalidIdentityFile() {
  return new ConnectionError(
    'INVALID_IDENTITY_FILE', 'Enter a readable local SSH private key file using an absolute path or a path starting with ~/.',
  );
}

/** Resolve a literal local path without allowing OpenSSH's token or environment expansion. */
export function resolveIdentityFile(identityFile, home = homedir()) {
  if (typeof identityFile !== 'string' || !identityFile.isWellFormed() || Buffer.byteLength(identityFile) > 2048) {
    throw invalidIdentityFile();
  }
  if (identityFile.startsWith('~/') || (process.platform === 'win32' && identityFile.startsWith('~\\'))) {
    identityFile = `${home}${path.sep}${identityFile.slice(2)}`;
  }
  if (/[\p{Cc}%]|\$\{/u.test(identityFile) || !path.isAbsolute(identityFile) ||
      (process.platform === 'win32' && path.parse(identityFile).root.length < 3)) {
    throw invalidIdentityFile();
  }
  return identityFile;
}

async function readableIdentityFile(identityFile, home) {
  const filename = resolveIdentityFile(identityFile, home);
  try {
    if ((await stat(filename)).isFile()) {
      await access(filename, constants.R_OK);
      return filename;
    }
  } catch {
    throw invalidIdentityFile();
  }
  throw invalidIdentityFile();
}

/** Every destination occupies one argv entry. Remote commands contain no user data. */
export function buildSshArgs(alias, { mode = 'script', configPath, localPort, remotePort, identityFile, passwordAuth = false } = {}) {
  if (!isSshAlias(alias)) throw new ConnectionError('INVALID_ALIAS', 'Enter a literal OpenSSH Host alias or hostname.');
  const args = ['-T'];
  if (configPath) args.push('-F', configPath);
  for (const option of SSH_OPTIONS) args.push('-o', option);
  for (const option of passwordAuth ? PASSWORD_OPTIONS : ['BatchMode=yes']) args.push('-o', option);
  if (identityFile !== undefined) args.push('-o', 'IdentitiesOnly=yes', '-i', identityFile);
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

export function diagnoseSshFailure(stderr, fallback = 'SSH_FAILED', passwordAuth = false) {
  stderr = stderr.split(/\r?\n/).filter((line) => !/^debug[123]:/.test(line)).join('\n');
  if (/remote host identification has changed|offending .*key|host key.*(?:changed|revoked)/i.test(stderr)) {
    return new ConnectionError('SSH_HOST_KEY_CHANGED', 'The SSH host key changed or was revoked. Verify the new fingerprint with the host administrator.');
  }
  if (/host key verification failed|no .*host key is known|strict checking/i.test(stderr)) {
    return new ConnectionError('SSH_HOST_KEY_UNVERIFIED', 'Verify the SSH host fingerprint in an interactive OpenSSH session to register it in known_hosts.');
  }
  if (/ssh_askpass:|(?:exec|posix_spawnp).*askpass/i.test(stderr)) {
    return new ConnectionError(
      'SSH_ASKPASS_UNAVAILABLE', 'OpenSSH could not start the password helper. Check the Desktop installation and OpenSSH client.',
    );
  }
  if (/bad owner or permissions|unprotected private key file/i.test(stderr)) {
    return new ConnectionError(
      'SSH_BAD_PERMISSIONS', 'OpenSSH refused the SSH configuration or key file. Check its ownership and access controls.',
    );
  }
  const interactiveDenied = /permission denied.*(?:keyboard-interactive|password)|authentication.*(?:keyboard-interactive|password)/i;
  if (!passwordAuth && interactiveDenied.test(stderr)) {
    return new ConnectionError(
      'SSH_INTERACTIVE_AUTH_REQUIRED', 'Select SSH password authentication or configure a key or SSH agent for the host.',
    );
  }
  if (/permission denied|no supported authentication|authentication failed|agent refused/i.test(stderr)) {
    return new ConnectionError('SSH_AUTH_FAILED', passwordAuth
      ? 'OpenSSH could not authenticate with the password. Check the SSH user, password and the server’s password authentication settings.'
      : 'OpenSSH could not authenticate. Check the host user, key and SSH agent.');
  }
  if (/could not resolve hostname|name or service not known|nodename nor servname provided/i.test(stderr)) {
    return new ConnectionError('SSH_HOST_NOT_FOUND', 'OpenSSH could not resolve the host. Check the SSH Host alias and HostName.');
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

function spawnSsh(executable, args, askpass) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|^SSH_ASKPASS|^DSH_SSH_ASKPASS/i.test(key)));
  const child = spawn(executable, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // Isolate /dev/tty prompts and allow owned ProxyJump/ProxyCommand children to be closed together.
    detached: process.platform !== 'win32',
    env: { ...env, SSH_ASKPASS_REQUIRE: 'never', LC_ALL: 'C', LANG: 'C', ...askpass?.env },
  });
  askpass?.allow(child.pid);
  return child;
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

function captureSsh(executable, args, { signal, input, timeout, onStderr, config = false, askpass }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawnSsh(executable, args, askpass);
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
      reject(diagnoseSshFailure(details, config ? 'SSH_CONFIG_FAILED' : 'SSH_FAILED', askpass !== undefined));
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

function startTunnel(executable, args, port, signal, askpass) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawnSsh(executable, args, askpass);
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
      const error = failure ?? diagnoseSshFailure(stderr, 'SSH_TUNNEL_CLOSED', askpass !== undefined);
      settleClosed(requestedClose ? undefined : error);
      if (!ready) reject(error);
    });
  });
}

export class OpenSsh {
  constructor({ executable = systemSshExecutable(), configPath, home,
    askpassExecutable = process.env.DSH_DESKTOP_SSH_ASKPASS_EXECUTABLE } = {}) {
    this.executable = executable;
    this.configPath = configPath;
    this.home = home;
    this.askpassExecutable = askpassExecutable;
  }

  discover() {
    return discoverSshAliases({ home: this.home, configPath: this.configPath });
  }

  async resolve(alias, { signal, identityFile } = {}) {
    const filename = identityFile === undefined ? undefined : await readableIdentityFile(identityFile, this.home);
    const args = buildSshArgs(alias, { mode: 'config', configPath: this.configPath, identityFile: filename });
    const { stdout } = await captureSsh(this.executable, args, { signal, timeout: 15_000, config: true });
    const settings = parseSshConfig(stdout);
    const hostname = settings.hostname?.[0];
    const user = settings.user?.[0];
    const port = Number(settings.port?.[0]);
    if (!hostname || !user || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConnectionError('SSH_CONFIG_FAILED', 'OpenSSH returned an incomplete host configuration.');
    }
    return { alias, hostname, user, port, settings, identityFile: filename };
  }

  async #withAskpass(password, action) {
    if (password === undefined) return action(undefined);
    const windows = process.platform === 'win32';
    let askpass;
    let executable;
    let nodeEnvironment;
    try {
      executable = this.askpassExecutable ?? fileURLToPath(new URL(windows ? './askpass.exe' : './askpass.sh', import.meta.url));
      if (!path.isAbsolute(executable) || !(await stat(executable)).isFile()) {
        throw new Error('Missing executable');
      }
      await access(executable, constants.X_OK);
      if (!windows) {
        nodeEnvironment = {
          DSH_SSH_ASKPASS_NODE: process.execPath,
          DSH_SSH_ASKPASS_ENTRY: fileURLToPath(new URL('./askpass-client.mjs', import.meta.url)),
        };
      }
      askpass = await startAskpass(password);
    } catch {
      throw new ConnectionError(
        'SSH_ASKPASS_UNAVAILABLE', 'The local OpenSSH password helper is unavailable. Check the Desktop installation.',
      );
    } finally {
      password = undefined;
    }
    Object.assign(askpass.env, {
      SSH_ASKPASS: executable, SSH_ASKPASS_REQUIRE: 'force',
      ...nodeEnvironment,
    });
    try {
      return await action(askpass);
    } finally {
      await askpass.close();
    }
  }

  async runScript(alias, script, { signal, onStderr, timeout = 600_000, identityFile, authentication } = {}) {
    if (typeof script !== 'string' && !Buffer.isBuffer(script)) throw new TypeError('Expected a remote script.');
    if (authentication?.target !== undefined) {
      checkPasswordTarget(authentication, await this.resolve(alias, { signal, identityFile }));
    }
    const filename = identityFile === undefined ? undefined : await readableIdentityFile(identityFile, this.home);
    const args = buildSshArgs(alias, {
      configPath: this.configPath, identityFile: filename, passwordAuth: authentication?.password !== undefined,
    });
    return this.#withAskpass(authentication?.password, askpass =>
      captureSsh(this.executable, args, { signal, input: script, onStderr, timeout, askpass }));
  }

  async openTunnel(alias, remotePort, { signal, identityFile, authentication } = {}) {
    assertPort(remotePort);
    const config = await this.resolve(alias, { signal, identityFile });
    checkPasswordTarget(authentication, config);
    const { settings, identityFile: filename } = config;
    // ClearAllForwardings=yes would clear the command-line -L as well.
    if (settings.localforward || settings.remoteforward || settings.dynamicforward) {
      throw new ConnectionError('SSH_CONFIGURED_FORWARD', 'Use a dedicated SSH alias without configured LocalForward, RemoteForward or DynamicForward rules.');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const localPort = await allocatePort();
      const args = buildSshArgs(alias, { mode: 'tunnel', configPath: this.configPath, localPort, remotePort,
        identityFile: filename, passwordAuth: authentication?.password !== undefined });
      try {
        return await this.#withAskpass(authentication?.password, askpass => startTunnel(this.executable, args, localPort, signal, askpass));
      } catch (error) {
        if (error.code !== 'SSH_FORWARD_BIND_FAILED' || attempt === 2) throw error;
      }
    }
  }
}
