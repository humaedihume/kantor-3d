// Port Node dari src/Transcripts.php — ringkasan transkrip Claude Code (JSONL) secara inkremental.
// Hanya ringkasan tool_use + potongan teks assistant yang keluar; isi tool_result tidak pernah dibaca.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  basename, clip, firstLine, globDir, isDir, isFile, isObj, isPlainObj, mbLen, mtimeSec, nowSec, phpLtrim, phpTrim,
  readText, redact, splitR, strcmp, values,
} from './util.mjs';

const EVENTS_KEEP = 80;
const RUNNING_WINDOW = 900;
const CACHE_V = 5;
const FILES_KEEP = 40;
const FILE_COUNTS_KEEP = 300;
const TODOS_KEEP = 40;
const MAINS_KEEP = 5;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function transcriptRoot(projectDir) {
  let base = process.env.CLAUDE_CONFIG_DIR || '';
  if (base === '') {
    let home = process.env.HOME || '';
    if (home === '') {
      try {
        home = os.userInfo().homedir || '';
      } catch {
        home = '';
      }
    }
    base = `${home.replace(/\/+$/, '')}/.claude`;
  }
  return `${base.replace(/\/+$/, '')}/projects/${projectDir.replace(/[^a-zA-Z0-9]/g, '-')}`;
}

export class Transcripts {
  constructor(projectDir, kerjaDir, resolver, windowDays = 7) {
    this.projectDir = projectDir;
    this.kerjaDir = kerjaDir;
    this.resolver = resolver;
    this.windowDays = windowDays;
  }

  scan() {
    const root = transcriptRoot(this.projectDir);
    if (!isDir(root)) return { runs: [], mains: [] };
    const runs = [];
    const cutoff = nowSec() - this.windowDays * 86400;
    const mainFiles = globDir(root, '.jsonl').map((f) => [f, mtimeSec(f)]);
    mainFiles.sort((a, b) => b[1] - a[1]);
    const metas = [];
    for (const d of globDir(root, '')) {
      for (const m of globDir(path.join(d, 'subagents'), '.meta.json')) metas.push(m);
    }
    metas.sort((a, b) => strcmp(a, b));
    for (const metaFile of metas) {
      const jsonl = `${metaFile.slice(0, -'.meta.json'.length)}.jsonl`;
      if (!isFile(jsonl) || mtimeSec(jsonl) < cutoff) continue;
      let meta;
      try {
        meta = JSON.parse(readText(metaFile) ?? '');
      } catch {
        meta = null;
      }
      meta = isObj(meta) ? meta : {};
      const [role, desc] = this.resolver(typeof meta.agentType === 'string' ? meta.agentType : '', typeof meta.description === 'string' ? meta.description : '');
      if (role === null) continue;
      const sum = this.summarize(jsonl);
      sum.role = role;
      sum.description = desc;
      sum.id = basename(jsonl, '.jsonl').slice(6, 14);
      runs.push(sum);
    }
    const mains = [];
    for (const [i, [file, mt]] of mainFiles.slice(0, MAINS_KEEP).entries()) {
      if (i > 0 && mt < cutoff) break;
      const sum = this.summarize(file);
      sum.role = 'orkestrator';
      sum.description = 'Sesi utama — mengatur alur tim';
      sum.id = i === 0 ? 'main' : `main-${basename(file, '.jsonl').slice(0, 8)}`;
      mains.push(sum);
    }
    if (mains.length) runs.push({ ...mains[0] });
    const stopped = new Set();
    const sf = path.join(this.kerjaDir, 'storage', 'stopped.txt');
    if (isFile(sf)) {
      for (const line of splitR(readText(sf) ?? '')) {
        const m = /^[ \t\n\x0b\f\r]*(a[0-9a-f]{7,})/.exec(line);
        if (m) stopped.add(m[1].slice(0, 8));
      }
    }
    for (const r of runs) {
      r.status = statusOf(r);
      if (r.status === 'bekerja' && stopped.has(r.id)) r.status = 'terhenti';
    }
    runs.sort((a, b) => strcmp(b.updated ?? '', a.updated ?? ''));
    return { runs, mains };
  }

