// Port Node dari src/Planning.php — membaca planning/ (roadmap, plan, laporan QA, bukti, dokumen).
import fs from 'node:fs';
import path from 'node:path';
import {
  basename, clip, cmpNum, globDir, isDir, isFile, isoC, mtimeSec, phpInt, phpLtrim, phpTrim, readText, redact, splitR,
  stripMd, strcmp,
} from './util.mjs';

const S = '[ \\t\\n\\x0b\\f\\r]';
const re = (src, flags = '') => new RegExp(src.replaceAll('\\s', S), flags);

export class Planning {
  constructor(dir) {
    this.dir = dir;
  }

  exists() {
    return isFile(`${this.dir}/ROADMAP.md`) || isFile(`${this.dir}/BACKLOG.md`) || isDir(`${this.dir}/plans`);
  }

  snapshot() {
    const plans = this.plans();
    const roadmap = this.roadmap(plans);
    return { roadmap, plans, qa: this.qaReports(), evidence: this.evidence(), docs: this.docs(), deferred: this.deferred() };
  }

  plans() {
    const out = [];
    for (const f of globDir(`${this.dir}/plans`, '.md')) {
      const md = readText(f) ?? '';
      const fm = frontmatter(md);
      const m = [...md.matchAll(re('^\\s*- \\[( |x|X)\\] ', 'gm'))].map((x) => x[1]);
      const done = m.filter((c) => c.toLowerCase() === 'x').length;
      const ac = [...md.matchAll(re('^\\|\\s*AC\\d+\\s*\\|', 'gm'))];
      const id = fm.id ?? basename(f).slice(0, 3);
      out.push({
        id: phpTrim(id, "\"' "),
        title: phpTrim(fm.judul ?? h1(md) ?? basename(f, '.md'), "\"' "),
        status: fm.status ?? 'draft',
        qa_round: phpInt(fm.qa_ronde ?? 0),
        tasks_done: done,
        tasks_total: m.length,
        ac_total: ac.length,
        depends_on: fm.depends_on ?? '',
        path: `planning/plans/${basename(f)}`,
        updated: isoC(mtimeSec(f)),
      });
    }
    out.sort((a, b) => strcmp(a.id, b.id));
    return out;
  }

  roadmap(plans) {
    const f = `${this.dir}/ROADMAP.md`;
    if (!isFile(f)) return { exists: false, modules: [], phases: [], questions: [] };
    const md = readText(f) ?? '';
    const modules = new Map();
    for (const line of splitR(md)) {
      if (!phpLtrim(line).startsWith('|')) continue;
      const cells = phpTrim(phpTrim(line), '|').split('|').map((c) => phpTrim(stripMd(c)));
      let idIdx = null;
      for (const [i, c] of cells.entries()) {
        if (/^M(\d{2})$/.test(c)) {
          idIdx = i;
          break;
        }
      }
      if (idIdx === null) continue;
      const id = cells[idIdx];
      const mod = modules.get(id) ?? { id, name: '', status: null, pct: null, size: null };
      if (mod.name === '' && cells[idIdx + 1] !== undefined) mod.name = shortName(cells[idIdx + 1]);
      for (const c of cells) {
        let p;
        if (mod.pct === null && (p = re('^~?\\s*(\\d{1,3})\\s*%').exec(c))) mod.pct = Math.min(100, Number(p[1]));
        if (mod.status === null && (p = /\b(SUDAH|SEBAGIAN|BELUM)\b/i.exec(c))) mod.status = p[1].toUpperCase();
        if (mod.size === null && /^(S|M|L|XL)$/.test(c)) mod.size = c;
      }
      modules.set(id, mod);
    }
    for (const mod of modules.values()) {
      const num = mod.id.slice(1);
      const mine = plans.filter((p) => p.id.startsWith(num) && Buffer.byteLength(p.id) === 3);
      let base = mod.pct ?? (mod.status === 'SUDAH' ? 100 : mod.status === 'SEBAGIAN' ? 50 : 0);
      mod.audit_pct = base;
      mod.plans = mine.map((p) => p.id);
      if (mine.length) {
        let units = 0.0;
        for (const p of mine) units += p.status === 'done' ? 1.0 : p.tasks_total > 0 ? 0.85 * p.tasks_done / p.tasks_total : 0.0;
        base = phpRound(base + (100 - base) * units / mine.length);
        mod.plan_status = aggregateStatus(mine);
      } else {
        mod.plan_status = null;
      }
      mod.progress = base;
    }
    const phases = [];
    const ph = [...md.matchAll(re('^\\|\\s*\\**\\s*(\\d{1,2})\\.\\s*([^|*]+?)\\**\\s*\\|\\s*([^|]*)\\|', 'gm'))];
    if (ph.length) {
      for (const p of ph) phases.push({ n: Number(p[1]), name: phpTrim(p[2]), modules: phpTrim(stripMd(p[3])) });
    } else {
      for (const p of md.matchAll(re('^#{2,4}\\s*Fase\\s*(\\d+)[ \\t\\n\\x0b\\f\\r.:—-]*(.*)$', 'gmi'))) {
        phases.push({ n: Number(p[1]), name: phpTrim(stripMd(p[2])), modules: '' });
      }
    }
    return {
      exists: true,
      updated: isoC(mtimeSec(f)),
      modules: [...modules.values()],
      phases,
      questions: questions(md),
      summary: section(md, re('^#{2}\\s*.*(ringkasan|kondisi)', 'i'), 900),
    };
  }

