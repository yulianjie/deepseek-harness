import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ConnectionError, OpenSsh, resolveIdentityFile } from './ssh.mjs';
import { isSshAlias } from './ssh-config.mjs';

export { ConnectionError, OpenSsh, buildSshArgs, diagnoseSshFailure, parseSshConfig } from './ssh.mjs';
export { discoverSshAliases } from './ssh-config.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function unknownHost() {
  return new ConnectionError('HOST_NOT_FOUND', 'The SSH host configuration was not found.');
}

function cancelled() {
  return new ConnectionError('SSH_CANCELLED', 'The SSH connection was disconnected.');
}

function assertId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw unknownHost();
}

function hostRecord({ id, alias, label, instance, authMode = 'config', identityFile }) {
  assertId(id);
  if (!isSshAlias(alias)) throw new ConnectionError('INVALID_ALIAS', 'Enter a literal OpenSSH Host alias or hostname.');
  if (typeof label !== 'string' || !label.trim() || label.length > 100 || /\p{Cc}/u.test(label)) {
    throw new ConnectionError('INVALID_LABEL', 'The host label must contain 1 to 100 printable characters.');
  }
  if (typeof instance !== 'string' || !INSTANCE.test(instance)) {
    throw new ConnectionError('INVALID_INSTANCE', 'The instance name must start with a letter or digit and use up to 64 letters, digits, dots, dashes or underscores.');
  }
  if (!['config', 'key', 'password'].includes(authMode)) {
    throw new ConnectionError('INVALID_AUTH_MODE', 'Select an SSH authentication method.');
  }
  if (authMode === 'key') resolveIdentityFile(identityFile);
  return { id, alias, label: label.trim(), instance, authMode, ...(authMode === 'key' ? { identityFile } : {}) };
}

function connectionPassword(authMode, password) {
  if (authMode !== 'password') return undefined;
  if (password === undefined || password === '') {
    throw new ConnectionError('SSH_PASSWORD_REQUIRED', 'Enter the SSH password to connect to this host.');
  }
  if (typeof password !== 'string' || !password.isWellFormed() || Buffer.byteLength(password) > 1023 || /[\0\r\n]/.test(password)) {
    throw new ConnectionError(
      'INVALID_PASSWORD', 'Enter an SSH password without line breaks or null characters and up to 1023 UTF-8 bytes.',
    );
  }
  return password;
}

function sameConnection(a, b) {
  return a.alias === b.alias && a.instance === b.instance && a.authMode === b.authMode && a.identityFile === b.identityFile;
}

function validateDeployment(value) {
  if (!value || typeof value.hostId !== 'string' || !ID.test(value.hostId) ||
    typeof value.instanceId !== 'string' || !ID.test(value.instanceId) ||
    typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
    typeof value.version !== 'string' || !/^[0-9][A-Za-z0-9.+-]{0,31}$/.test(value.version) ||
    !Number.isInteger(value.remotePort) || value.remotePort < 1 || value.remotePort > 65535) {
    throw new ConnectionError('REMOTE_DEPLOY_INVALID', 'Remote setup returned an invalid Harness instance.');
  }
  const { hostId, instanceId, bootId, version, remotePort, token } = value;
  return { hostId, instanceId, bootId, version, remotePort, token };
}

function publicError(error) {
  if (error instanceof ConnectionError) return error;
  return new ConnectionError('REMOTE_CONNECT_FAILED', 'The remote Harness could not be prepared. Check the host prerequisites and the remote instance logs.');
}

