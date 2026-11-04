import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { appendFile, link, lstat, mkdir, open, opendir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { catalogCapability, catalogPath, projectCatalog } from './project-catalog.mjs';

export const name = 'dsh-remote-ssh-companion';
export const inject = ['connection', 'webServer'];

const api = '/api/dsh-remote-ssh';
const maxFile = 2 * 1024 * 1024;
const maxRequest = maxFile * 6 + 8192;
const git = promisify(execFile);
const capabilities = ['files', 'directories', 'git', 'logs', catalogCapability];

class RequestError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

function isWithin(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function pathParts(path, allowEmpty = false) {
  if (allowEmpty && (path === undefined || path === '' || path === '.')) return [];
  if (typeof path !== 'string' || path.length > 4096 || isAbsolute(path) || /[\\\0]/.test(path)) {
    throw new RequestError(400, 'Expected a relative path within the selected root');
  }
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new RequestError(400, 'Expected a relative path within the selected root');
  }
  return parts;
}

function ensureAccessible(path, protectedRoot) {
  if (protectedRoot && isWithin(protectedRoot, path)) {
    throw new RequestError(403, 'The remote runtime directory is private');
  }
}

async function workspaceRoot(root, protectedRoot) {
  const requested = root || homedir();
  if (typeof requested !== 'string' || !isAbsolute(requested) || requested.length > 4096 || requested.includes('\0')) {
    throw new RequestError(400, 'Expected an absolute directory on the remote host');
  }
  const canonical = await realpath(requested);
  ensureAccessible(canonical, protectedRoot);
  return canonical;
}

// On Linux keep each parent pinned by its open directory descriptor while
// resolving its next component. A concurrent symlink swap then cannot redirect
// reads, temp files, or renames outside the directory we already verified.
async function anchoredDirectory(root, parts) {
  let path = root;
  if (process.platform === 'linux') {
    parts = [...root.split('/').filter(Boolean), ...parts];
    path = '/';
  }
  let handle;
  try {
    for (const part of ['', ...parts]) {
      const next = part ? join(path, part) : path;
      const info = await lstat(next);
      if (!info.isDirectory()) throw new RequestError(400, 'Expected a directory without symlink components');
      if (process.platform === 'linux') {
        const previous = handle;
        handle = await open(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await previous?.close();
        path = `/proc/${process.pid}/fd/${handle.fd}`;
      } else path = next;
    }
    return { path, close: () => handle?.close() };
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

async function snapshot(path) {
  let handle;
  try {
    if (!(await lstat(path)).isFile()) throw new RequestError(400, 'Expected a regular file without symlinks');
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) throw new RequestError(400, 'Expected a regular file');
    if (info.size > maxFile) throw new RequestError(413, 'The file exceeds the 2 MiB editor limit');
    const buffer = Buffer.allocUnsafe(maxFile + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maxFile) throw new RequestError(413, 'The file exceeds the 2 MiB editor limit');
    const bytes = buffer.subarray(0, size);
    return { bytes, version: createHash('sha256').update(bytes).digest('hex'), mode: info.mode & 0o777 };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    await handle?.close();
  }
}

function requireVersion(observed, expected) {
  if ((observed?.version ?? null) !== expected) {
    throw new RequestError(409, 'The remote file changed. Reload it before saving.', { version: observed?.version ?? null });
  }
}

async function saveFile(path, temp, bytes, expectedVersion) {
  const first = await snapshot(path);
  requireVersion(first, expectedVersion);
  const writer = await open(temp, 'wx', 0o600);
  try {
    try {
      await writer.writeFile(bytes);
      if (first) await writer.chmod(first.mode);
      await writer.sync();
    } finally {
      await writer.close();
    }
    const current = await snapshot(path);
    requireVersion(current, expectedVersion);
    if (first) await rename(temp, path);
    else {
      try { await link(temp, path); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        throw new RequestError(409, 'A remote file already exists at this path', { version: (await snapshot(path))?.version ?? null });
      }
    }
  } finally {
    await rm(temp, { force: true });
  }
  return createHash('sha256').update(bytes).digest('hex');
}

async function tail(path, limit = 64 * 1024) {
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, limit));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString('utf8', 0, bytesRead);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  } finally {
    await handle?.close();
  }
}