  summarize(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      st = { size: 0, mtimeMs: 0 };
    }
    const size = st.size;
    const mtime = Math.floor(st.mtimeMs / 1000);
    const cacheFile = path.join(this.kerjaDir, 'storage', 'cache', `n-${crypto.createHash('md5').update(file).digest('hex')}.json`);
    let s = null;
    if (isFile(cacheFile)) {
      try {
        s = JSON.parse(readText(cacheFile) ?? '');
      } catch {
        s = null;
      }
    }
    if (!isPlainObj(s) || s.v !== CACHE_V || !(s.offset >= 0) || s.offset > size) {
      s = {
        v: CACHE_V, offset: 0, started: null, updated: null, tools: 0, tokens: { in: 0, out: 0, cache: 0 }, lastMsgId: null,
        events: [], lastKind: null, final: null, prompt: null, limit: null, files: [], fileCounts: {}, todos: null, todosAt: null,
        todoSource: null, tasks: {}, taskSeq: 0,
      };
    }
    if (s.offset < size) {
      let fd = null;
      try {
        fd = fs.openSync(file, 'r');
        let pos = s.offset;
        let carry = Buffer.alloc(0);
        const buf = Buffer.alloc(1 << 20);
        let read;
        let readAt = pos;
        while ((read = fs.readSync(fd, buf, 0, buf.length, readAt)) > 0) {
          readAt += read;
          let chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, read)]) : Buffer.from(buf.subarray(0, read));
          let start = 0;
          let nl;
          while ((nl = chunk.indexOf(10, start)) !== -1) {
            const lineBuf = chunk.subarray(start, nl + 1);
            pos += lineBuf.length;
            start = nl + 1;
            let row = null;
            try {
              row = JSON.parse(utf8.decode(lineBuf));
            } catch {
              row = null;
            }
            if (isPlainObj(row)) this.consume(s, row);
          }
          carry = chunk.subarray(start);
          chunk = null;
        }
        s.offset = pos; // baris terakhir tanpa \n belum lengkap — dibaca lagi nanti
      } catch {
        /* file hilang/terkunci: pakai ringkasan yang ada */
      } finally {
        if (fd !== null) fs.closeSync(fd);
      }
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(s));
      } catch {
        /* cache opsional */
      }
    }
    const out = { ...s, mtime };
    delete out.lastMsgId;
    delete out.offset;
    delete out.v;
    delete out.tasks;
    delete out.taskSeq;
    return out;
  }

  consume(s, row) {
    const type = row.type ?? '';
    const t = typeof row.timestamp === 'string' ? row.timestamp : '';
    if (t !== '') {
      if (s.started === null) s.started = t;
      s.updated = t;
    }
    const msg = row.message;
    if (!isObj(msg)) return;
    if (type === 'user') {
      const content = msg.content ?? '';
      if (typeof content === 'string') {
        if (s.prompt === null && !phpLtrim(content).startsWith('<')) s.prompt = clip(redact(content), 400);
        if (empty(row.isMeta) && !phpLtrim(content).startsWith('<') && s.prompt !== null && (row.isSidechain ?? false) === false) {
          this.push(s, t, 'user', 'Instruksi dari user', null);
        }
        s.lastKind = 'user';
      } else if (isObj(content) && s.lastKind !== 'handback') {
        s.lastKind = 'result';
      }
      return;
    }
    if (type !== 'assistant') return;
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (id !== '' && id !== s.lastMsgId && isObj(msg.usage)) {
      const u = msg.usage;
      s.tokens.in += int(u.input_tokens);
      s.tokens.out += int(u.output_tokens);
      s.tokens.cache += int(u.cache_read_input_tokens) + int(u.cache_creation_input_tokens);
      s.lastMsgId = id;
    }
    let hasTool = false;
    let hasText = false;
    let handback = false;
    for (const b of isObj(msg.content) ? values(msg.content) : []) {
      if (!isObj(b)) continue;
      const bt = b.type ?? '';
      if (bt === 'tool_use') {
        hasTool = true;
        const name = typeof b.name === 'string' ? b.name : '?';
        const inp = isObj(b.input) ? b.input : {};
        s.tools++;
        const [text, p] = this.describeTool(name, inp);
        if (p !== null && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
          s.files = s.files.filter((f) => f[0] !== p);
          s.files.push([p, t]);
          if (s.files.length > FILES_KEEP) s.files.shift();
          const fk = `p:${p}`;
          if (fk in s.fileCounts || Object.keys(s.fileCounts).length < FILE_COUNTS_KEEP) {
            s.fileCounts[fk] = [((s.fileCounts[fk] || [0])[0] | 0) + 1, t];
          }
        }
        this.todo(s, name, inp, t);
        if (name === 'SubagentHandback') {
          handback = true;
          if (typeof inp.message === 'string' && phpTrim(inp.message) !== '') s.final = clip(redact(phpTrim(inp.message)), 1200);
        }
        this.push(s, t, 'tool', text, name);
      } else if (bt === 'text') {
        const txt = typeof b.text === 'string' ? phpTrim(b.text) : '';
        if (txt === '') continue;
        hasText = true;
        if (/(usage limit|rate limit|limit reached|resets? (at|in))/i.test(txt) && mbLen(txt) < 400) s.limit = clip(txt, 200);
        s.final = clip(redact(txt), 1200);
        this.push(s, t, 'text', clip(redact(firstLine(redact(txt))), 180), null);
      }
    }
    const stop = typeof msg.stop_reason === 'string' ? msg.stop_reason : '';
    if (handback) s.lastKind = 'handback';
    else if (hasTool) s.lastKind = 'tool';
    else if (hasText) s.lastKind = stop === 'end_turn' ? 'final' : 'text';
    else if (s.lastKind === null) s.lastKind = 'thinking';
    if (hasTool) s.limit = null;
  }

  todo(s, name, inp, t) {
    if (name === 'TodoWrite' && isObj(inp.todos)) {
      const items = [];
      for (const td of values(inp.todos)) {
        if (!isObj(td)) continue;
        const text = typeof td.content === 'string' ? td.content : typeof td.subject === 'string' ? td.subject : '';
        if (phpTrim(text) === '') continue;
        items.push({ text: clip(redact(firstLine(redact(text))), 120), status: todoStatus(td.status) });
        if (items.length >= TODOS_KEEP) break;
      }
      s.todos = items;
      s.todosAt = t;
      s.todoSource = 'TodoWrite';
      return;
    }
    if (name === 'TaskCreate') {
      const subject = typeof inp.subject === 'string' ? inp.subject : typeof inp.description === 'string' ? inp.description : '';
      s.taskSeq++;
      if (phpTrim(subject) === '') return;
      s.tasks[`#${s.taskSeq}`] = { text: clip(redact(firstLine(redact(subject))), 120), status: 'pending' };
      const keys = Object.keys(s.tasks);
      if (keys.length > TODOS_KEEP) delete s.tasks[keys[0]];
    } else if (name === 'TaskUpdate') {
      let tid = inp.taskId ?? inp.id ?? null;
      tid = typeof tid === 'string' || Number.isInteger(tid) ? `#${tid}` : '';
      if (!(tid in s.tasks)) return;
      if (inp.status === 'deleted') delete s.tasks[tid];
      else {
        if (typeof inp.status === 'string') s.tasks[tid].status = todoStatus(inp.status);
        if (typeof inp.subject === 'string' && phpTrim(inp.subject) !== '') s.tasks[tid].text = clip(redact(firstLine(redact(inp.subject))), 120);
      }
    } else return;
    s.todos = Object.values(s.tasks);
    s.todosAt = t;
    s.todoSource = 'Task';
  }

  push(s, t, kind, text, tool) {
    s.events.push({ t, kind, text, tool });
    if (s.events.length > EVENTS_KEEP) s.events.splice(0, s.events.length - EVENTS_KEEP);
  }

  describeTool(name, inp) {
    const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
    let p = null;
    for (const k of ['file_path', 'notebook_path']) {
      if (typeof inp[k] === 'string' && inp[k] !== '') {
        const v = inp[k];
        p = v.startsWith(`${this.projectDir}/`) ? v.slice(this.projectDir.length + 1) : basename(v);
        break;
      }
    }
    let text;
    switch (name) {
      case 'Read': text = `Membaca ${p ?? ''}`; break;
      case 'Write': text = `Menulis ${p ?? ''}`; break;
      case 'Edit': case 'MultiEdit': case 'NotebookEdit': text = `Mengubah ${p ?? ''}`; break;
      case 'Bash': text = `Menjalankan: ${str(inp.description) !== '' ? str(inp.description) : `${firstToken(str(inp.command))} …`}`; break;
      case 'Grep': text = `Mencari '${clip(str(inp.pattern), 50)}'`; break;
      case 'Glob': text = `Mencari file ${clip(str(inp.pattern), 60)}`; break;
      case 'Agent': case 'Task': text = `Mendelegasikan: ${str(inp.description) !== '' ? str(inp.description) : 'subagent'}`; break;
      case 'SendMessage': text = 'Mengirim pesan ke agent'; break;
      case 'AskUserQuestion': text = 'Bertanya ke user'; break;
      case 'WebFetch': case 'WebSearch': text = 'Riset web'; break;
      case 'Skill': text = `Memuat skill ${str(inp.skill)}`; break;
      case 'TodoWrite': text = 'Memperbarui daftar tugas'; break;
      case 'TaskCreate': text = `Membuat tugas: ${str(inp.subject)}`; break;
      case 'TaskUpdate': text = `Memperbarui tugas${str(inp.status) !== '' ? ` → ${str(inp.status)}` : ''}`; break;
      case 'TaskStop': text = 'Menghentikan agent'; break;
      case 'SubagentHandback': text = 'Menyerahkan laporan ke pemanggil'; break;
      default: text = name;
    }
    return [clip(redact(text), 160), p];
  }
}

function statusOf(r) {
  if (!empty(r.limit)) return 'limit';
  if (r.role === 'orkestrator') return nowSec() - r.mtime < 90 ? 'bekerja' : 'siaga';
  if (['final', 'handback'].includes(r.lastKind ?? '')) return 'selesai';
  return nowSec() - r.mtime <= RUNNING_WINDOW ? 'bekerja' : 'terhenti';
}
function todoStatus(v) {
  return ['pending', 'in_progress', 'completed'].includes(v) ? v : 'pending';
}
function int(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
}
function empty(v) {
  return v === undefined || v === null || v === false || v === 0 || v === '' || v === '0' || (Array.isArray(v) && !v.length) || (isPlainObj(v) && !Object.keys(v).length);
}
function firstToken(cmd) {
  for (const tok of cmd.split(/[ \n]+/)) if (tok !== '') return tok;
  return '';
}
