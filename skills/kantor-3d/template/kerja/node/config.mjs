// Port Node dari src/Config.php — kerja/config.json (opsional) → konfigurasi ternormalisasi.
import path from 'node:path';
import { isFile, isPlainObj, phpTrim, readText, slug } from './util.mjs';

export const MAX_ROLES = 6;

export function str(v) {
  if (typeof v !== 'string') return null;
  v = phpTrim(v);
  return v === '' ? null : v;
}
export function color(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
}
function parse(file) {
  if (!isFile(file)) return {};
  try {
    const c = JSON.parse(readText(file) ?? '');
    return isPlainObj(c) || (Array.isArray(c) && c.length === 0) ? (Array.isArray(c) ? {} : c) : {};
  } catch {
    return {};
  }
}

export function loadConfig(file, projectDir) {
  const c = parse(file);
  const roles = new Map();
  const cr = c.roles;
  if (cr && ((Array.isArray(cr) && cr.length) || (isPlainObj(cr) && Object.keys(cr).length))) {
    for (const r of Array.isArray(cr) ? cr : Object.values(cr)) {
      if (!isPlainObj(r) && !Array.isArray(r)) continue;
      const key = slug(str(r.key) ?? str(r.role) ?? '');
      if (key === '' || key === 'orkestrator' || roles.has(key)) continue;
      const aliases = [];
      for (const a of Array.isArray(r.aliases) ? r.aliases : isPlainObj(r.aliases) ? Object.values(r.aliases) : []) {
        if (typeof a === 'string') {
          const s = slug(a);
          if (s !== '') aliases.push(s);
        }
      }
      roles.set(key, {
        key,
        name: str(r.name),
        role: str(r.role),
        color: color(r.color),
        look: isPlainObj(r.look) && Object.keys(r.look).length ? r.look : null,
        screen: ['docs', 'files', 'evidence', 'commands'].includes(r.screen) ? r.screen : null,
        asks: truthy(r.asks_user),
        hide: truthy(r.hide),
        aliases,
      });
    }
  } else if (isPlainObj(c.team) || (Array.isArray(c.team))) {
    const t = isPlainObj(c.team) ? c.team : {};
    for (const [k, n, ro] of [['analyst', 'Pingot', 'Analyst'], ['developer', 'Zaki', 'Developer'], ['qa', 'Lulu', 'QA']]) {
      const e = isPlainObj(t[k]) ? t[k] : {};
      roles.set(k, { key: k, name: str(e.name) ?? n, role: str(e.role) ?? ro, color: null, look: null, screen: null, asks: false, hide: false, aliases: [] });
    }
  }
  const hide = new Set();
  for (const h of Array.isArray(c.hide) ? c.hide : isPlainObj(c.hide) ? Object.values(c.hide) : []) {
    if (typeof h === 'string') {
      const s = slug(h);
      if (s !== '') hide.add(s);
    }
  }
  for (const [k, r] of roles) if (r.hide) hide.add(k);
  const max = Number.isInteger(c.max_desks) ? Math.max(1, Math.min(MAX_ROLES, c.max_desks)) : MAX_ROLES;
  const o = isPlainObj(c.orchestrator) ? c.orchestrator : isPlainObj(c.team) && isPlainObj(c.team.orkestrator) ? c.team.orkestrator : {};
  const url = str(c.public_url);
  return {
    project: str(c.project) ?? path.basename(projectDir),
    host: str(c.host) ?? '',
    public_url: url !== null && /^https?:\/\/[^\t\n\x0b\f\r "<>]+$/.test(url) ? url : null,
    auto: c.auto !== false,
    max_desks: max,
    hide: [...hide],
    roles: [...roles.values()],
    orchestrator: { name: str(o.name) ?? 'Orkestrator', role: str(o.role) ?? 'Sesi utama' },
  };
}

// empty() PHP dibalik
function truthy(v) {
  if (v === undefined || v === null || v === false || v === 0 || v === '' || v === '0') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObj(v)) return Object.keys(v).length > 0;
  return true;
}
