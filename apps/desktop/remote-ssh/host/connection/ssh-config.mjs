import { constants } from 'node:fs';
import { open, realpath, glob, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';

const MAX_FILES = 256;
const MAX_DEPTH = 8;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ALIASES = 1024;

export function isSshAlias(alias) {
  return typeof alias === 'string' && alias.length <= 255 &&
    (isIP(alias) !== 0 || /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(alias));
}

function readWords(line) {
  const words = [];
  let word = '';
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const character = line[i];
    if (character === '\\' && /[\s"'#\\]/.test(line[i + 1] ?? '')) {
      word += line[++i];
    } else if (quote) {
      if (character === quote) quote = '';
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '#') {
      break;
    } else if (/\s/.test(character)) {
      if (word) words.push(word);
      word = '';
    } else {
      word += character;
    }
  }
  if (word) words.push(word);
  return words;
}

async function readConfig(filename) {
  if (!(await stat(filename)).isFile()) return '';
  const file = await open(filename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return '';
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await file.close();
  }
}

function expandInclude(pattern, base, home) {
  if (pattern.startsWith('~/') || pattern.startsWith('~\\')) pattern = path.join(home, pattern.slice(2));
  // OpenSSH's glob(3) patterns are segment based. Do not recursively descend on **.
  const resolved = path.resolve(base, pattern).replaceAll(/\*{2,}/g, '*');
  return process.platform === 'win32' ? resolved.replaceAll('\\', '/') : resolved;
}

/** Enumerate literal Host entries only. OpenSSH evaluates Match, wildcards and precedence. */
export async function discoverSshAliases({ home = homedir(), configPath } = {}) {
  const userDir = path.join(home, '.ssh');
  const systemDir = process.platform === 'win32'
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'ssh')
    : '/etc/ssh';
  const seen = new Set();
  const aliases = new Map();
  let visits = 0;

  async function visit(filename, base, depth) {
    if (visits >= MAX_FILES || depth > MAX_DEPTH || aliases.size >= MAX_ALIASES) return;
    visits++;
    try {
      const canonical = await realpath(filename);
      if (seen.has(canonical)) return;
      seen.add(canonical);
      const contents = await readConfig(canonical);
      for (const line of contents.split(/\r?\n/)) {
        const match = /^\s*(host|include)(?:\s*=\s*|\s+)(.*)$/i.exec(line);
        if (!match) continue;
        const words = readWords(match[2]);
        if (match[1].toLowerCase() === 'host') {
          for (const alias of words) {
            if (!isSshAlias(alias)) continue;
            if (!aliases.has(alias.toLowerCase())) aliases.set(alias.toLowerCase(), { alias });
            if (aliases.size >= MAX_ALIASES) return;
          }
        } else if (depth < MAX_DEPTH) {
          for (const word of words) {
            if (visits >= MAX_FILES) break;
            const pattern = expandInclude(word, base, home);
            if (!/[*?\[]/.test(pattern)) {
              await visit(pattern, base, depth + 1);
              continue;
            }
            for await (const included of glob(pattern)) {
              await visit(included, base, depth + 1);
              if (visits >= MAX_FILES || aliases.size >= MAX_ALIASES) break;
            }
          }
        }
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'EISDIR'].includes(error.code)) throw error;
    }
  }

  if (configPath && configPath !== 'none') await visit(configPath, userDir, 0);
  if (!configPath) {
    await visit(path.join(userDir, 'config'), userDir, 0);
    await visit(path.join(systemDir, 'ssh_config'), systemDir, 0);
  }
  return [...aliases.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}
