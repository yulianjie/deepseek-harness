import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync } from 'node:fs';
import { access, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const bundle = dirname(script);
const [action, root, instance, version, argument] = process.argv.slice(2);
const nodeRuntime = action === 'deploy' && {
  nodePath: argument, nodeVersion: process.versions.node,
  pathDigest: createHash('sha256').update(process.env.PATH ?? '').digest('hex'),
};
const result = (value) => console.log(`DSH_REMOTE_SSH_RESULT ${JSON.stringify(value)}`);
const progress = (stage, message) => console.error(`DSH_REMOTE_SSH_PROGRESS ${JSON.stringify({ stage, message })}`);
const api = '/api/dsh-remote-ssh/instance';
const activePath = instance && join(instance, 'active.json');
const leasePath = instance && join(instance, 'lifetime.lock');

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function writeJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error(`Remote runtime directory must be owned by the SSH user and private: ${path}`);
  }
  return path;
}

// Linux PID numbers can be recycled. The start ticks and boot id survive PID
// reuse and reboot checks without relying on the display name of a process.
async function processStamp(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] !== 'Z' && fields[19]) {
      const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      return `${boot}:${fields[19]}`;
    }
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
  }
}

async function alive(pid, stamp) {
  return typeof stamp === 'string' && await processStamp(pid) === stamp;
}

async function signalProcess(pid, stamp, signal) {
  if (!await alive(pid, stamp)) return false;
  try { process.kill(pid, signal); return true; }
  catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
}

function status(child) {
  return new Promise((done, failed) => {
    child.once('error', failed);
    child.once('close', done);
  });
}

async function lockHeld() {
  const probe = spawn('flock', ['--nonblock', '--conflict-exit-code', '75', '--close', leasePath,
    process.execPath, '-e', ''], { stdio: 'ignore' });
  const code = await status(probe);
  if (code === 0) return false;
  if (code === 75) return true;
  throw new Error('Unable to check the remote instance lifetime lock');
}

async function running() {
  const active = await readJson(activePath);
  if (active && !/^run-[A-Za-z0-9]{6}$/.test(active.run)) throw new Error('Remote instance state is invalid');
  const supervisor = await alive(active?.pid, active?.stamp);
  const child = await alive(active?.childPid, active?.childStamp);
  return { active, supervisor, child, locked: supervisor || await lockHeld() };
}

async function hostIdentity() {
  // A host identity file is shared by instances, which each have separate deploy locks.
  const path = join(root, 'host-id');
  try {
    await access(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, randomUUID(), { mode: 0o600, flag: 'wx' });
      await link(temp, path).catch((cause) => { if (cause.code !== 'EEXIST') throw cause; });
    } finally { await rm(temp, { force: true }); }
  }
  const value = (await readFile(path, 'utf8')).trim();
  if (/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(value)) return value;
  throw new Error('The persistent remote Host identity is invalid');
}

async function identity() {
  const path = join(instance, 'identity.json');
  const existing = await readJson(path);
  const hostId = await hostIdentity();
  if (existing?.hostId === hostId && /^[\da-f-]{36}$/.test(existing.instanceId)) return existing;
  if (existing) throw new Error('The persistent remote instance identity is invalid');
  const value = { hostId, instanceId: randomUUID() };
  await writeJson(path, value);
  return value;
}

function runtimeEnv(home, agents, runFile) {
  const { DSH_SNAPSHOT, DSH_REMOTE_SSH_RUN_FILE, ...environment } = process.env;
  return { ...environment, DSH_HOME: home, DSH_AGENTS_HOME: agents,
    ...(runFile ? { DSH_REMOTE_SSH_RUN_FILE: runFile } : {}) };
}

async function compatibleBin(path) {
  try {
    const real = await realpath(path);
    const pkg = await readJson(join(dirname(real), '..', 'package.json'));
    if (pkg?.name === '@deepseek-ai/dsh' && pkg.version === version && basename(real) === 'bin.js') return real;
  } catch (error) {
    if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
  }
}

