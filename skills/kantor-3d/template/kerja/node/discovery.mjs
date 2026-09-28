// Port Node dari src/Discovery.php — penemuan peran otomatis (agent project, agentType transkrip, awalan deskripsi).
import fs from 'node:fs';
import { color as cfgColor } from './config.mjs';
import { basename, cmpNum, globDir, isFile, isPlainObj, phpTrim, readText, slug, strcmp } from './util.mjs';

// kunci objek hanya milik sendiri (hindari 'constructor' dsb. dari prototipe)
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const TIER = { config: 0, 'agent-file': 1, builtin: 2, transcript: 2, prefix: 2 };
const PREFIX = /^\s*([\p{L}\p{N} _.\-]{1,40}?)\s*[:—]\s*(.*)$/su;

export class Discovery {
  constructor(projectDir, config, rules) {
    this.projectDir = projectDir;
    this.config = config;
    this.rules = rules;
    this.cand = new Map();
    this.alias = new Map();
    this.hidden = new Set(config.hide);
    this.seq = 0;
    config.roles.forEach((r, i) => {
      if (!this.hidden.has(r.key)) this.add(r.key, 'config', { cfg: r, idx: i });
    });
    if (config.auto) {
      for (const a of agentFiles(projectDir)) {
        if (this.hidden.has(a.key)) continue;
        if (this.cand.has(a.key)) {
          const c = this.cand.get(a.key);
          c.fileColor = a.color;
          c.hasFile = true;
        } else this.add(a.key, 'agent-file', { fileColor: a.color, hasFile: true });
      }
    }
    this.rebuildAliases();
    this.resolve = this.resolve.bind(this);
  }

  ensure(t) {
    if (!this.cand.has(t) && !this.hidden.has(t)) {
      this.add(t, this.rules.builtin_types.includes(t) ? 'builtin' : 'transcript');
      this.rebuildAliases();
    }
  }

  add(key, source, extra = {}) {
    this.cand.set(key, { key, source, tier: TIER[source], idx: 0, seq: this.seq++, cfg: null, fileColor: null, hasFile: false, ...extra });
  }

  rebuildAliases() {
    this.alias = new Map();
    const put = (a, key) => {
      a = slug(a);
      if (a !== '' && !this.alias.has(a)) this.alias.set(a, key);
    };
    for (const key of this.cand.keys()) put(key, key);
    for (const [key, c] of this.cand) {
      if (c.cfg !== null) {
        put(String(c.cfg.name ?? ''), key);
        put(String(c.cfg.role ?? ''), key);
        for (const a of c.cfg.aliases) put(a, key);
      }
    }
    for (const [a, target] of Object.entries(this.rules.aliases)) if (this.cand.has(target)) put(a, target);
  }

  resolve(agentType, desc) {
    let t = slug(agentType);
    if (t === '') t = 'general-purpose';
    const generic = this.rules.generic_types.includes(t);
    let role = null;
    let out = phpTrim(desc);
    const m = PREFIX.exec(desc);
    const pre = m ? [slug(m[1]), phpTrim(m[2])] : null;
    if (!generic && this.alias.has(t)) role = this.alias.get(t);
    else if (!generic && this.config.auto) {
      role = t;
      this.ensure(t);
    }
    if (role !== null) {
      if (pre !== null && this.alias.get(pre[0]) === role) out = pre[1];
    } else {
      if (pre !== null) {
        if (this.alias.has(pre[0])) role = this.alias.get(pre[0]);
        else if (this.config.auto) {
          const canon = own(this.rules.aliases, pre[0]) ?? pre[0];
          if (this.rules.vocabulary.includes(canon) && !this.hidden.has(canon)) {
            this.add(canon, 'prefix');
            this.rebuildAliases();
            role = canon;
          }
        }
        if (role !== null) out = pre[1];
      }
      if (role === null && this.config.auto) {
        role = t;
        this.ensure(t);
      }
    }
    if (role === null || this.hidden.has(role)) return [null, out];
    return [role, out];
  }