function describe(instance) {
  const { hostId, instanceId, bootId, version } = instance;
  return { hostId, instanceId, bootId, version, protocolVersion: 1, capabilities, home: homedir(), hostname: hostname() };
}

export function createHandlers(instance, runDir, getRegistry) {
  const operations = new Map();
  const auditPath = join(dirname(runDir), '..', 'operations.log');
  const protectedRoot = instance.runtimeRoot;
  function serialize(path, operation) {
    const task = (operations.get(path) ?? Promise.resolve()).catch(() => {}).then(operation);
    operations.set(path, task);
    return task.finally(() => { if (operations.get(path) === task) operations.delete(path); });
  }
  async function audit(action, root, path) {
    const record = JSON.stringify({ time: new Date().toISOString(), action, root, path });
    await appendFile(auditPath, `${record}\n`, { mode: 0o600 }).catch((error) => {
      console.error(`dsh-remote-ssh-companion: failed to append the operation log (${error.code})`);
    });
  }

  return {
    workspaces(input) {
      if (Object.keys(input).length) throw new RequestError(400, 'Expected an empty Workspace catalog request');
      const catalog = projectCatalog(getRegistry?.());
      if (!catalog) throw new RequestError(503, 'The Workspace catalog is temporarily unavailable');
      return catalog;
    },
    instance: () => describe(instance),
    async logs() {
      const [host, operations] = await Promise.all([tail(join(runDir, 'host.log')), tail(auditPath)]);
      const text = [host, operations].filter(Boolean).join('\n').replace(/([?&]token=)[^&\s]+/g, '$1[redacted]');
      return { text };
    },
    async readFile({ root, path }) {
      const canonical = await workspaceRoot(root, protectedRoot);
      const parts = pathParts(path);
      ensureAccessible(join(canonical, ...parts), protectedRoot);
      const dir = await anchoredDirectory(canonical, parts.slice(0, -1));
      try {
        const current = await snapshot(join(dir.path, parts.at(-1)));
        if (!current) throw new RequestError(404, 'Remote file does not exist');
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(current.bytes); }
        catch { throw new RequestError(415, 'The file is not UTF-8 text'); }
        if (content.includes('\0')) throw new RequestError(415, 'The file is not UTF-8 text');
        return { path, content, version: current.version };
      } finally { await dir.close(); }
    },
    async writeFile({ root, path, content, expectedVersion }) {
      if (expectedVersion !== null && (typeof expectedVersion !== 'string' || !/^[\da-f]{64}$/.test(expectedVersion))) {
        throw new RequestError(400, 'Send the last read version, or null when creating a file');
      }
      if (typeof content !== 'string' || content.includes('\0')) throw new RequestError(400, 'Expected UTF-8 text content');
      const bytes = Buffer.from(content, 'utf8');
      if (bytes.length > maxFile) throw new RequestError(413, 'The file exceeds the 2 MiB editor limit');
      const canonical = await workspaceRoot(root, protectedRoot);
      const parts = pathParts(path);
      const target = join(canonical, ...parts);
      ensureAccessible(target, protectedRoot);
      return serialize(target, async () => {
        const dir = await anchoredDirectory(canonical, parts.slice(0, -1));
        try {
          const version = await saveFile(join(dir.path, parts.at(-1)), join(dir.path, `.dsh-remote-ssh-${randomUUID()}.tmp`), bytes, expectedVersion);
          await audit(expectedVersion === null ? 'create-file' : 'save-file', canonical, path);
          return { path, version };
        } finally { await dir.close(); }
      });
    },
    async list({ root, path }) {
      const canonical = await workspaceRoot(root, protectedRoot);
      const parts = pathParts(path, true);
      const target = join(canonical, ...parts);
      ensureAccessible(target, protectedRoot);
      const dir = await anchoredDirectory(canonical, parts);
      try {
        const entries = [];
        for await (const entry of await opendir(dir.path)) {
          if (protectedRoot && isWithin(protectedRoot, join(target, entry.name))) continue;
          if (entries.length >= 5000) throw new RequestError(413, 'The directory exceeds the 5000 entry limit');
          const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other';
          entries.push({ name: entry.name, kind });
        }
        entries.sort((first, second) => first.name.localeCompare(second.name));
        return { path: parts.join('/'), entries };
      } finally { await dir.close(); }
    },
    async mkdir({ root, path }) {
      const canonical = await workspaceRoot(root, protectedRoot);
      const parts = pathParts(path);
      ensureAccessible(join(canonical, ...parts), protectedRoot);
      const dir = await anchoredDirectory(canonical, parts.slice(0, -1));
      try { await mkdir(join(dir.path, parts.at(-1))); }
      finally { await dir.close(); }
      await audit('create-directory', canonical, path);
      return { path };
    },
    async git({ root, kind, path, staged }) {
      const canonical = await workspaceRoot(root, protectedRoot);
      const parts = pathParts(path, true);
      ensureAccessible(join(canonical, ...parts), protectedRoot);
      if (!['status', 'diff'].includes(kind)) throw new RequestError(400, 'Expected Git status or diff');
      const dir = await anchoredDirectory(canonical, []);
      try {
        const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
        const options = {
          cwd: dir.path, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
          timeout: 15_000, maxBuffer: maxFile, windowsHide: true,
        };
        // Config reads never run filters. Use the same repository and config
        // environment for discovery and for the command that reads the worktree.
        const { stdout: config } = await git('git', [
          'config', '--includes', '-z', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$',
        ], { ...options, encoding: 'buffer' }).catch((error) => {
          if (error.code !== 1 || error.stdout?.length) throw error;
          return { stdout: Buffer.alloc(0) };
        });
        const names = new TextDecoder('utf-8', { fatal: true }).decode(config).split('\0').filter(Boolean);
        const overrides = [];
        for (const name of new Set(names)) {
          // Git's -c syntax splits at the first '='. A subsection containing
          // that character cannot be disabled by this command-line override.
          if (name.includes('=')) throw new Error('Unsupported Git filter name');
          overrides.push('-c', `${name}=${name.endsWith('.required') ? 'false' : ''}`);
        }
        const args = kind === 'status' ? ['status', '--porcelain=v1', '--branch']
          : ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--submodule=short', ...(staged === 'true' ? ['--cached'] : [])];
        // Keep submodule commit changes visible without inspecting their own
        // worktrees, whose filter configuration was not part of this scan.
        args.push('--ignore-submodules=dirty');
        if (parts.length) args.push('--', parts.join('/'));
        const { stdout } = await git('git', [
          '--no-pager', '-c', 'core.fsmonitor=false', '--literal-pathspecs', ...overrides, ...args,
        ], options);
        return { text: stdout };
      } catch (error) {
        if (error.code === 'ENOENT') throw new RequestError(501, 'Git is not installed on the remote host');
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new RequestError(413, 'Git output exceeds the 2 MiB limit');
        if (error.killed) throw new RequestError(504, 'The remote Git command timed out');
        throw new RequestError(422, 'Git could not inspect this directory as a repository');
      } finally { await dir.close(); }
    },
  };
}

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new RequestError(415, 'Expected an application/json request');
  }
  if (Number(req.headers['content-length']) > maxRequest) throw new RequestError(413, 'Request is too large');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.byteLength;
    if (bytes > maxRequest) throw new RequestError(413, 'Request is too large');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'Invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'Expected a JSON object');
  return body;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function responseError(error) {
  if (error instanceof RequestError) return error;
  if (error.code === 'ENOENT') return new RequestError(404, 'The remote path does not exist');
  if (error.code === 'EEXIST') return new RequestError(409, 'The remote path already exists');
  if (error.code === 'EACCES' || error.code === 'EPERM') return new RequestError(403, 'Remote filesystem permission denied');
  if (error.code === 'ELOOP' || error.code === 'ENOTDIR') return new RequestError(400, 'Expected a path without symlink components');
  console.error(`dsh-remote-ssh-companion: unexpected error (${error.code ?? error.name})`);
  return new RequestError(500, 'The remote operation failed');
}

