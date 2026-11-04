// The local builder prepends the input bundle before sending this script over SSH.
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error(`Remote runtime directory must be owned by the SSH user and private: ${path}`);
  }
  return path;
}

async function stageBundle(parent) {
  const target = join(parent, input.bundle);
  if (await lstat(target).catch((error) => { if (error.code !== 'ENOENT') throw error; })) {
    return privateDirectory(target);
  }
  const stage = await mkdtemp(join(parent, '.stage-'));
  try {
    for (const [name, body] of Object.entries(input.files)) {
      await writeFile(join(stage, name), body, { mode: 0o600, flag: 'wx' });
    }
    await rename(stage, target).catch((error) => {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return privateDirectory(target);
}

try {
  const home = await realpath(homedir());
  const root = await privateDirectory(join(home, '.dsh-remote-ssh'));
  const bundles = await privateDirectory(join(root, 'bundles'));
  const instances = await privateDirectory(join(root, 'instances'));
  const instance = await privateDirectory(join(instances, input.instance));
  const bundle = await stageBundle(bundles);
  // The outer flock process owns this lock. --close prevents its inheritance by
  // the detached supervisor and leaves the lock available to later SSH sessions.
  const worker = spawn('flock', ['--exclusive', '--wait', '180', '--conflict-exit-code', '75', '--close',
    join(instance, 'deploy.lock'), process.execPath, join(bundle, 'runtime.mjs'),
    input.action, root, instance, input.version, process.argv[2]], { stdio: ['ignore', 'inherit', 'inherit'] });
  const code = await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', resolve);
  });
  if (code === 75) throw new Error('Another SSH operation is still deploying or stopping this remote instance');
  if (code !== 0) throw new Error('Remote deployment worker exited unexpectedly');
} catch (error) {
  const message = error.code === 'ENOENT' && error.syscall === 'spawn flock'
    ? 'Remote SSH runtime requires util-linux flock on the SSH login terminal PATH.' : error.message;
  console.log(`DSH_REMOTE_SSH_RESULT ${JSON.stringify({ error: message })}`);
}
