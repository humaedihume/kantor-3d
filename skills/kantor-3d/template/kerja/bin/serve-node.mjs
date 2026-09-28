#!/usr/bin/env node
// Server Node (≥18, tanpa dependensi npm) yang setara dengan public/index.php — rute, JSON, dan aturan keamanan sama:
//   /kerja  /kerja/api/state  /kerja/api/doc?path=  /kerja/evidence/<rel>  /kerja/assets/<file>
// Read-only, redaksi rahasia, whitelist path, header noindex, isi tool_result tidak pernah dibaca.
//   node kerja/bin/serve-node.mjs            → http://127.0.0.1:${KERJA_PORT:-8787}/kerja
//   KERJA_BIND=0.0.0.0 KERJA_PORT=9000 node kerja/bin/serve-node.mjs   (mis. di belakang reverse proxy)
// Kesetaraan dengan PHP diuji oleh bin/parity.mjs.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`Butuh Node ≥ 18 (terpasang ${process.versions.node}).`);
  process.exit(1);
}

const KERJA = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const PROJECT = path.dirname(KERJA);
const PUBLIC = path.join(KERJA, 'public');
const { loadConfig } = await import(new URL('../node/config.mjs', import.meta.url));
const { Planning } = await import(new URL('../node/planning.mjs', import.meta.url));
const { buildState, discover, pageConfig } = await import(new URL('../node/state.mjs', import.meta.url));

fs.mkdirSync(path.join(KERJA, 'storage', 'cache'), { recursive: true });

const BASE_HEADERS = { 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const htmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
// setara JSON_HEX_TAG|JSON_HEX_AMP|JSON_HEX_APOS: aman disisipkan di <script>
const scriptJson = (v) => JSON.stringify(v).replace(/[<>&'\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
const rawurldecode = (s) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, '%2B'));
  } catch {
    return s;
  }
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'Metode tidak didukung');
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Permintaan tidak valid');
  }
  const p = url.pathname.replace(/\/+$/, '');
  // config dibaca per permintaan (seperti PHP) supaya perubahan kerja/config.json langsung terpakai
  const config = loadConfig(path.join(KERJA, 'config.json'), PROJECT);

  if (p === '' || p === '/index.php') return send(res, 302, { Location: '/kerja' }, '');
  if (p === '/kerja') {
    const page = fs.readFileSync(path.join(KERJA, 'views', 'page.html'), 'utf8');
    const cfg = pageConfig(config, discover(PROJECT, KERJA, config));
    const html = page.replace(/\{\{PROJECT\}\}|\{\{CONFIG_SCRIPT\}\}/g, (m) => (m === '{{PROJECT}}'
      ? htmlEsc(config.project)
      : `<script>window.KERJA_CONFIG = ${scriptJson(cfg)};</script>`));
    return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }, html);
  }
  if (p === '/kerja/api/state') {
    const state = await buildState(PROJECT, KERJA, config);
    return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(state));
  }
  if (p === '/kerja/api/doc') {
    const q = url.searchParams.getAll('path');
    const md = new Planning(path.join(PROJECT, 'planning')).doc(q.length ? q[q.length - 1] : '');
    if (md === null) return send(res, 404, {}, '');
    return send(res, 200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' }, md);
  }
  // aset di bawah /kerja/ agar tidak bentrok dengan /assets situs lain (reverse proxy di domain yang sudah ada)
  if (p.startsWith('/kerja/assets/')) {
    let base;
    let f;
    try {
      base = fs.realpathSync(path.join(PUBLIC, 'assets'));
      f = fs.realpathSync(path.join(PUBLIC, 'assets', rawurldecode(p.slice('/kerja/assets/'.length))));
    } catch {
      return send(res, 404, {}, '');
    }
    let st;
    try {
      st = fs.statSync(f);
    } catch {
      return send(res, 404, {}, '');
    }
    if (!f.startsWith(base + path.sep) || !st.isFile() || path.extname(f).toLowerCase() !== '.js') return send(res, 404, {}, '');
    const etag = `"${Math.floor(st.mtimeMs / 1000).toString(16)}-${st.size.toString(16)}"`;
    const h = { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ETag: etag };
    if (req.headers['if-none-match'] === etag) return send(res, 304, h, '');
    return send(res, 200, { ...h, 'Content-Length': String(st.size) }, fs.readFileSync(f));
  }
  if (p.startsWith('/kerja/evidence/')) {
    const f = new Planning(path.join(PROJECT, 'planning')).evidencePath(rawurldecode(p.slice('/kerja/evidence/'.length)));
    if (f === null) return send(res, 404, {}, '');
    const ext = path.extname(f).slice(1).toLowerCase();
    const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[ext] ?? 'application/octet-stream';
    const body = fs.readFileSync(f);
    return send(res, 200, { 'Content-Type': type, 'Cache-Control': 'max-age=60', 'Content-Length': String(body.length) }, body);
  }
  return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Tidak ditemukan');
}

const port = Number(process.env.KERJA_PORT || 8787);
const bind = process.env.KERJA_BIND || '127.0.0.1';
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(`[kerja] ${req.method} ${req.url}: ${e && e.stack ? e.stack : e}`);
    if (!res.headersSent) send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Kesalahan server');
    else res.end();
  });
});
server.on('error', (e) => {
  console.error(`[kerja] server gagal: ${e.message}`);
  process.exit(1);
});
server.listen(port, bind, () => console.log(`Kantor 3D: http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${port}/kerja  (Node ${process.versions.node}, project ${PROJECT})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