export function registerRoutes(ctx, handlers, assets) {
  const routes = {
    [`${api}/instance`]: { GET: handlers.instance },
    [catalogPath]: { GET: handlers.workspaces },
    [`${api}/logs`]: { GET: handlers.logs },
    [`${api}/files`]: { GET: handlers.readFile, PUT: handlers.writeFile },
    [`${api}/directories`]: { GET: handlers.list, POST: handlers.mkdir },
    [`${api}/git`]: { GET: handlers.git },
  };
  for (const [path, asset] of Object.entries(assets)) routes[path] = { GET: () => asset };
  for (const [path, methods] of Object.entries(routes)) {
    async function handler(req, res) {
      const admission = ctx.connection.admit(req);
      if ('rejection' in admission || admission.peer.principal.kind !== 'owner') {
        const status = admission.rejection ?? 403;
        send(res, status, { error: status === 401 ? 'Unauthorized' : 'Forbidden' });
        return;
      }
      const method = req.method;
      if (!Object.hasOwn(methods, method)) {
        send(res, 405, { error: 'Method not allowed' }, { allow: Object.keys(methods).join(', ') });
        return;
      }
      try {
        const input = method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://dsh.invalid').searchParams) : await readBody(req);
        const value = await methods[method](input);
        if (Object.hasOwn(assets, path)) send(res, 200, value.body, {
          'content-type': value.type, 'content-security-policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'",
          'referrer-policy': 'no-referrer',
        });
        else send(res, 200, value);
      } catch (error) {
        const response = responseError(error);
        if (!res.destroyed) send(res, response.status, { error: response.message, ...response.fields },
          response.status === 413 ? { connection: 'close' } : {});
      }
    }
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }));
  }
}

