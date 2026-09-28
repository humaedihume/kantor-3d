#!/usr/bin/env node
// Uji kesetaraan server PHP (public/index.php via php -S) dan Node (bin/serve-node.mjs) pada project & transkrip yang sama.
//   node kerja/bin/parity.mjs [--php-port=8791] [--node-port=8792] [--forbid=regex …]
// Membandingkan: JSON /kerja/api/state (kecuali "now"), KERJA_CONFIG di /kerja, /kerja/api/doc, /kerja/evidence,
// /kerja/assets, header keamanan, 404 untuk path traversal, dan memastikan tidak ada rahasia/isi tool_result bocor.
// Keluar 0 bila semua sama. Kedua server dimatikan di akhir.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KERJA = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const arg = (k, d) => process.argv.slice(2).filter((a) => a.startsWith(`--${k}=`)).map((a) => a.slice(k.length + 3)).pop() ?? d;
const PHP_PORT = Number(arg('php-port', 8791));
const NODE_PORT = Number(arg('node-port', 8792));
const FORBID = [
  /\bsk-(?!•)[A-Za-z0-9_-]{8,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/,
  ...process.argv.slice(2).filter((a) => a.startsWith('--forbid=')).map((a) => new RegExp(a.slice(9))),
];
const IGNORE = new Set(['now']);

const procs = [];
const problems = [];
const ok = [];
const cleanup = () => {
  for (const p of procs) {
    try {
      p.kill('SIGTERM');
    } catch {
      /* sudah berhenti */
    }
  }
};
process.on('exit', cleanup);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));

