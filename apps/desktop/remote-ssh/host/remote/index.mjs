import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ConnectionError } from '../connection/ssh.mjs';
import { isRuntimeUpgrade } from '../parallel/contract.mjs';

export const DSH_VERSION = '0.2.2-rc.1';
export const REMOTE_API_PREFIX = '/api/dsh-remote-ssh';

const RESULT = 'DSH_REMOTE_SSH_RESULT ';
const PROGRESS = 'DSH_REMOTE_SSH_PROGRESS ';
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLIC_DIAGNOSTICS = new Set([
  'REMOTE_LINUX_REQUIRED', 'REMOTE_LOGIN_PROBE_FAILED', 'REMOTE_NODE_REQUIRED', 'REMOTE_NODE_CHANGED',
  'PARALLEL_IDENTITY_MISMATCH', 'SSH_RESTORE_PROBE_FAILED',
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

export async function buildRemoteScript(action, instance = 'default', expected, upgradeFrom) {
  if (!['deploy', 'stop'].includes(action)) throw new TypeError('Unknown remote runtime action');
  if (typeof instance !== 'string' || !INSTANCE_NAME.test(instance)) {
    throw new TypeError('Remote instance must be 1–64 letters, digits, dots, dashes or underscores and start with a letter or digit');
  }
  if (expected !== undefined && (!UUID.test(expected?.hostId) || !UUID.test(expected?.instanceId))) {
    throw new TypeError('Invalid expected remote Harness identity');
  }
  if (upgradeFrom !== undefined && (action !== 'deploy' || expected === undefined || typeof upgradeFrom !== 'string' || !UUID.test(upgradeFrom))) {
    throw new TypeError('A remote upgrade requires an expected instance and boot identity');
  }
  const [nodeBootstrap, bootstrap, ...assets] = await Promise.all([
    readFile(new URL('./node-bootstrap.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../remote/bootstrap.mjs', import.meta.url), 'utf8'),
    ...Object.values(sources).map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
  ]);
  const files = Object.fromEntries(Object.keys(sources).map((name, index) => [name, assets[index]]));
  const bundle = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const input = JSON.stringify({ action, instance, version: DSH_VERSION, bundle, files, expected, upgradeFrom });
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

/** Build the read-only probe for existing remote workspaces. */
export async function buildRestoreProbeScript(instance) {
  if (typeof instance !== 'string' || !INSTANCE_NAME.test(instance)) throw new TypeError('Invalid SSH instance name');
  const [nodeBootstrap, probe] = await Promise.all([
    readFile(new URL('./node-bootstrap.sh', import.meta.url), 'utf8'),
    readFile(new URL('./restore-probe.mjs', import.meta.url), 'utf8'),
  ]);
  return `#!/bin/sh
set -eu
if [ ! -d "$HOME/.dsh-remote-ssh/instances/${instance}" ]; then
  printf '%s\\n' 'DSH_REMOTE_SSH_RESULT {"expected":null}'
  exit 0
fi
runtime_action=restore
${nodeBootstrap.replaceAll('\r\n', '\n')}
"$remote_node" --input-type=module - <<'DSH_REMOTE_SSH_PROBE'
import { homedir } from 'node:os';
${probe.replaceAll('\r\n', '\n')}
try {
  const expected = await readRestoreIdentity(homedir(), ${JSON.stringify(instance)});
  console.log('DSH_REMOTE_SSH_RESULT ' + JSON.stringify({ expected }));
} catch (error) {
  console.log('DSH_REMOTE_SSH_RESULT {"code":"SSH_RESTORE_PROBE_FAILED","error":"无法读取远端已有项目，请手动连接。"}');
}
DSH_REMOTE_SSH_PROBE
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
    if (result.code === 'REMOTE_UPGRADE_REQUIRED' && isRuntimeUpgrade(result.upgrade)) {
      const { hostId, instanceId, bootId, version } = result.upgrade;
      const error = new ConnectionError(result.code, `远程实例正在运行 Harness ${version}。确认重启后可升级到 ${DSH_VERSION}。`);
      throw Object.assign(error, { upgrade: { hostId, instanceId, bootId, version } });
    }
    if (PUBLIC_DIAGNOSTICS.has(result.code) && result.error.length <= 2_048 && !/\p{Cc}/u.test(result.error)) {
      throw new ConnectionError(result.code, result.error);
    }
    throw new Error(result.error);
  }
  return result;
}

export function createRemoteDeployment({ execSsh }) {
  async function run(action, host, onProgress, signal, authentication, expected, upgradeFrom) {
    const input = await buildRemoteScript(action, host.instance, expected, upgradeFrom);
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
    async probe(host, signal, authentication) {
      const input = await buildRestoreProbeScript(host.instance);
      signal?.throwIfAborted();
      const { stdout } = await execSsh(host, { input, signal, timeoutMs: 45_000, authentication });
      const { expected } = parseResult(stdout);
      if (expected === null) return null;
      if (!UUID.test(expected?.hostId) || !UUID.test(expected?.instanceId)) {
        throw new ConnectionError('SSH_RESTORE_PROBE_FAILED', '远端恢复记录无效，请手动连接。');
      }
      return { hostId: expected.hostId, instanceId: expected.instanceId };
    },
    async deploy(host, onProgress, signal, authentication, expected, upgradeFrom) {
      const value = await run('deploy', host, onProgress, signal, authentication, expected, upgradeFrom);
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