function newReadiness() {
  let resolve;
  let reject;
  const promise = new Promise((ready, fail) => { resolve = ready; reject = fail; });
  // The tunnel may end after the original caller has attached.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Owns SSH host metadata and the local forwarding processes. */
export class ConnectionManager {
  #directory;
  #ssh;
  #deploy;
  #entries = new Map();
  #queue = Promise.resolve();
  #disposal;

  constructor({ stateDir, ssh = new OpenSsh(), deploy }) {
    if (typeof stateDir !== 'string' || !stateDir || typeof deploy !== 'function') {
      throw new TypeError('ConnectionManager requires stateDir and deploy.');
    }
    this.#directory = join(resolve(stateDir), 'hosts');
    this.#ssh = ssh;
    this.#deploy = deploy;
  }

  #schedule(action) {
    const next = this.#queue.then(() => {
      if (this.#disposal) throw cancelled();
      return action();
    });
    this.#queue = next.catch(() => {});
    return next;
  }

  async #readHost(id) {
    assertId(id);
    let data;
    try {
      data = await readFile(join(this.#directory, `${id}.json`), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw unknownHost();
      throw error;
    }
    try {
      const record = hostRecord(JSON.parse(data));
      if (record.id !== id) throw new Error('Invalid id');
      return record;
    } catch {
      throw new ConnectionError('HOST_STATE_INVALID', 'A saved SSH host configuration is invalid.');
    }
  }

  listHosts() {
    return this.#schedule(async () => {
      let files;
      try { files = await readdir(this.#directory, { withFileTypes: true }); } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const hosts = [];
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        const id = file.name.slice(0, -5);
        if (!ID.test(id)) continue;
        try { hosts.push(await this.#readHost(id)); } catch (error) {
          if (error.code !== 'HOST_NOT_FOUND') throw error;
        }
      }
      return hosts.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    });
  }

  discover() {
    return this.#ssh.discover();
  }

  save({ id, alias, label, instance, authMode, identityFile } = {}) {
    return this.#schedule(async () => {
      const existing = id === undefined ? undefined : await this.#readHost(id);
      const host = hostRecord({ id: id ?? randomUUID(), alias, label: label ?? existing?.label ?? alias,
        instance: instance ?? existing?.instance ?? 'default', authMode: authMode === undefined ? existing?.authMode : authMode,
        identityFile: identityFile === undefined ? existing?.identityFile : identityFile });
      const filename = join(this.#directory, `${host.id}.json`);
      const temp = join(this.#directory, `${randomUUID()}.tmp`);
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      try {
        await writeFile(temp, `${JSON.stringify(host)}\n`, { flag: 'wx', mode: 0o600 });
        await rename(temp, filename);
      } finally {
        await rm(temp, { force: true });
      }
      if (existing && !sameConnection(existing, host)) {
        await this.#disconnect(host.id);
      }
      return host;
    });
  }

  remove(id) {
    return this.#schedule(async () => {
      await this.#readHost(id);
      await rm(join(this.#directory, `${id}.json`), { force: true });
      await this.#disconnect(id);
    });
  }

  status(id) {
    const entry = this.#entries.get(id);
    if (!entry) return { id, state: 'disconnected' };
    const { state, stage, error, deployment } = entry;
    return {
      id, state, stage,
      ...(error ? { error: { code: error.code, message: error.message } } : {}),
      ...(deployment ? { hostId: deployment.hostId, instanceId: deployment.instanceId, version: deployment.version } : {}),
    };
  }

  /** Open a server-side SSH forward. A password is used only during a new connection's setup. */
  async connectNative(id, { password } = {}) {
    const entry = await this.#schedule(async () => {
      const host = await this.#readHost(id);
      const current = this.#entries.get(id);
      if (current && current.state !== 'error' && current.state !== 'disconnected' &&
          sameConnection(current.host, host)) {
        return current;
      }
      const authentication = { password: connectionPassword(host.authMode, password) };
      password = undefined;
      await this.#disconnect(id);
      if (this.#disposal) throw cancelled();
      const entry = { host, controller: new AbortController(), readiness: newReadiness(), state: 'connecting', stage: 'resolve' };
      this.#entries.set(id, entry);
      entry.task = this.#supervise(entry, authentication);
      return entry;
    }).finally(() => {
      password = undefined;
    });
    do {
      await entry.readiness.promise;
      entry.controller.signal.throwIfAborted();
    } while (entry.state !== 'connected');
    const { hostId, instanceId, bootId, version, token } = entry.deployment;
    return { label: entry.host.label, hostId, instanceId, bootId, version, token, ...entry.forward };
  }

  disconnect(id) {
    return this.#schedule(() => this.#disconnect(id));
  }

  async #disconnect(id) {
    const entry = this.#entries.get(id);
    if (entry) {
      entry.controller.abort(cancelled());
      await entry.task;
      this.#entries.delete(id);
    }
    return { id, state: 'disconnected' };
  }

  dispose() {
    if (!this.#disposal) {
      for (const entry of this.#entries.values()) entry.controller.abort(cancelled());
      this.#disposal = this.#queue.then(() => Promise.all([...this.#entries.keys()].map((id) => this.#disconnect(id))));
    }
    return this.#disposal;
  }

  async #supervise(entry, authentication) {
    const { host, controller: { signal } } = entry;
    let tunnel;
    try {
      const config = await this.#ssh.resolve(host.alias, { signal, identityFile: host.identityFile });
      if (config?.settings?.localforward || config?.settings?.remoteforward || config?.settings?.dynamicforward) {
        throw new ConnectionError('SSH_CONFIGURED_FORWARD', 'Use a dedicated SSH alias without configured LocalForward, RemoteForward or DynamicForward rules.');
      }
      signal.throwIfAborted();
      entry.stage = 'deploy';
      entry.deployment = validateDeployment(await this.#deploy(host, ({ stage } = {}) => {
        if (!signal.aborted && /^[a-z][a-z0-9_-]{0,39}$/.test(stage ?? '')) entry.stage = stage;
      }, signal, authentication));
      signal.throwIfAborted();
      entry.stage = 'tunnel';
      tunnel = await this.#ssh.openTunnel(host.alias, entry.deployment.remotePort, {
        signal, identityFile: host.identityFile, authentication,
      });
      authentication.password = undefined;
      signal.throwIfAborted();
      const tunnelLifetime = new AbortController();
      const drop = tunnel.closed.then((error) => {
        const reason = error ?? new ConnectionError('SSH_TUNNEL_CLOSED', 'The OpenSSH tunnel ended.');
        tunnelLifetime.abort(reason);
        return reason;
      });
      entry.forward = { port: tunnel.port, signal: AbortSignal.any([signal, tunnelLifetime.signal]) };
      entry.state = 'connected';
      entry.stage = undefined;
      entry.readiness.resolve();
      const abortTunnel = () => { void tunnel.close(); };
      signal.addEventListener('abort', abortTunnel, { once: true });
      try { throw await drop; } finally { signal.removeEventListener('abort', abortTunnel); }
    } catch (error) {
      const failure = signal.aborted ? cancelled() : publicError(error);
      if (entry.state === 'connected') entry.readiness = newReadiness();
      entry.readiness.reject(failure);
      entry.state = signal.aborted ? 'disconnected' : 'error';
      entry.error = signal.aborted ? undefined : failure;
    } finally {
      authentication.password = undefined;
      if (tunnel) await tunnel.close();
      if (entry.deployment) delete entry.deployment.token;
    }
  }
}