function start(cmd, args, env) {
  const p = spawn(cmd, args, { cwd: KERJA, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => {
    err += d;
  });
  p.on('error', (e) => problems.push(`${cmd} tidak bisa dijalankan: ${e.message}`));
  procs.push(p);
  return () => err;
}
async function waitUp(base, name, errOf) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/kerja/api/state`);
      if (r.ok) return true;
    } catch {
      /* belum siap */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  problems.push(`${name} tidak siap di ${base}: ${errOf().slice(0, 400)}`);
  return false;
}
const get = (base, p, h = {}) => fetch(base + p, { redirect: 'manual', headers: h });

function diff(a, b, at = '$', out = []) {
  if (out.length > 40) return out;
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b;
  if (ta !== tb) {
    out.push(`${at}: tipe ${ta} ≠ ${tb} (${JSON.stringify(a)?.slice(0, 80)} | ${JSON.stringify(b)?.slice(0, 80)})`);
    return out;
  }
  if (ta === 'array') {
    if (a.length !== b.length) out.push(`${at}: panjang ${a.length} ≠ ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${at}[${i}]`, out);
  } else if (ta === 'object') {
    const ka = Object.keys(a).filter((k) => !(at === '$' && IGNORE.has(k)));
    const kb = Object.keys(b).filter((k) => !(at === '$' && IGNORE.has(k)));
    if (ka.join('|') !== kb.join('|')) out.push(`${at}: kunci [${ka}] ≠ [${kb}]`);
    for (const k of ka) if (Object.hasOwn(b, k)) diff(a[k], b[k], `${at}.${k}`, out);
  } else if (a !== b) {
    out.push(`${at}: ${JSON.stringify(a)?.slice(0, 100)} ≠ ${JSON.stringify(b)?.slice(0, 100)}`);
  }
  return out;
}
function check(name, cond, detail = '') {
  if (cond) ok.push(name);
  else problems.push(`${name}${detail ? `: ${detail}` : ''}`);
}

const phpErr = start('php', ['-S', `127.0.0.1:${PHP_PORT}`, '-t', 'public', 'public/index.php'], {});
const nodeErr = start(process.execPath, ['bin/serve-node.mjs'], { KERJA_PORT: String(NODE_PORT), KERJA_BIND: '127.0.0.1' });
const P = `http://127.0.0.1:${PHP_PORT}`;
const N = `http://127.0.0.1:${NODE_PORT}`;
const up = (await waitUp(P, 'PHP', phpErr)) & (await waitUp(N, 'Node', nodeErr));

if (up) {
  // state: dua kali (pertama membangun cache masing-masing)
  let sp;
  let sn;
  for (let round = 1; round <= 2; round++) {
    const [rp, rn] = await Promise.all([get(P, '/kerja/api/state'), get(N, '/kerja/api/state')]);
    sp = await rp.json();
    sn = await rn.json();
    const d = diff(sp, sn);
    check(`state ronde ${round} identik (${Object.keys(sp).length} kunci, ${sp.runs?.length ?? 0} run, ${sp.feed?.length ?? 0} event, mode ${sp.mode})`, d.length === 0, `\n    ${d.slice(0, 25).join('\n    ')}`);
  }
  const rawP = JSON.stringify(sp);
  for (const re of FORBID) check(`tidak ada kebocoran ${re}`, !re.test(rawP) && !re.test(JSON.stringify(sn)), (rawP.match(re) || [''])[0].slice(0, 60));

  // halaman + KERJA_CONFIG
  const [hp, hn] = await Promise.all([get(P, '/kerja'), get(N, '/kerja')]);
  const [tp, tn] = [await hp.text(), await hn.text()];
  check('/kerja 200 di keduanya', hp.status === 200 && hn.status === 200, `${hp.status}/${hn.status}`);
  const cfgOf = (t) => {
    const m = /window\.KERJA_CONFIG = (.*?);<\/script>/s.exec(t);
    return m ? JSON.parse(m[1]) : null;
  };
  const cd = diff(cfgOf(tp), cfgOf(tn));
  check('KERJA_CONFIG identik', cfgOf(tp) !== null && cd.length === 0, cd.join('; '));
  check('<title> identik', (/<title>(.*?)<\/title>/.exec(tp) || [])[1] === (/<title>(.*?)<\/title>/.exec(tn) || [])[1]);
  for (const [h, want] of [['x-robots-tag', 'noindex, nofollow'], ['referrer-policy', 'no-referrer']]) {
    check(`header ${h}`, hp.headers.get(h) === want && hn.headers.get(h) === want, `${hp.headers.get(h)} / ${hn.headers.get(h)}`);
  }

  // dokumen & bukti (bila ada)
  const doc = sp.docs?.[0]?.path;
  if (doc) {
    const [dp, dn] = await Promise.all([get(P, `/kerja/api/doc?path=${encodeURIComponent(doc)}`), get(N, `/kerja/api/doc?path=${encodeURIComponent(doc)}`)]);
    check(`/kerja/api/doc ${doc} identik`, dp.status === 200 && dn.status === 200 && (await dp.text()) === (await dn.text()), `${dp.status}/${dn.status}`);
  }
  const ev = sp.evidence?.[0]?.path;
  if (ev) {
    const u = `/kerja/evidence/${ev.split('/').map(encodeURIComponent).join('/')}`;
    const [ep, en] = await Promise.all([get(P, u), get(N, u)]);
    const [bp, bn] = [Buffer.from(await ep.arrayBuffer()), Buffer.from(await en.arrayBuffer())];
    check(`/kerja/evidence ${ev} identik`, ep.status === 200 && en.status === 200 && bp.equals(bn) && ep.headers.get('content-type') === en.headers.get('content-type'),
      `${ep.status}/${en.status} ${ep.headers.get('content-type')}/${en.headers.get('content-type')}`);
  }
  const [ap, an] = await Promise.all([get(P, '/kerja/assets/kantor.js'), get(N, '/kerja/assets/kantor.js')]);
  check('/kerja/assets/kantor.js identik', ap.status === 200 && an.status === 200 && (await ap.text()) === (await an.text()));
  const etag = an.headers.get('etag');
  check('ETag sama & 304', etag === ap.headers.get('etag') && (await get(N, '/kerja/assets/kantor.js', { 'If-None-Match': etag })).status === 304
    && (await get(P, '/kerja/assets/kantor.js', { 'If-None-Match': etag })).status === 304);

  // path terlarang → 404 di keduanya
  for (const bad of [
    '/kerja/api/doc?path=planning/../kerja/config.json', '/kerja/api/doc?path=../README.md', '/kerja/api/doc?path=planning%2F..%2F..%2Fetc%2Fpasswd.md',
    '/kerja/api/doc?path=/etc/passwd', '/kerja/evidence/..%2F..%2Fkerja%2Fconfig.json', '/kerja/evidence/../../config.png',
    '/kerja/assets/..%2F..%2Fsrc%2FConfig.php', '/kerja/assets/vendor/..%2F..%2Findex.php', '/kerja/assets/%2e%2e/%2e%2e/config.json',
    '/kerja/assets/../../config.json', '/kerja/tidak-ada', '/src/Config.php', '/config.json', '/storage/stopped.txt',
  ]) {
    const [bp, bn] = await Promise.all([get(P, bad), get(N, bad)]);
    check(`404 ${bad}`, bp.status === 404 && bn.status === 404, `PHP ${bp.status} / Node ${bn.status}`);
  }
  const [rp, rn] = await Promise.all([get(P, '/'), get(N, '/')]);
  check('/ → 302 /kerja', rp.status === 302 && rn.status === 302 && rp.headers.get('location') === '/kerja' && rn.headers.get('location') === '/kerja');
}

cleanup();
for (const o of ok) console.log(`  ok   ${o}`);
for (const p of problems) console.log(`  BEDA ${p}`);
console.log(problems.length ? `PARITY GAGAL (${problems.length} masalah, ${ok.length} ok)` : `PARITY OK (${ok.length} pemeriksaan)`);
process.exit(problems.length ? 1 : 0);
