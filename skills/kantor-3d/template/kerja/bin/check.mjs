#!/usr/bin/env node
// Pemeriksaan cepat setelah pasang (Node ≥ 18, tanpa Playwright): halaman, JSON state, header keamanan, 404 path terlarang.
//   node kerja/bin/check.mjs http://127.0.0.1:8787      (atau https://kerja.proyek.test, https://domain.com)
// Keluar 0 bila semua lolos.
const base = (process.argv[2] || `http://127.0.0.1:${process.env.KERJA_PORT || 8787}`).replace(/\/+$/, '').replace(/\/kerja$/, '');
if (base.startsWith('https://') && /\.test(?::\d+)?$/.test(new URL(base).host)) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Valet: sertifikat lokal
const bad = [];
const good = [];
const t = (name, cond, extra = '') => (cond ? good : bad).push(extra ? `${name} (${extra})` : name);
const get = (p) => fetch(base + p, { redirect: 'manual' });

try {
  const page = await get('/kerja');
  const html = await page.text();
  t('/kerja → 200', page.status === 200, String(page.status));
  t('header X-Robots-Tag noindex', /noindex/.test(page.headers.get('x-robots-tag') || ''));
  t('header Referrer-Policy no-referrer', page.headers.get('referrer-policy') === 'no-referrer');
  const m = /window\.KERJA_CONFIG = (.*?);<\/script>/s.exec(html);
  let cfg = null;
  try {
    cfg = m ? JSON.parse(m[1]) : null;
  } catch {
    cfg = null;
  }
  t('KERJA_CONFIG terbaca', cfg !== null && Array.isArray(cfg.roles));
  const r = await get('/kerja/api/state');
  const s = await r.json().catch(() => null);
  t('/kerja/api/state → JSON', r.status === 200 && s && typeof s === 'object', String(r.status));
  if (s) {
    for (const k of ['mode', 'agents', 'roles', 'overflow', 'feed', 'runs', 'roadmap', 'plans', 'totals']) t(`state.${k} ada`, k in s);
    t('agent orkestrator ada', !!s.agents?.orkestrator);
    const txt = JSON.stringify(s);
    t('tidak ada token sk-… / ghp_… yang lolos redaksi', !/\bsk-(?!•)[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9]{20,}/.test(txt));
    console.log(`  mode ${s.mode} · ${s.roles.length} meja (${s.roles.map((x) => `${x.name}`).join(', ') || '—'})${s.overflow.length ? ` · +${s.overflow.length} tanpa meja` : ''} · ${s.runs.length} run · ${s.feed.length} event`);
    if (s.mode === 'auto') {
      const fb = s.fallback || {};
      console.log(`  papan cadangan: ${fb.todos?.length ?? 0} daftar tugas · git ${fb.commits?.available ? `${fb.commits.items.length} commit` : `— ${fb.commits?.reason}`} · ${fb.hot_files?.length ?? 0} file sering diubah`);
    }
  }
  const js = await get('/kerja/assets/kantor.js');
  t('/kerja/assets/kantor.js → 200', js.status === 200, String(js.status));
  for (const p of ['/kerja/api/doc?path=planning/../kerja/config.json', '/kerja/evidence/..%2F..%2Fkerja%2Fconfig.json', '/kerja/assets/..%2F..%2Fsrc%2FConfig.php']) {
    t(`404 ${p}`, (await get(p)).status === 404);
  }
} catch (e) {
  bad.push(`tidak bisa terhubung ke ${base}: ${e.cause?.code || e.message}`);
}
for (const g of good) console.log(`  ok    ${g}`);
for (const b of bad) console.log(`  GAGAL ${b}`);
console.log(bad.length ? `GAGAL (${bad.length})` : `OK (${good.length} pemeriksaan) — buka ${base}/kerja`);
process.exit(bad.length ? 1 : 0);
