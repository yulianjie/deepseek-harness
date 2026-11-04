import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ConnectionError } from '../connection/ssh.mjs';

export const DSH_VERSION = '0.2.1-rc.5';
export const REMOTE_API_PREFIX = '/api/dsh-remote-ssh';

const RESULT = 'DSH_REMOTE_SSH_RESULT ';
const PROGRESS = 'DSH_REMOTE_SSH_PROGRESS ';
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLIC_DIAGNOSTICS = new Set([
  'REMOTE_LINUX_REQUIRED', 'REMOTE_LOGIN_PROBE_FAILED', 'REMOTE_NODE_REQUIRED', 'REMOTE_NODE_CHANGED',
]);

const sources = {
  'runtime.mjs': '../../remote/runtime.mjs',
  'companion.mjs': '../../remote/companion.mjs',
  'project-catalog.mjs': '../../remote/project-catalog.mjs',
  'browser-storage.js': '../../remote/browser-storage.js',
  'workspace.html': '../../ui/workspace.html',
  'workspace.js': '../../ui/workspace.js',
  'workspace.css': '../../ui/workspace.css',
};

export async function buildRemoteScript(action, instance = 'default') {
  if (!['deploy', 'stop'].includes(action)) throw new TypeError('Unknown remote runtime action');
  if (typeof instance !== 'string' || !INSTANCE_NAME.test(instance)) {
    throw new TypeError('Remote instance must be 1–64 letters, digits, dots, dashes or underscores and start with a letter or digit');
  }
  const [nodeBootstrap, bootstrap, ...assets] = await Promise.all([
    readFile(new URL('./node-bootstrap.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../remote/bootstrap.mjs', import.meta.url), 'utf8'),
    ...Object.values(sources).map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
  ]);
  const files = Object.fromEntries(Object.keys(sources).map((name, index) => [name, assets[index]]));
  const bundle = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const input = JSON.stringify({ action, instance, version: DSH_VERSION, bundle, files });
  return `#!/bin/sh
set -eu
umask 077
runtime_action=${action}
${nodeBootstrap.replaceAll('\r\n', '\n')}
"$remote_node" --input-type=module - "$remote_node" <<'DSH_REMOTE_SSH_BOOTSTRAP'
const input = ${input};
${bootstrap.replaceAll('\r\n', '\n')}
DSH_REMOTE_SSH_BOOTSTRAP
`;
}

function parseResult(stdout) {
  const line = stdout.split(/\r?\n/).findLast((entry) => entry.startsWith(RESULT));
  if (!line) throw new Error('Remote deployment returned no result');
  let result;
  try {
    result = JSON.parse(line.slice(RESULT.length));
  } catch {
    throw new Error('Remote deployment returned invalid data');
  }
  if (result?.error && typeof result.error === 'string') {
    if (PUBLIC_DIAGNOSTICS.has(result.code) && result.error.length <= 2_048 && !/\p{Cc}/u.test(result.error)) {
      throw new ConnectionError(result.code, result.error);
    }
    throw new Error(result.error);
  }
  return result;
}

export function createRemoteDeployment({ execSsh }) {
  async function run(action, host, onProgress, signal, authentication) {
    const input = await buildRemoteScript(action, host.instance);
    signal?.throwIfAborted();
    let remainder = '';
    const report = (line) => {
      if (!line.startsWith(PROGRESS)) return;
      let event;
      try { event = JSON.parse(line.slice(PROGRESS.length)); } catch { return; }
      if (typeof event.stage === 'string' && typeof event.message === 'string') onProgress?.(event);
    };
    const result = await execSsh(host, {
      command: 'sh -s',
      input,
      signal,
      timeoutMs: 600_000,
      authentication,
      onStderr(chunk) {
        const lines = (remainder + chunk).split(/\r?\n/);
        remainder = lines.pop();
        for (const line of lines) report(line);
      },
    });
    report(remainder);
    return parseResult(result.stdout);
  }

  return {
    async deploy(host, onProgress, signal, authentication) {
      const value = await run('deploy', host, onProgress, signal, authentication);
      if (!UUID.test(value?.hostId) || !UUID.test(value?.instanceId) || !UUID.test(value?.bootId)
        || value.version !== DSH_VERSION
        || !Number.isInteger(value.remotePort) || value.remotePort < 1 || value.remotePort > 65535
        || typeof value.token !== 'string' || !/^[\w-]{43}$/.test(value.token)
        || typeof value.nodePath !== 'string' || !value.nodePath.startsWith('/') || /[\r\n\0]/.test(value.nodePath)
        || typeof value.nodeVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.nodeVersion)) {
        throw new Error('Remote deployment returned an invalid Host identity');
      }
      const { hostId, instanceId, bootId, remotePort, token, version, nodePath, nodeVersion } = value;
      return { hostId, instanceId, bootId, remotePort, token, version, nodePath, nodeVersion };
    },
    async stop(host, onProgress, signal) {
      const value = await run('stop', host, onProgress, signal);
      if (typeof value?.stopped !== 'boolean') throw new Error('Remote deployment returned an invalid stop result');
      return { stopped: value.stopped };
    },
  };
}