export async function apply(ctx) {
  const runFile = process.env.DSH_REMOTE_SSH_RUN_FILE;
  if (!runFile) throw new Error('The Remote SSH companion requires the managed instance descriptor');
  const runDir = dirname(runFile);
  const instance = JSON.parse(await readFile(runFile, 'utf8'));
  const html = await readFile(new URL('./workspace.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('./workspace.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('./workspace.css', import.meta.url), 'utf8');
  const browserStorageScript = await readFile(new URL('./browser-storage.js', import.meta.url), 'utf8');
  registerRoutes(ctx, createHandlers(instance, runDir, () => ctx.get('workspaceRegistry')), {
    '/remote-ssh/workspace': { body: html, type: 'text/html; charset=utf-8' },
    '/remote-ssh/workspace.js': { body: js, type: 'text/javascript; charset=utf-8' },
    '/remote-ssh/workspace.css': { body: css, type: 'text/css; charset=utf-8' },
  });
  const hostLabel = hostname().replace(/[&<>"']/g, (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]);
  // Official index contributions give the full remote UI a visible execution
  // identity without replacing its stores, transport or rendering internals.
  ctx.on('webserver/index-inject', (rows) => {
    rows.unshift({ kind: 'script', placement: 'head', text: browserStorageScript });
    rows.push({ kind: 'style', text: '.dsh-remote-host-badge{position:fixed;top:7px;left:50%;transform:translateX(-50%);z-index:50;max-width:calc(100vw - 80px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 10px;border:1px solid #315b77;border-radius:20px;background:#142c3e;color:#c1e6ff;font:11px/1.4 system-ui,sans-serif;text-decoration:none}.dsh-remote-host-badge:focus-visible{outline:2px solid #82c7ff;outline-offset:2px}' });
    rows.push({ kind: 'html', placement: 'body', html: `<a class="dsh-remote-host-badge" href="/remote-ssh/workspace" title="所有开发操作在此远程 Host 执行；打开远程文件与 Git">SSH · ${hostLabel} · 远程工作区 ↗</a>` });
  });
  ctx.effect(() => {
    const controller = new AbortController();
    void publishEndpoint(ctx, instance, runDir, controller.signal).catch((error) => {
      if (!controller.signal.aborted) console.error(`dsh-remote-ssh-companion: ${error.message}`);
    });
    return () => controller.abort();
  });
}

async function publishEndpoint(ctx, instance, runDir, signal) {
  await ctx.get('loader')?.await();
  for (let attempt = 0; !ctx.webServer.port && attempt < 100; attempt += 1) {
    await delay(100, undefined, { signal });
  }
  signal.throwIfAborted();
  if (ctx.webServer.host !== '127.0.0.1' || ctx.webServer.protocol !== 'http:') {
    throw new Error('Managed Host must bind to plain HTTP on 127.0.0.1');
  }
  const launch = new URL(ctx.connection.authenticatedUrl(ctx.webServer.getOrigin()));
  const value = { ...describe(instance), pid: process.pid, remotePort: ctx.webServer.port, token: launch.searchParams.get('token') };
  const endpoint = join(runDir, 'endpoint.json');
  const temp = `${endpoint}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temp, endpoint);
  } finally { await rm(temp, { force: true }); }
}