  deferred() {
    const f = `${this.dir}/DITUNDA.md`;
    if (!isFile(f)) return [];
    const out = [];
    for (const l of splitR(readText(f) ?? '')) {
      if (!re('^\\|\\s*\\d{4}-\\d{2}-\\d{2}').test(l)) continue;
      const c = phpTrim(phpTrim(l), '|').split('|').map((x) => phpTrim(x));
      const done = l.includes('~~');
      const clean = (v) => phpTrim(stripMd(v ?? '', ['~~']));
      out.push({ date: clean(c[0]), plan: clean(c[1]), item: clean(c[2]), reason: clean(c[3]), need: clean(c[4]), done });
    }
    return out;
  }

  qaReports() {
    const out = [];
    for (const f of globDir(`${this.dir}/qa`, '.md')) {
      const md = readText(f) ?? '';
      const name = basename(f, '.md');
      const m = /^(\d{3})(?:-qa-r(\d+))?/.exec(name);
      const v = re('Verdict:?\\**\\s*:?\\s*\\**\\s*(PASS|FAIL)', 'i').exec(md);
      const bugs = [...md.matchAll(re('^#{2,4}\\s*B\\d+\\b', 'gm'))];
      out.push({
        file: name,
        plan: m ? m[1] : '',
        round: m && m[2] !== undefined ? Number(m[2]) : 0,
        verdict: v ? v[1].toUpperCase() : null,
        bugs: bugs.length,
        title: h1(md) ?? name,
        path: `planning/qa/${basename(f)}`,
        updated: isoC(mtimeSec(f)),
      });
    }
    out.sort((a, b) => strcmp(b.updated, a.updated));
    return out;
  }

  evidence() {
    const root = `${this.dir}/qa/evidence`;
    if (!isDir(root)) return [];
    const files = [];
    const walk = (dir) => {
      let ents;
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        let file = e.isFile();
        if (e.isDirectory()) {
          walk(full);
          continue;
        }
        if (e.isSymbolicLink()) file = isFile(full);
        if (file && /\.(png|jpe?g|webp)$/i.test(e.name)) {
          const rel = full.slice(root.length + 1);
          const ext = path.extname(e.name).slice(1);
          files.push({ path: rel, plan: rel.split('/')[0], name: e.name.slice(0, e.name.length - ext.length - 1), t: mtimeSec(full) });
        }
      }
    };
    walk(root);
    files.sort((a, b) => cmpNum(b.t, a.t) || strcmp(a.path, b.path));
    return files.slice(0, 36).map((e) => ({ ...e, updated: isoC(e.t) }));
  }

  docs() {
    const out = [];
    const parent = path.dirname(this.dir);
    for (const f of [...globDir(this.dir, '.md'), ...globDir(`${this.dir}/plans`, '.md'), ...globDir(`${this.dir}/qa`, '.md')]) {
      const md = readText(f) ?? '';
      out.push({ path: f.slice(parent.length + 1), title: h1(md) ?? basename(f), updated: isoC(mtimeSec(f)), bytes: Buffer.byteLength(md) });
    }
    out.sort((a, b) => strcmp(b.updated, a.updated));
    return out;
  }

  doc(rel) {
    rel = String(rel).replace(/^\/+/, '');
    if (!/^planning\/[A-Za-z0-9_\-/]+\.md$/.test(rel) || rel.includes('..')) return null;
    const f = `${path.dirname(this.dir)}/${rel}`;
    return isFile(f) ? redact(readText(f) ?? '') : null;
  }

  evidencePath(rel) {
    if (!/^[A-Za-z0-9_\-/]+\.(png|jpe?g|webp)$/i.test(rel) || rel.includes('..')) return null;
    const f = `${this.dir}/qa/evidence/${rel}`;
    return isFile(f) ? f : null;
  }
}