  select(runs, team) {
    const last = new Map();
    const count = new Map();
    for (const r of runs) {
      const k = String(r.role);
      if (k === 'orkestrator' || !this.cand.has(k)) continue;
      count.set(k, (count.get(k) ?? 0) + 1);
      const u = String(r.updated ?? '');
      if (u !== '' && strcmp(u, last.get(k) ?? '') > 0) last.set(k, u);
    }
    const byRecent = [...this.cand.values()];
    byRecent.sort((a, b) => {
      const pa = a.tier === 0 ? 0 : 1;
      const pb = b.tier === 0 ? 0 : 1;
      if (pa !== pb || pa === 0) return cmpNum(pa, pb) || cmpNum(a.idx, b.idx);
      return strcmp(last.get(b.key) ?? '', last.get(a.key) ?? '') || cmpNum(a.tier, b.tier) || cmpNum(a.seq, b.seq);
    });
    const max = this.config.max_desks;
    const order = new Map(this.rules.order.map((k, i) => [k, i]));
    const stable = (list) => list.sort((a, b) => {
      if (a.tier !== b.tier) return cmpNum(a.tier, b.tier);
      if (a.tier === 0) return cmpNum(a.idx, b.idx);
      return cmpNum(order.get(a.key) ?? 100, order.get(b.key) ?? 100) || strcmp(a.key, b.key);
    });
    const chosen = stable(byRecent.slice(0, max));
    const rest = stable(byRecent.slice(max));
    const used = new Set();
    const info = (c) => {
      const cfg = c.cfg ?? {};
      let col = cfg.color ?? null;
      if (col === null && c.fileColor !== null) col = own(this.rules.color_names, c.fileColor) ?? cfgColor(c.fileColor);
      col ??= own(this.rules.preset_colors, c.key) ?? null;
      if (col === null) {
        const pal = this.rules.palette;
        const start = hash(c.key) % pal.length;
        col = pal[start];
        for (let i = 0; i < pal.length; i++) {
          const x = pal[(start + i) % pal.length];
          if (!used.has(x)) {
            col = x;
            break;
          }
        }
      }
      used.add(col);
      const source = c.source === 'config' ? (c.hasFile ? 'agent-file' : 'config') : c.source;
      return {
        key: c.key,
        name: cfg.name ?? own(this.rules.names, c.key) ?? this.humanize(c.key),
        role: cfg.role ?? ((cfg.name ?? null) !== null ? (own(this.rules.names, c.key) ?? this.humanize(c.key)) : own(this.rules.source_labels, source)),
        color: col,
        look: cfg.look ?? null,
        screen: cfg.screen ?? null,
        asks: Boolean(cfg.asks ?? false),
        source,
        last_active: last.get(c.key) ?? null,
        runs: count.get(c.key) ?? 0,
      };
    };
    const roles = chosen.map(info);
    const overflow = rest.map(info);
    if (roles.length && !roles.some((r) => r.asks)) {
      const keys = roles.map((r) => r.key);
      const plan = team && typeof team.plan === 'string' ? team.plan : null;
      const pick = plan !== null && keys.includes(plan) ? plan : keys.includes('analyst') ? 'analyst' : keys[0];
      for (const r of roles) r.asks = r.key === pick;
    }
    overflow.sort((a, b) => strcmp(b.last_active ?? '', a.last_active ?? ''));
    return { roles, overflow };
  }

  humanize(key) {
    const words = key.split('-').filter((w) => w !== '').map((w) => (this.rules.acronyms.includes(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
    return words.length ? words.join(' ') : key;
  }
}

export function hash(s) {
  let h = 7;
  for (const b of Buffer.from(s, 'utf8')) h = (h * 31 + b) % 4294967296;
  return h;
}

export function agentFiles(projectDir) {
  const out = [];
  for (const f of globDir(`${projectDir}/.claude/agents`, '.md')) {
    if (!isFile(f)) continue;
    let head = '';
    try {
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      head = buf.subarray(0, n).toString('utf8');
    } catch {
      head = '';
    }
    const fm = {};
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    if (m) {
      for (const l of m[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z_-]+):[ \t]*(.*?)[ \t]*$/.exec(l);
        if (kv) fm[kv[1].toLowerCase()] = phpTrim(kv[2], "\"' ");
      }
    }
    const key = slug((fm.name ?? '') !== '' ? fm.name : basename(f, '.md'));
    if (key === '' || key === 'orkestrator') continue;
    out.push({ key, color: (fm.color ?? '') !== '' ? fm.color.toLowerCase() : null });
  }
  return out;
}

export function team(projectDir) {
  const f = `${projectDir}/.claude/tim-ai.json`;
  if (!isFile(f)) return null;
  let j;
  try {
    j = JSON.parse(readText(f) ?? '');
  } catch {
    return null;
  }
  if (!isPlainObj(j)) return null;
  const out = {};
  for (const k of ['preset', 'plan', 'execute', 'review']) {
    let v = j[k] ?? null;
    if (Array.isArray(v)) v = v[0] ?? null;
    if (typeof v === 'string') {
      const s = slug(v);
      if (s !== '') out[k] = s;
    }
  }
  return Object.keys(out).length ? out : null;
}