async function binFromPath() {
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (!directory.startsWith('/')) continue;
    const path = join(directory, 'dsh');
    try { await access(path, constants.X_OK); }
    catch (error) { if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) continue; throw error; }
    const bin = await compatibleBin(path);
    if (bin) return bin;
  }
}

async function probeCli(bin, workDir) {
  if (!bin) return false;
  const probe = await mkdtemp(join(workDir, 'probe-'));
  try {
    // These probes can create a Web profile. Keep it out of the user's home and
    // out of the real instance so a broken existing package cannot pollute it.
    async function run(args) {
      const cli = spawn(process.execPath, [script, 'cli', bin, ...args], {
        cwd: probe, env: runtimeEnv(join(probe, 'dsh'), join(probe, 'agents')),
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 25_000, killSignal: 'SIGKILL',
      });
      let output = '';
      cli.stdout.on('data', (chunk) => { if (output.length < 64_000) output += chunk; });
      return await status(cli) === 0 ? output.trim() : '';
    }
    if (await run(['--version']) !== version) return false;
    const help = await run(['--profile', 'web', '--help']);
    return help.includes('--no-open') && help.includes('--trusted-host');
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

async function ensureCli(tryPath = true) {
  const workDir = await privateDirectory(join(instance, 'work'));
  const existing = tryPath ? await binFromPath() : undefined;
  if (await probeCli(existing, workDir)) {
    progress('probe', `Using the compatible official dsh ${version} already on PATH`);
    return { bin: existing, fromPath: true };
  }
  const installs = await privateDirectory(join(root, 'versions'));
  const installed = join(installs, version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!await compatibleBin(installed)) {
    const npmProbe = spawn('npm', ['--version'], { stdio: 'ignore' });
    if (await status(npmProbe).catch((error) => { if (error.code !== 'ENOENT') throw error; }) !== 0) {
      throw new Error('Remote npm is required when the compatible dsh Web CLI is absent.');
    }
    progress('install', `Installing official dsh ${version} in a private remote npm prefix`);
    const npm = spawn('flock', ['--exclusive', '--wait', '300', '--conflict-exit-code', '75', '--close',
      join(installs, `${version}.lock`), process.execPath, script, 'install', root, instance, version],
    { stdio: ['ignore', 'ignore', 'inherit'] });
    const code = await status(npm);
    if (code === 75) throw new Error('Timed out waiting for the private remote dsh installation lock');
    if (code !== 0) throw new Error(`Unable to install dsh ${version}. Check ${join(installs, `${version}.npm.log`)}`);
  }
  const bin = await compatibleBin(installed);
  if (!await probeCli(bin, workDir)) throw new Error(`Private dsh ${version} did not pass its Web CLI probe`);
  return { bin, fromPath: false };
}

async function install() {
  const parent = join(root, 'versions');
  const target = join(parent, version);
  if (await compatibleBin(join(target, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) return;
  const stage = await mkdtemp(join(parent, '.install-'));
  const log = openSync(join(parent, `${version}.npm.log`), 'a', 0o600);
  try {
    const npm = spawn('npm', ['install', '--prefix', stage, '--cache', join(root, 'npm-cache'),
      '--no-audit', '--no-fund', '--no-update-notifier', '--legacy-peer-deps=false',
      '--include=optional', '--include=peer', `@deepseek-ai/dsh@${version}`], {
      cwd: stage, stdio: ['ignore', log, log], timeout: 240_000, killSignal: 'SIGKILL',
    });
    if (await status(npm) !== 0) throw new Error('Private npm install failed');
    if (!await compatibleBin(join(stage, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
      throw new Error('Private npm installation did not contain the requested version');
    }
    await rename(stage, target);
  } catch (error) {
    if (error.code === 'ENOENT' && error.syscall === 'spawn npm') {
      console.error('Remote npm is required when the compatible dsh Web CLI is absent.');
    } else console.error(error.message);
    throw error;
  } finally {
    closeSync(log);
    await rm(stage, { recursive: true, force: true });
  }
}

async function endpoint(state, expected) {
  const runDir = join(instance, 'runs', state.active.run);
  const launch = await readJson(join(runDir, 'run.json'));
  const value = await readJson(join(runDir, 'endpoint.json'));
  if (!launch || !value || value.hostId !== expected.hostId || value.instanceId !== expected.instanceId
    || value.bootId !== launch.bootId || value.version !== version || value.pid !== state.active.childPid
    || !Number.isInteger(value.remotePort) || value.remotePort < 1 || value.remotePort > 65535
    || typeof value.token !== 'string' || !/^[\w-]{43}$/.test(value.token)) return;
  const origin = `http://127.0.0.1:${value.remotePort}`;
  try {
    const login = await fetch(`${origin}/?token=${value.token}`, { redirect: 'manual', signal: AbortSignal.timeout(1_500) });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    await login.body?.cancel();
    if (login.status !== 303 || !cookie) return;
    const response = await fetch(origin + api, { headers: { cookie }, signal: AbortSignal.timeout(1_500) });
    if (!response.ok) { await response.body?.cancel(); return; }
    const observed = await response.json();
    if (observed.hostId !== expected.hostId || observed.instanceId !== expected.instanceId
      || observed.bootId !== value.bootId || observed.version !== version || observed.protocolVersion !== 1) return;
  } catch { return; /* The new listener can still be starting. */ }
  const { nodePath, nodeVersion, pathDigest } = nodeRuntime;
  if (launch.nodeRuntime?.nodePath !== nodePath || launch.nodeRuntime.nodeVersion !== nodeVersion
    || launch.nodeRuntime.pathDigest !== pathDigest) {
    const error = new Error('The running remote Host cannot be reused with the current SSH login Node.js and PATH. Stop the instance explicitly before restarting it.');
    error.code = 'REMOTE_NODE_CHANGED';
    throw error;
  }
  const { hostId, instanceId, bootId, remotePort, token } = value;
  return { hostId, instanceId, bootId, remotePort, token, version, nodePath, nodeVersion };
}

async function waitForHost(expected, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await running();
    if (state.child) {
      const value = await endpoint(state, expected);
      if (value) return value;
    }
    if (!state.locked && !state.child) return;
    await delay(350);
  }
}

async function launchSupervisor(bin, expected) {
  const runs = await privateDirectory(join(instance, 'runs'));
  const runDir = await mkdtemp(join(runs, 'run-'));
  const run = { ...expected, version, bootId: randomUUID(), bin, nodeRuntime, runtimeRoot: root };
  await writeJson(join(runDir, 'run.json'), run);
  const log = openSync(join(runDir, 'host.log'), 'a', 0o600);
  try {
    const child = spawn('flock', ['--exclusive', '--wait', '2', '--no-fork', leasePath,
      process.execPath, script, 'supervise', root, instance, version, runDir], {
      detached: true, stdio: ['ignore', log, log],
    });
    await new Promise((done, failed) => { child.once('spawn', done); child.once('error', failed); });
    child.unref();
  } finally {
    closeSync(log);
  }
  // Spawn has reached flock, but its exec into the supervisor may not have run yet.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await running()).locked) return runDir;
    await delay(40);
  }
  throw new Error(`Remote dsh supervisor could not acquire its instance lock. Check ${join(runDir, 'host.log')}`);
}

async function deploy() {
  progress('probe', `Using SSH login Node.js v${nodeRuntime.nodeVersion} (${nodeRuntime.nodePath})`);
  const expected = await identity();
  const current = await running();
  if (current.locked || current.child) {
    const value = await waitForHost(expected, 25_000);
    if (value) {
      progress('reuse', 'Reusing the authenticated remote dsh Host');
      return value;
    }
    const again = await running();
    if (again.locked || again.child) throw new Error('The existing remote Host failed identity or health verification. Stop the instance explicitly before restarting it.');
  }
  const { bin, fromPath } = await ensureCli();
  progress('start', 'Starting a detached official dsh Web Host');
  let runDir = await launchSupervisor(bin, expected);
  let value = await waitForHost(expected, 90_000);
  if (!value && fromPath) {
    const failed = await running();
    if (!failed.locked && !failed.child) {
      progress('install', 'The dsh on PATH could not start a full Web Host. Trying the private installation.');
      const privateCli = await ensureCli(false);
      runDir = await launchSupervisor(privateCli.bin, expected);
      value = await waitForHost(expected, 90_000);
    }
  }
  if (!value) throw new Error(`Remote dsh Host did not become ready. Check ${join(runDir, 'host.log')}`);
  return value;
}

async function supervise() {
  process.umask(0o077);
  const runDir = argument;
  const runFile = join(runDir, 'run.json');
  const run = await readJson(runFile);
  const state = { run: basename(runDir), pid: process.pid, stamp: await processStamp(process.pid) };
  await writeJson(activePath, state);
  const home = await privateDirectory(join(instance, 'dsh-home'));
  const agents = await privateDirectory(join(instance, 'agents-home'));
  const work = await privateDirectory(join(instance, 'work'));
  const patch = join(runDir, 'companion.json');
  await writeJson(patch, [
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
    { insert: [{ id: 'dsh-remote-ssh-companion', name: pathToFileURL(join(bundle, 'companion.mjs')).href }] },
  ]);
  const child = spawn(process.execPath, [script, 'cli', run.bin, '--profile', 'web', '--patch', patch,
    '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: work, env: runtimeEnv(home, agents, runFile), stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const exit = status(child);
  // Install the rejection handler before filesystem work. Awaiting below still
  // propagates the error into the supervisor log.
  exit.catch(() => {});
  function terminate() {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
  }
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
  await writeJson(activePath, { ...state, childPid: child.pid, childStamp: await processStamp(child.pid) });
  const code = await exit;
  await rm(join(runDir, 'endpoint.json'), { force: true });
  if (code !== 0 && code !== null) console.error(`Official dsh Web Host exited with status ${code}`);
}

async function stop() {
  const state = await running();
  if (!state.locked && !state.child) return { stopped: false };
  progress('stop', 'Stopping the managed remote dsh Host');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const current = await running();
    if (!current.locked && !current.child) return { stopped: true };
    const active = current.active;
    if (current.supervisor) await signalProcess(active.pid, active.stamp, 'SIGTERM');
    else if (current.child) await signalProcess(active.childPid, active.childStamp, 'SIGTERM');
    // Send TERM only once after identifying the supervisor. Repeated signals
    // could interrupt the Host's own graceful shutdown handler.
    if (current.supervisor || current.child) break;
    await delay(100);
  }
  while (Date.now() < deadline) {
    const current = await running();
    if (!current.locked && !current.child) return { stopped: true };
    await delay(200);
  }
  throw new Error('Timed out stopping the remote dsh instance');
}

async function cli() {
  const bin = root;
  process.argv.splice(1, 3, bin);
  if (process.connected) process.once('disconnect', () => {
    process.kill(process.pid, 'SIGTERM');
    setTimeout(() => process.exit(1), 10_000).unref();
  });
  const { runCli } = await import(pathToFileURL(bin).href);
  await runCli();
}

try {
  if (action === 'deploy') result(await deploy());
  else if (action === 'stop') result(await stop());
  else if (action === 'install') await install();
  else if (action === 'supervise') await supervise();
  else if (action === 'cli') await cli();
  else throw new Error('Unknown remote runtime action');
} catch (error) {
  if (action === 'deploy' || action === 'stop') result({ error: error.message, code: error.code });
  else if (action === 'cli') process.stderr.write(`${error.message}\n`, () => process.exit(1));
  else { console.error(error.message); process.exitCode = 1; }
}