function aggregateStatus(plans) {
  const st = plans.map((p) => p.status);
  for (const s of ['in-progress', 'qa-failed', 'ready-for-qa', 'blocked', 'approved', 'draft']) if (st.includes(s)) return s;
  return 'done';
}

function questions(md) {
  const out = [];
  const lines = splitR(md);
  let cur = null;
  const flush = () => {
    if (cur !== null) {
      const body = cur.body.join('\n');
      const r = /rekomendasi[^:]*:[ \t\n\x0b\f\r]*(.+)/i.exec(body);
      out.push({
        id: cur.id,
        title: cur.title,
        tag: /\[BLOKIR\]/i.test(cur.title + body) ? 'BLOKIR' : /\[ASUMSI\]/i.test(cur.title + body) ? 'ASUMSI' : '',
        answered: /(^|\n)\s*>?\s*(✅|\*\*Jawaban user)/u.test(body),
        recommendation: r ? clip(phpTrim(stripMd(r[1])), 220) : null,
      });
    }
    cur = null;
  };
  const qre = re('^(?:#{2,5}\\s*|\\s*[-*]\\s*\\*\\*|\\*\\*)\\s*Q(\\d{1,2})\\b[ \\t\\n\\x0b\\f\\r.:)—\\-]*\\**\\s*(.*)$');
  for (const l of lines) {
    const m = qre.exec(l);
    if (m) {
      flush();
      cur = { id: `Q${m[1]}`, title: phpTrim(stripMd(m[2])), body: [] };
      continue;
    }
    if (cur !== null) {
      if (re('^#{1,3}\\s').test(l) && !re('^#{1,3}\\s*Q\\d').test(l)) {
        flush();
        continue;
      }
      cur.body.push(l);
    }
  }
  flush();
  const seen = new Set();
  return out.filter((q) => {
    if (seen.has(q.id)) return false;
    seen.add(q.id);
    return true;
  });
}

function frontmatter(md) {
  const m = /^---(?:\r\n|[\n\x0b\x0c\r\x85])([\s\S]*?)(?:\r\n|[\n\x0b\x0c\r\x85])---/.exec(md);
  if (!m) return {};
  const out = {};
  for (const l of splitR(m[1])) {
    const kv = re('^([a-z_]+):\\s*(.*?)\\s*(#.*)?$', 'i').exec(l);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

function h1(md) {
  const m = re('^#\\s+(.+)$', 'm').exec(md);
  return m ? phpTrim(stripMd(m[1])) : null;
}

function shortName(s) {
  return clip(phpTrim(s.replace(re('\\s*\\(.*?\\)\\s*', 'g'), ' ')), 48);
}

function section(md, headRe, max) {
  let buf = null;
  for (const l of splitR(md)) {
    if (buf === null) {
      if (headRe.test(l)) buf = [];
      continue;
    }
    if (re('^#{1,2}\\s').test(l)) break;
    buf.push(l);
  }
  return buf === null ? null : clip(phpTrim(buf.join('\n')), max);
}

// round() PHP: setengah menjauhi nol
function phpRound(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}
