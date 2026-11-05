import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ConnectionError, OpenSsh, resolveIdentityFile, resolvedPasswordTarget, passwordTargetChanged } from './ssh.mjs';
import { isSshAlias } from './ssh-config.mjs';

export { ConnectionError, OpenSsh, buildSshArgs, diagnoseSshFailure, parseSshConfig } from './ssh.mjs';
export { discoverSshAliases } from './ssh-config.mjs';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const PASSWORD_RECORD = /^v1:([0-9a-f]{64})\n/;

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

function passwordStoreUnavailable() {
  return new ConnectionError('SSH_PASSWORD_STORE_UNAVAILABLE', '无法访问系统凭据存储。请检查系统凭据存储，或手动输入 SSH 密码。');
}

function passwordStoreFailed() {
  return new ConnectionError('SSH_PASSWORD_STORE_FAILED', '无法更新系统凭据存储中的 SSH 密码。请检查系统凭据存储后重试。');
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
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
  #probe;
  #credentialStore;
  #credentialQueue = Promise.resolve();
  #restoreLifetime = new AbortController();
  #restoreProbes = new Set();
  #entries = new Map();
  #queue = Promise.resolve();
  #disposal;

  constructor({ stateDir, ssh = new OpenSsh(), deploy, probe, credentialStore }) {
    if (typeof stateDir !== 'string' || !stateDir || typeof deploy !== 'function') {
      throw new TypeError('ConnectionManager requires stateDir and deploy.');
    }
    this.#directory = join(resolve(stateDir), 'hosts');
    this.#ssh = ssh;
    this.#deploy = deploy;
    this.#probe = probe;
    this.#credentialStore = credentialStore;
  }

  #schedule(action) {
    const next = this.#queue.then(() => {
      if (this.#disposal) throw cancelled();
      return action();
    });
    this.#queue = next.catch(() => {});
    return next;
  }

  #credentialOperation(action) {
    const next = this.#credentialQueue.then(() => action(this.#credentialStore));
    this.#credentialQueue = next.catch(() => {});
    return next;
  }

  /** Project the vault state without returning a stored password. */
  async passwordState(host) {
    if (host.authMode !== 'password') return undefined;
    if (!this.#credentialStore) return 'unavailable';
    try {
      const stored = await this.#credentialOperation(store => store.get(host.id));
      return stored === undefined ? 'none' : 'saved';
    } catch {
      return 'unavailable';
    }
  }

  async #forgetPassword(id) {
    const entry = this.#entries.get(id);
    if (entry) entry.rememberPassword = undefined;
    if (!this.#credentialStore) return;
    try {
      await this.#credentialOperation(store => store.delete(id));
    } catch {
      throw passwordStoreFailed();
    }
  }

  /** Remove the local credential while keeping an established connection open. */
  forgetPassword(id) {
    return this.#schedule(async () => {
      const host = await this.#readHost(id);
      if (host.authMode !== 'password') return;
      await this.#cancelRestoreProbes(id);
      await this.#forgetPassword(id);
    });
  }

  async #storedAuthentication(host) {
    if (!this.#credentialStore) return { password: connectionPassword(host.authMode, undefined) };
    let record;
    try {
      record = await this.#credentialOperation(store => store.get(host.id));
    } catch {
      throw passwordStoreUnavailable();
    }
    if (record === undefined) return { password: connectionPassword(host.authMode, undefined) };
    const version = PASSWORD_RECORD.exec(record);
    const stored = { digest: digest(record), binding: version?.[1] };
    try {
      const password = connectionPassword(host.authMode, version && record.slice(version[0].length));
      return { password, stored };
    } catch {
      throw await this.#rejectStoredPassword(host.id, stored, 'SSH_SAVED_PASSWORD_REJECTED');
    }
  }

  #bindPassword(host, authentication, config, rememberPassword) {
    if (!authentication.stored && rememberPassword !== true) return undefined;
    const target = resolvedPasswordTarget(config);
    const binding = digest(JSON.stringify([host.alias, host.instance, host.authMode, target]));
    if (authentication.stored && authentication.stored.binding !== binding) throw passwordTargetChanged();
    authentication.target = target;
    return binding;
  }

  async #rejectStoredPassword(id, stored, code) {
    try {
      await this.#credentialOperation(async store => {
        const current = await store.get(id);
        if (current !== undefined && digest(current) === stored.digest) await store.delete(id);
      });
    } catch {
      return new ConnectionError(code, '已记住的 SSH 密码无法使用，也无法从系统凭据存储中移除。请输入当前密码后重试。');
    }
    return code === 'SSH_PASSWORD_TARGET_CHANGED' ? passwordTargetChanged()
      : new ConnectionError(code, '已记住的 SSH 密码无法验证。请输入当前密码后重试。');
  }

  #passwordFailure(host, authentication, error) {
    const { stored } = authentication;
    if (stored && error?.code === 'SSH_AUTH_FAILED') {
      return this.#rejectStoredPassword(host.id, stored, 'SSH_SAVED_PASSWORD_REJECTED');
    }
    if (stored && error?.code === 'SSH_PASSWORD_TARGET_CHANGED') {
      return this.#rejectStoredPassword(host.id, stored, error.code);
    }
    return error;
  }

  async #persistPassword(entry, authentication, binding) {
    if (entry.rememberPassword === undefined) return;
    try {
      await this.#credentialOperation(async store => {
        const { host: { id }, controller: { signal }, rememberPassword } = entry;
        if (signal.aborted || rememberPassword === undefined) return;
        if (rememberPassword) {
          if (!store) throw passwordStoreUnavailable();
          await store.set(id, `v1:${binding}\n${authentication.password}`);
        } else if (store) {
          await store.delete(id);
        }
      });
    } catch {
      entry.passwordWarning = entry.rememberPassword ? 'SSH_PASSWORD_STORE_FAILED' : 'SSH_PASSWORD_FORGET_FAILED';
    }
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
      const changed = existing && !sameConnection(existing, host);
      try {
        await writeFile(temp, `${JSON.stringify(host)}\n`, { flag: 'wx', mode: 0o600 });
        if (changed) {
          await this.#cancelRestoreProbes(host.id);
          if (existing.authMode === 'password') await this.#forgetPassword(host.id);
        }
        await rename(temp, filename);
      } finally {
        await rm(temp, { force: true });
      }
      if (changed) {
        await this.#disconnect(host.id);
      }
      return host;
    });
  }

  remove(id) {
    return this.#schedule(async () => {
      const host = await this.#readHost(id);
      await this.#cancelRestoreProbes(id);
      if (host.authMode === 'password') await this.#forgetPassword(id);
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

  /** Find projects in a legacy SSH instance without provisioning a Host. */
  async probeRestore(id, signal) {
    const probe = await this.#schedule(async () => {
      const host = await this.#readHost(id);
      const controller = new AbortController();
      const signals = [controller.signal, this.#restoreLifetime.signal];
      if (signal) signals.push(signal);
      const probeSignal = AbortSignal.any(signals);
      probeSignal.throwIfAborted();
      const probe = { id, controller };
      probe.task = this.#probeHost(host, probeSignal).finally(() => this.#restoreProbes.delete(probe));
      void probe.task.catch(() => {});
      this.#restoreProbes.add(probe);
      return probe;
    });
    return probe.task;
  }

  async #cancelRestoreProbes(id) {
    const probes = [...this.#restoreProbes].filter(probe => probe.id === id);
    for (const { controller } of probes) controller.abort(cancelled());
    await Promise.allSettled(probes.map(probe => probe.task));
  }

  async #probeHost(host, signal) {
    const authentication = host.authMode === 'password' ? await this.#storedAuthentication(host) : {};
    try {
      signal.throwIfAborted();
      if (authentication.stored) {
        const config = await this.#ssh.resolve(host.alias, { signal, identityFile: host.identityFile });
        this.#bindPassword(host, authentication, config);
      }
      return await this.#probe(host, signal, authentication);
    } catch (error) {
      authentication.password = undefined;
      if (signal.aborted) throw signal.reason;
      const failure = await this.#passwordFailure(host, authentication, error);
      if (failure instanceof ConnectionError) throw failure;
      throw new ConnectionError('SSH_RESTORE_PROBE_FAILED', '无法读取远端已有项目，请手动连接。');
    } finally {
      authentication.password = undefined;
    }
  }

  /** Open a server-side SSH forward. Remember an explicitly supplied password after setup succeeds. */
  async connectNative(id, { password, rememberPassword, expected, upgradeFrom } = {}) {
    const entry = await this.#schedule(async () => {
      const host = await this.#readHost(id);
      const current = this.#entries.get(id);
      if (current && current.state !== 'error' && current.state !== 'disconnected' &&
          sameConnection(current.host, host)) {
        return current;
      }
      const manual = host.authMode === 'password' && password !== undefined;
      const authentication = host.authMode === 'password' && !manual ? await this.#storedAuthentication(host)
        : { password: connectionPassword(host.authMode, password) };
      password = undefined;
      await this.#disconnect(id);
      if (this.#disposal) throw cancelled();
      const entry = { host, controller: new AbortController(), readiness: newReadiness(), state: 'connecting', stage: 'resolve',
        rememberPassword: manual ? rememberPassword : undefined };
      this.#entries.set(id, entry);
      entry.task = this.#supervise(entry, authentication, expected, upgradeFrom);
      return entry;
    }).finally(() => {
      password = undefined;
    });
    do {
      await entry.readiness.promise;
      entry.controller.signal.throwIfAborted();
    } while (entry.state !== 'connected');
    const { hostId, instanceId, bootId, version, token } = entry.deployment;
    return { label: entry.host.label, hostId, instanceId, bootId, version, token, ...entry.forward,
      ...(entry.passwordWarning ? { passwordWarning: entry.passwordWarning } : {}) };
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
      this.#restoreLifetime.abort(cancelled());
      for (const entry of this.#entries.values()) entry.controller.abort(cancelled());
      this.#disposal = Promise.all([
        this.#queue.then(() => Promise.all([...this.#entries.keys()].map((id) => this.#disconnect(id)))),
        Promise.allSettled([...this.#restoreProbes].map(probe => probe.task)),
      ]).then(() => this.#credentialQueue);
    }
    return this.#disposal;
  }

  async #supervise(entry, authentication, expected, upgradeFrom) {
    const { host, controller: { signal } } = entry;
    let tunnel;
    try {
      const config = await this.#ssh.resolve(host.alias, { signal, identityFile: host.identityFile });
      if (config?.settings?.localforward || config?.settings?.remoteforward || config?.settings?.dynamicforward) {
        throw new ConnectionError('SSH_CONFIGURED_FORWARD', 'Use a dedicated SSH alias without configured LocalForward, RemoteForward or DynamicForward rules.');
      }
      const binding = this.#bindPassword(host, authentication, config, this.#credentialStore && entry.rememberPassword);
      signal.throwIfAborted();
      entry.stage = 'deploy';
      entry.deployment = validateDeployment(await this.#deploy(host, ({ stage } = {}) => {
        if (!signal.aborted && /^[a-z][a-z0-9_-]{0,39}$/.test(stage ?? '')) entry.stage = stage;
      }, signal, authentication, expected, upgradeFrom));
      signal.throwIfAborted();
      entry.stage = 'tunnel';
      tunnel = await this.#ssh.openTunnel(host.alias, entry.deployment.remotePort, {
        signal, identityFile: host.identityFile, authentication,
      });
      signal.throwIfAborted();
      await this.#persistPassword(entry, authentication, binding);
      authentication.password = undefined;
      authentication.stored = undefined;
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
      authentication.password = undefined;
      const failure = signal.aborted ? cancelled() : publicError(await this.#passwordFailure(host, authentication, error));
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
