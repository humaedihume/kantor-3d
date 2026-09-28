// Port Node dari src/Fallback.php — papan cadangan untuk project tanpa planning/:
// daftar tugas agent (TodoWrite/Task), commit git terbaru, file yang paling sering diubah. Tanpa data karangan.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { clip, cmpNum, isoC, phpTrim, redact, strcmp } from './util.mjs';

const LISTS_KEEP = 8;
const COMMITS_KEEP = 12;
const HOT_KEEP = 12;
const GIT_TIMEOUT_MS = 3000;

export async function buildFallback(projectDir, runs, mains) {
  const sources = [...runs.filter((r) => r.role !== 'orkestrator'), ...mains];
  return { todos: todos(sources), commits: await commits(projectDir), hot_files: hotFiles(sources) };
}

function todos(sources) {
  const lists = [];
  for (const r of sources) {
    if (!Array.isArray(r.todos) || !r.todos.length) continue;
    lists.push({ role: r.role, run: r.id, t: String(r.todosAt ?? ''), source: String(r.todoSource ?? ''), items: r.todos });
  }
  lists.sort((a, b) => strcmp(b.t, a.t));
  return lists.slice(0, LISTS_KEEP);
}

function hotFiles(sources) {
  const agg = new Map();
  for (const r of sources) {
    for (const [k, v] of Object.entries(r.fileCounts ?? {})) {
      const a = agg.get(k) ?? { path: k.slice(2), count: 0, last: '', roles: [] };
      a.count += v[0] | 0;
      if (strcmp(String(v[1]), a.last) > 0) a.last = String(v[1]);
      if (!a.roles.includes(r.role)) a.roles.push(r.role);
      agg.set(k, a);
    }
  }
  const list = [...agg.values()];
  list.sort((a, b) => cmpNum(b.count, a.count) || strcmp(b.last, a.last) || strcmp(a.path, b.path));
  return list.slice(0, HOT_KEEP);
}

// git log tanpa shell (execFile), batas waktu, env aman; turun dengan anggun bila git tidak ada
export function commits(projectDir) {
  const none = (why) => ({ available: false, reason: why, items: [] });
  let isRepo = false;
  try {
    isRepo = fs.existsSync(`${projectDir}/.git`);
  } catch {
    isRepo = false;
  }
  if (!isRepo) return Promise.resolve(none('bukan repo git'));
  const args = ['-C', projectDir, '--no-pager', 'log', '-n', String(COMMITS_KEEP), '--no-color', '--pretty=format:%h%x1f%cI%x1f%s'];
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || '', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile('git', args, { cwd: projectDir, env, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1 << 20, encoding: 'utf8' }, (err, out) => {
        if (err) {
          if (err.code === 'ENOENT') return resolve(none('git tidak tersedia'));
          if (err.killed || err.signal) return resolve(none('git terlalu lama (batas waktu)'));
          if (err.code === 127) return resolve(none('git tidak tersedia'));
          return resolve(none('git log gagal (repo kosong atau tidak bisa dibaca)'));
        }
        const items = [];
        for (const line of String(out).split('\n')) {
          const c = line.split('\x1f');
          if (c.length < 3 || c[0] === '') continue;
          const ms = Date.parse(c[1]);
          items.push({ hash: c[0], t: Number.isNaN(ms) ? '' : isoC(Math.floor(ms / 1000)), subject: clip(redact(phpTrim(c[2])), 140) });
        }
        resolve({ available: true, reason: null, items });
      });
      child.stdin?.end();
    } catch {
      resolve(none('git tidak tersedia'));
    }
  });
}
