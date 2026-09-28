// Ruang kerja tim — kantor 3D (three.js r170). Karakter & papan digerakkan data real dari /kerja/api/state.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const API = '/kerja/api/state';
const POLL_MS = 3000;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

// window.KERJA_CONFIG dari server: peran hasil penemuan otomatis (maks 6 meja) + penimpaan kerja/config.json
const CFG = window.KERJA_CONFIG || {};
const PROJECT = CFG.project || 'Project';
const LAYOUT = typeof CFG.layout === 'string' ? CFG.layout : null;
const TEAM = CFG.team || null;
const ROLE_LIST = (Array.isArray(CFG.roles) ? CFG.roles : []).slice(0, 6);
// tampilan bawaan: analyst/developer/qa punya gaya khas; peran lain memakai EXTRA_LOOKS bergiliran
const PRESETS = {
  analyst: { css: '#3f6fd1', shirt: '#4d7fd6', pants: '#3a4150', skin: '#c68a5e', hair: '#2a211c', hairStyle: 'short', glasses: true, prop: 'notes' },
  developer: { css: '#2f9a6d', shirt: '#3a9b72', pants: '#2e333d', skin: '#a86e45', hair: '#191310', hairStyle: 'curly', headphones: true, prop: 'can' },
  qa: { css: '#d9772f', shirt: '#e38b4f', pants: '#4a4f5c', skin: '#d6a07a', hair: '#3b2a1f', hairStyle: 'bun', prop: 'plant' },
};
const EXTRA_LOOKS = [
  { css: '#c2417a', shirt: '#cf5a90', pants: '#34384a', skin: '#8d5a3b', hair: '#140f0c', hairStyle: 'short', prop: 'server' },
  { css: '#0f8fa3', shirt: '#2aa4b7', pants: '#2f3440', skin: '#e0b08a', hair: '#5a3a22', hairStyle: 'bun', glasses: true, prop: 'plant' },
  { css: '#9a7418', shirt: '#b89335', pants: '#3a3f4a', skin: '#b07650', hair: '#2b2016', hairStyle: 'side', headphones: true, prop: 'can' },
  { css: '#b8452f', shirt: '#cc5e45', pants: '#303542', skin: '#9c6644', hair: '#1c1512', hairStyle: 'curly', glasses: true, prop: 'notes' },
];
// monitor kedua per peran: docs | files | evidence | commands (bisa ditimpa "screen" di config)
function screenFor(r) {
  if (r.screen) return r.screen;
  const k = String(r.key);
  if (/analis-data|data-analyst|penulis|writer/.test(k)) return 'files';
  if (/qa|test|quality|review|pemeriksa|fakta|penyunting|verif/.test(k)) return 'evidence';
  if (/analy|analis|product|pm\b|editor|peneliti|research|riset|pelapor|report|plan/.test(k)) return 'docs';
  if (/devops|ops|infra|sre|deploy|pemantau|monitor|statusline|explore/.test(k)) return 'commands';
  if (/dev|engineer|program|coder|frontend|backend|general|claude/.test(k)) return 'files';
  return 'commands';
}
// warna baju dari warna peran (sedikit lebih terang) untuk peran tanpa gaya khas
function lighten(hex, k = 0.14) {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color('#ffffff'), k);
  return `#${c.getHexString()}`;
}
function deskXs(n) {
  if (n <= 3) return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * 5);
  const step = Math.min(4.3, 11.7 / (n - 1));
  return Array.from({ length: n }, (_, i) => -0.8 + (i - (n - 1) / 2) * step);
}
const XS = deskXs(ROLE_LIST.length);
const DESK_SCALE = ROLE_LIST.length >= 6 ? 0.85 : 1;
const PEOPLE = {};
let extraLook = 0;
ROLE_LIST.forEach((r, i) => {
  const preset = PRESETS[r.key];
  const base = preset || EXTRA_LOOKS[extraLook++ % EXTRA_LOOKS.length];
  const look = { ...base, ...(!preset && r.color ? { shirt: lighten(r.color) } : {}), ...(r.look || {}) };
  const css = r.color || look.css;
  const screen = screenFor(r);
  const prop = r.look?.prop || { docs: 'notes', files: 'can', evidence: 'plant', commands: 'server' }[screen];
  PEOPLE[r.key] = { ...look, key: r.key, name: r.name || r.key, role: r.role || r.key, css, mug: css, deskX: XS[i], screen, prop, asks: !!r.asks };
});
const ROLE_KEYS = Object.keys(PEOPLE);
const ASKER = Object.values(PEOPLE).find((x) => x.asks) || PEOPLE.analyst || Object.values(PEOPLE)[0] || null;
const ASKER_NAME = ASKER ? ASKER.name : 'Tim';
const QA_ROLE = Object.values(PEOPLE).find((x) => x.screen === 'evidence') || null;
const DEV_ROLE = Object.values(PEOPLE).find((x) => x.screen === 'files') || null;
const ORK = CFG.orchestrator || CFG.team?.orkestrator || {};
const RISKO = { key: 'orkestrator', name: ORK.name || 'Orkestrator', role: ORK.role || 'Sesi utama', css: '#7a5cc4', shirt: '#6f5bbd', pants: '#2d3140', skin: '#b97d52', hair: '#221a15', hairStyle: 'side' };
const WHO = { ...PEOPLE, orkestrator: RISKO };
// peran tanpa meja (overflow) tetap bernama & berwarna di feed
let EXTRA_WHO = {};
const whoOf = (role) => WHO[role] || EXTRA_WHO[role] || { key: role, name: String(role), role: '', css: '#9a938a' };
// label kolom/tab "uji" mengikuti peran peninjau di .claude/tim-ai.json (qa → "Uji QA")
const REVIEW_LABEL = TEAM && TEAM.review && TEAM.review !== 'qa' ? 'Direview' : 'Uji QA';
const TODO_STATUS = {
  pending: { label: 'Rencana', css: '#9a938a', note: '#fff1a8', col: 0 },
  in_progress: { label: 'Dikerjakan', css: '#2f9a6d', note: '#c9ecd6', col: 1 },
  completed: { label: 'Selesai', css: '#2f9a6d', note: '#dff1e3', col: 2 },
};
const STATES = {
  bekerja: { label: 'Sedang bekerja', css: '#23a55f' },
  menunggu: { label: 'Menunggu keputusanmu', css: '#c98a00' },
  selesai: { label: 'Selesai', css: '#2f9a6d' },
  siaga: { label: 'Santai', css: '#9a938a' },
  terhenti: { label: 'Terhenti', css: '#d9772f' },
  limit: { label: 'Jeda (limit)', css: '#d64545' },
};
const PLAN_STATUS = {
  draft: { label: 'Draft', css: '#9a938a', col: 0, note: '#fff1a8' },
  blocked: { label: 'Butuh keputusan', css: '#c98a00', col: 0, note: '#ffd98a' },
  approved: { label: 'Disetujui', css: '#3f6fd1', col: 0, note: '#cfe0ff' },
  'in-progress': { label: 'Dikerjakan', css: '#2f9a6d', col: 1, note: '#c9ecd6' },
  'qa-failed': { label: 'Gagal QA', css: '#d64545', col: 1, note: '#ffc9c9' },
  'ready-for-qa': { label: 'Siap QA', css: '#d9772f', col: 2, note: '#ffd8b5' },
  done: { label: 'Selesai', css: '#2f9a6d', col: 3, note: '#dff1e3' },
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmtDate = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtNum = new Intl.NumberFormat('id-ID');
const fmtCompact = new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 });
const hhmmss = (iso) => (iso ? fmtTime.format(new Date(iso)).replace(/\./g, ':') : '');
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'baru saja';
  if (s < 3600) return `${Math.round(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.round(s / 3600)} jam lalu`;
  return fmtDate.format(new Date(iso));
};
const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- renderer
const host = $('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
host.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
$('labels').appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#e9e3da');
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;

const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.1, 120);
const HOME = { pos: new THREE.Vector3(0.6, 8.2, 12.6), target: new THREE.Vector3(0.1, 1.5, -4.0) };
camera.position.copy(HOME.pos);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME.target);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.minDistance = 5;
controls.maxDistance = 32;
controls.minPolarAngle = 0.3;
controls.maxPolarAngle = 1.36;
controls.minAzimuthAngle = -0.75;
controls.maxAzimuthAngle = 1.25;

const hemi = new THREE.HemisphereLight('#fdf7ef', '#c9b9a3', 1.05);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff1dc', 2.3);
sun.position.set(8, 14, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 13, bottom: -13, near: 1, far: 50 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun);

// ---------------------------------------------------------------- bantuan material / mesh / tekstur
const matCache = new Map();
function mat(color, rough = 0.8, metal = 0) {
  const k = `${color}|${rough}|${metal}`;
  if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
  return matCache.get(k);
}
function mesh(geo, material, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}
const box = (w, h, d, r = 0.02) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001));
function canvasTex(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return { canvas: c, ctx: c.getContext('2d'), tex: t };
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function fit(ctx, text, maxW) {
  let t = String(text || '');
  if (ctx.measureText(t).width <= maxW) return t;
  while (t.length && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}
function wrap(ctx, text, x, y, maxW, lh, maxLines) {
  const words = String(text || '').split(/\s+/);
  let line = '';
  let n = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(test).width > maxW && line) {
      n++;
      if (n === maxLines) {
        ctx.fillText(fit(ctx, `${line} ${words.slice(i).join(' ')}`, maxW), x, y);
        return y + lh;
      }
      ctx.fillText(line, x, y);
      y += lh;
      line = words[i];
    } else line = test;
  }
  if (line) ctx.fillText(fit(ctx, line, maxW), x, y);
  return y + lh;
}
const HAND = '"Patrick Hand", "Comic Sans MS", cursive';
const SANS = 'Inter, system-ui, sans-serif';
const MONO = '"JetBrains Mono", Menlo, monospace';

// ---------------------------------------------------------------- ruangan
const ROOM = { x0: -10, x1: 10, z0: -7, z1: 6, h: 5.2 };
(function buildRoom() {
  // lantai kayu
  const fl = canvasTex(1024, 1024);
  const r = rng(11);
  const plankH = 64;
  for (let y = 0; y < 1024; y += plankH) {
    let x = -Math.floor(r() * 300);
    while (x < 1024) {
      const w = 260 + r() * 260;
      const l = 62 + r() * 10;
      fl.ctx.fillStyle = `hsl(${30 + r() * 6}, ${38 + r() * 8}%, ${l}%)`;
      fl.ctx.fillRect(x, y, w, plankH);
      fl.ctx.fillStyle = 'rgba(90,60,30,.10)';
      for (let g = 0; g < 5; g++) fl.ctx.fillRect(x, y + 8 + r() * 48, w, 1.5);
      fl.ctx.fillStyle = 'rgba(70,45,20,.35)';
      fl.ctx.fillRect(x, y, 2, plankH);
      x += w;
    }
    fl.ctx.fillStyle = 'rgba(70,45,20,.35)';
    fl.ctx.fillRect(0, y, 1024, 2);
  }
  fl.tex.wrapS = fl.tex.wrapT = THREE.RepeatWrapping;
  fl.tex.repeat.set(4, 3);
  const W = ROOM.x1 - ROOM.x0;
  const D = ROOM.z1 - ROOM.z0;
  const floor = mesh(new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: fl.tex, roughness: 0.72 }), { cast: false });
  floor.position.set((ROOM.x0 + ROOM.x1) / 2, 0, (ROOM.z0 + ROOM.z1) / 2);
  scene.add(floor);
  const slab = mesh(new THREE.BoxGeometry(W + 0.6, 0.35, D + 0.6), mat('#d8cdbf', 0.9), { cast: false });
  slab.position.set(floor.position.x, -0.18, floor.position.z - 0.15);
  scene.add(slab);
  // dinding belakang & kiri (potongan diorama)
  const wallM = mat('#f1ebe2', 0.95);
  const back = mesh(new THREE.BoxGeometry(W + 0.6, ROOM.h, 0.3), wallM, { cast: false });
  back.position.set(floor.position.x, ROOM.h / 2, ROOM.z0 - 0.15);
  const left = mesh(new THREE.BoxGeometry(0.3, ROOM.h, D + 0.3), wallM, { cast: false });
  left.position.set(ROOM.x0 - 0.15, ROOM.h / 2, floor.position.z - 0.15);
  scene.add(back, left);
  const baseM = mat('#d6cbbb', 0.8);
  const bb1 = mesh(new THREE.BoxGeometry(W, 0.14, 0.04), baseM);
  bb1.position.set(floor.position.x, 0.07, ROOM.z0 + 0.02);
  const bb2 = mesh(new THREE.BoxGeometry(0.04, 0.14, D), baseM);
  bb2.position.set(ROOM.x0 + 0.02, 0.07, floor.position.z);
  scene.add(bb1, bb2);
  // aksen dinding kiri bawah (wainscot)
  const wain = mesh(new THREE.BoxGeometry(0.03, 1.0, D), mat('#e4d9c9', 0.9), { cast: false });
  wain.position.set(ROOM.x0 + 0.02, 0.5, floor.position.z);
  scene.add(wain);
})();

// jendela dengan langit (siang/malam mengikuti jam asli)
const windows = [];
function buildWindow(cx, cy, w, h) {
  const sky = canvasTex(256, 256);
  const glass = mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: sky.tex, toneMapped: false }), { cast: false });
  glass.position.set(cx, cy, ROOM.z0 + 0.02);
  scene.add(glass);
  const frameM = mat('#fbfaf7', 0.6);
  const t = 0.08;
  const parts = [
    [w + t * 2, t, cx, cy + h / 2], [w + t * 2, t, cx, cy - h / 2], [t, h, cx - w / 2, cy], [t, h, cx + w / 2, cy], [t * 0.6, h, cx, cy], [w, t * 0.6, cx, cy + h * 0.15],
  ];
  for (const [pw, ph, px, py] of parts) {
    const f = mesh(new THREE.BoxGeometry(pw, ph, 0.08), frameM);
    f.position.set(px, py, ROOM.z0 + 0.05);
    scene.add(f);
  }
  const sill = mesh(box(w + 0.3, 0.06, 0.26), frameM);
  sill.position.set(cx, cy - h / 2 - 0.05, ROOM.z0 + 0.13);
  scene.add(sill);
  windows.push(sky);
}
buildWindow(3.5, 2.75, 2.0, 2.0);
buildWindow(6.3, 2.75, 2.0, 2.0);
function paintSky(night) {
  for (const s of windows) {
    const g = s.ctx.createLinearGradient(0, 0, 0, 256);
    if (night) {
      g.addColorStop(0, '#1d2745');
      g.addColorStop(1, '#3a3f63');
    } else {
      g.addColorStop(0, '#9fd0f5');
      g.addColorStop(1, '#e7f3fb');
    }
    s.ctx.fillStyle = g;
    s.ctx.fillRect(0, 0, 256, 256);
    // siluet gedung kota
    const r = rng(5);
    for (let x = 0; x < 256; x += 22 + r() * 18) {
      const bh = 40 + r() * 90;
      s.ctx.fillStyle = night ? '#2b3150' : '#c9d9e6';
      s.ctx.fillRect(x, 256 - bh, 20 + r() * 14, bh);
      if (night) {
        s.ctx.fillStyle = '#ffd98a';
        for (let k = 0; k < 6; k++) if (r() > 0.5) s.ctx.fillRect(x + 4 + r() * 12, 256 - bh + 8 + r() * (bh - 16), 3, 4);
      }
    }
    s.tex.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- perabot
function plant(x, z, s = 1, seed = 1) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(s);
  const pot = mesh(new THREE.CylinderGeometry(0.26, 0.2, 0.42, 24), mat('#c8744b', 0.85));
  pot.position.y = 0.21;
  const soil = mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.02, 24), mat('#4a3526', 1));
  soil.position.y = 0.41;
  g.add(pot, soil);
  const r = rng(seed);
  const greens = ['#3f8f4f', '#4fa35d', '#367a45', '#5cae66'];
  for (let i = 0; i < 11; i++) {
    const leaf = mesh(new THREE.SphereGeometry(0.1, 12, 8), mat(greens[i % greens.length], 0.7));
    leaf.scale.set(1, 3.4 + r() * 1.6, 0.35);
    const a = (i / 11) * Math.PI * 2 + r() * 0.4;
    const tilt = 0.35 + r() * 0.45;
    leaf.position.set(Math.sin(a) * 0.12, 0.72 + r() * 0.2, Math.cos(a) * 0.12);
    leaf.rotation.set(Math.cos(a) * tilt, 0, -Math.sin(a) * tilt);
    g.add(leaf);
  }
  scene.add(g);
  return g;
}
function bookshelf(x, z, rotY) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  const wood = mat('#b98b5e', 0.7);
  const W = 1.8;
  const H = 2.1;
  const D = 0.38;
  for (const [w, h, d, px, py] of [[W, 0.05, D, 0, H], [W, 0.05, D, 0, 0.03], [0.05, H, D, -W / 2, H / 2], [0.05, H, D, W / 2, H / 2], [W, H, 0.02, 0, H / 2]]) {
    const p = mesh(new THREE.BoxGeometry(w, h, d), wood);
    p.position.set(px, py, d === 0.02 ? -D / 2 : 0);
    g.add(p);
  }
  const r = rng(3);
  const cols = ['#3f6fd1', '#d9772f', '#2f9a6d', '#7a5cc4', '#c94f4f', '#e2c16b', '#5d6b82', '#f0ece4'];
  for (let s = 0; s < 4; s++) {
    const y = 0.08 + s * 0.52;
    if (s > 0) {
      const shelf = mesh(new THREE.BoxGeometry(W - 0.06, 0.03, D - 0.02), wood);
      shelf.position.set(0, y - 0.03, 0);
      g.add(shelf);
    }
    let bx = -W / 2 + 0.08;
    while (bx < W / 2 - 0.2) {
      const bw = 0.05 + r() * 0.07;
      const bh = 0.28 + r() * 0.14;
      if (r() > 0.88) {
        bx += 0.18;
        continue;
      }
      const b = mesh(new THREE.BoxGeometry(bw, bh, 0.24), mat(cols[Math.floor(r() * cols.length)], 0.8));
      b.position.set(bx + bw / 2, y + bh / 2, 0.02);
      b.rotation.z = r() > 0.92 ? 0.2 : 0;
      g.add(b);
      bx += bw + 0.01;
    }
  }
  scene.add(g);
}
function officeChair(color = '#3a3f4a') {
  const g = new THREE.Group();
  const seatM = mat(color, 0.75);
  const dark = mat('#2a2d33', 0.5, 0.3);
  const seat = mesh(box(0.52, 0.09, 0.5, 0.04), seatM);
  seat.position.y = 0.48;
  const backrest = mesh(box(0.48, 0.58, 0.08, 0.04), seatM);
  backrest.position.set(0, 0.86, -0.25);
  backrest.rotation.x = -0.08;
  const post = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.34, 10), dark);
  post.position.y = 0.27;
  g.add(seat, backrest, post);
  for (const s of [-1, 1]) {
    const arm = mesh(box(0.05, 0.05, 0.3, 0.02), dark);
    arm.position.set(s * 0.28, 0.68, -0.02);
    const armPost = mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.18, 8), dark);
    armPost.position.set(s * 0.28, 0.58, -0.1);
    g.add(arm, armPost);
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leg = mesh(new THREE.BoxGeometry(0.04, 0.03, 0.3), dark);
    leg.position.set(Math.sin(a) * 0.15, 0.08, Math.cos(a) * 0.15);
    leg.rotation.y = a;
    const wheel = mesh(new THREE.SphereGeometry(0.035, 10, 8), dark);
    wheel.position.set(Math.sin(a) * 0.3, 0.035, Math.cos(a) * 0.3);
    g.add(leg, wheel);
  }
  return g;
}
function mugMesh(color) {
  const g = new THREE.Group();
  const cup = mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.11, 18), mat(color, 0.5));
  cup.position.y = 0.055;
  const handle = mesh(new THREE.TorusGeometry(0.03, 0.009, 8, 16), mat(color, 0.5));
  handle.position.set(0.055, 0.06, 0);
  handle.rotation.y = Math.PI / 2;
  const coffee = mesh(new THREE.CylinderGeometry(0.044, 0.044, 0.005, 16), mat('#4b2e1c', 0.4));
  coffee.position.y = 0.105;
  g.add(cup, handle, coffee);
  return g;
}

// mesin kopi espresso + grinder
function espressoMachine(x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = -Math.PI / 2;
  const steel = mat('#b9bec6', 0.25, 0.85);
  const dark = mat('#26282d', 0.4, 0.3);
  const body = mesh(box(0.62, 0.42, 0.42, 0.04), steel);
  body.position.y = 0.36;
  const top = mesh(box(0.64, 0.05, 0.44, 0.02), dark);
  top.position.y = 0.6;
  const base = mesh(box(0.62, 0.1, 0.46, 0.02), dark);
  base.position.y = 0.05;
  const tray = mesh(box(0.5, 0.02, 0.2, 0.005), mat('#9aa0a8', 0.3, 0.8));
  tray.position.set(0, 0.11, 0.2);
  const group = mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 16), steel);
  group.position.set(-0.12, 0.22, 0.24);
  const handle = mesh(new THREE.CapsuleGeometry(0.014, 0.16, 4, 8), dark);
  handle.rotation.x = Math.PI / 2;
  handle.position.set(-0.12, 0.2, 0.36);
  const wand = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.22, 8), steel);
  wand.position.set(0.22, 0.22, 0.24);
  wand.rotation.z = 0.2;
  const gauge = mesh(new THREE.CircleGeometry(0.035, 20), mat('#fbfaf7', 0.4));
  gauge.position.set(0.12, 0.42, 0.212);
  const cup = mugMesh('#ffffff');
  cup.scale.setScalar(0.7);
  cup.position.set(-0.12, 0.12, 0.2);
  g.add(body, top, base, tray, group, handle, wand, gauge, cup);
  // grinder biji kopi
  const grinder = new THREE.Group();
  grinder.position.set(0.5, 0, 0);
  const gb = mesh(box(0.16, 0.3, 0.2, 0.03), dark);
  gb.position.y = 0.15;
  const hopper = mesh(new THREE.CylinderGeometry(0.09, 0.05, 0.18, 18), new THREE.MeshStandardMaterial({ color: '#c8a27a', transparent: true, opacity: 0.55, roughness: 0.1 }));
  hopper.position.y = 0.39;
  const beans = mesh(new THREE.CylinderGeometry(0.07, 0.05, 0.1, 18), mat('#4b2e1c', 0.8));
  beans.position.y = 0.36;
  grinder.add(gb, beans, hopper);
  g.add(grinder);
  return g;
}
// dispenser air galon
function waterDispenser(x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = -Math.PI / 2;
  const white = mat('#f4f3ef', 0.5);
  const body = mesh(box(0.36, 1.0, 0.36, 0.04), white);
  body.position.y = 0.5;
  const panel = mesh(box(0.26, 0.2, 0.02, 0.01), mat('#d9dde3', 0.4));
  panel.position.set(0, 0.82, 0.18);
  const recess = mesh(box(0.24, 0.26, 0.04, 0.01), mat('#c9ccd2', 0.5));
  recess.position.set(0, 0.55, 0.17);
  const tapHot = mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 10), mat('#d64545', 0.4));
  tapHot.position.set(-0.06, 0.63, 0.2);
  tapHot.rotation.x = Math.PI / 2;
  const tapCold = mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 10), mat('#3f6fd1', 0.4));
  tapCold.position.set(0.06, 0.63, 0.2);
  tapCold.rotation.x = Math.PI / 2;
  const bottle = mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.42, 24), new THREE.MeshStandardMaterial({ color: '#8fc6f0', transparent: true, opacity: 0.55, roughness: 0.05 }));
  bottle.position.y = 1.23;
  const neck = mesh(new THREE.CylinderGeometry(0.05, 0.09, 0.08, 16), new THREE.MeshStandardMaterial({ color: '#8fc6f0', transparent: true, opacity: 0.6, roughness: 0.05 }));
  neck.position.y = 1.0;
  const water = mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.3, 24), new THREE.MeshStandardMaterial({ color: '#5aa6e0', transparent: true, opacity: 0.45 }));
  water.position.y = 1.17;
  const cups = mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.2, 12), mat('#ffffff', 0.6));
  cups.position.set(0.22, 0.75, 0);
  g.add(body, panel, recess, tapHot, tapCold, water, bottle, neck, cups);
  return g;
}
// stik PS generik
function gamepad(color) {
  const g = new THREE.Group();
  const shell = mat(color, 0.35);
  const accent = mat(color === '#1d1f24' ? '#3a3d44' : '#1d1f24', 0.4);
  const body = mesh(box(0.16, 0.035, 0.08, 0.015), shell);
  g.add(body);
  for (const s of [-1, 1]) {
    const grip = mesh(new THREE.CapsuleGeometry(0.024, 0.05, 4, 10), shell);
    grip.rotation.x = Math.PI / 2 - 0.25;
    grip.rotation.z = s * 0.35;
    grip.position.set(s * 0.065, -0.008, 0.045);
    const stick = mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.018, 12), accent);
    stick.position.set(s * 0.03, 0.025, 0.02);
    g.add(grip, stick);
  }
  const pad = mesh(box(0.06, 0.006, 0.03, 0.003), accent);
  pad.position.set(0, 0.02, -0.012);
  g.add(pad);
  return g;
}
// TV + meja TV + konsol game (generik) + layar streaming (merek fiktif)
const tvScreen = canvasTex(1280, 720);
function drawTv() {
  const { ctx, tex } = tvScreen;
  const W = 1280;
  const H = 720;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#141414');
  g.addColorStop(1, '#231515');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e50914';
  ctx.font = `800 58px ${SANS}`;
  ctx.fillText('TONTON', 48, 84);
  ctx.fillStyle = '#d0d0d0';
  ctx.font = `500 24px ${SANS}`;
  ['Beranda', 'Serial', 'Film', 'Daftar Saya'].forEach((t, i) => ctx.fillText(t, 330 + i * 150, 76));
  const hero = ctx.createLinearGradient(0, 120, 0, 460);
  hero.addColorStop(0, '#3a1f4f');
  hero.addColorStop(1, '#141414');
  ctx.fillStyle = hero;
  ctx.fillRect(48, 120, W - 96, 320);
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 64px ${SANS}`;
  ctx.fillText('Jejak Rempah', 90, 260);
  ctx.font = `500 26px ${SANS}`;
  ctx.fillStyle = '#e6e6e6';
  ctx.fillText('Serial dokumenter · Musim 2 · Episode baru tiap Jumat', 90, 306);
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 90, 340, 170, 58, 8);
  ctx.fill();
  ctx.fillStyle = '#141414';
  ctx.font = `700 26px ${SANS}`;
  ctx.fillText('▶  Putar', 118, 378);
  ctx.fillStyle = 'rgba(120,120,120,.7)';
  roundRect(ctx, 280, 340, 220, 58, 8);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText('ⓘ  Info lanjut', 304, 378);
  ctx.fillStyle = '#e6e6e6';
  ctx.font = `700 26px ${SANS}`;
  ctx.fillText('Lanjutkan menonton', 48, 494);
  const tiles = ['#7a3b2e', '#2e5a7a', '#5a7a2e', '#6f5bbd', '#b8862b', '#2e7a6a'];
  tiles.forEach((c, i) => {
    const tx = 48 + i * 200;
    const tg = ctx.createLinearGradient(tx, 510, tx + 186, 690);
    tg.addColorStop(0, c);
    tg.addColorStop(1, '#141414');
    ctx.fillStyle = tg;
    roundRect(ctx, tx, 512, 186, 150, 8);
    ctx.fill();
    ctx.fillStyle = '#e50914';
    ctx.fillRect(tx, 656, 60 + ((i * 37) % 110), 5);
  });
  tex.needsUpdate = true;
}
function tvCorner(x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const wood = mat('#7a5a40', 0.6);
  const stand = mesh(box(2.2, 0.45, 0.45, 0.03), wood);
  stand.position.y = 0.225;
  const doors = mesh(box(2.1, 0.3, 0.02, 0.01), mat('#8c6a4f', 0.5));
  doors.position.set(0, 0.23, 0.23);
  const tvBody = mesh(box(1.78, 1.02, 0.05, 0.02), mat('#111215', 0.35, 0.2));
  tvBody.position.set(0, 1.12, -0.02);
  const scr = mesh(new THREE.PlaneGeometry(1.72, 0.97), new THREE.MeshBasicMaterial({ map: tvScreen.tex, toneMapped: false }), { cast: false });
  scr.position.set(0, 1.12, 0.006);
  const neck = mesh(box(0.08, 0.16, 0.06, 0.01), mat('#2a2c31', 0.4, 0.4));
  neck.position.set(0, 0.54, -0.02);
  const foot = mesh(box(0.5, 0.02, 0.22, 0.01), mat('#2a2c31', 0.4, 0.4));
  foot.position.set(0, 0.46, 0);
  const glow = new THREE.PointLight('#8f6bd8', 1.2, 3, 2);
  glow.position.set(0, 1.1, 0.6);
  g.add(stand, doors, tvBody, scr, neck, foot, glow);
  // konsol putih berdiri (generik, tanpa logo)
  const ps = new THREE.Group();
  ps.position.set(0.82, 0.45, 0.02);
  const shellL = mesh(box(0.05, 0.4, 0.26, 0.02), mat('#f4f4f6', 0.35));
  shellL.position.set(-0.035, 0.2, 0);
  const core = mesh(box(0.04, 0.38, 0.24, 0.01), mat('#1d1f24', 0.4));
  core.position.set(0, 0.2, 0);
  const shellR = mesh(box(0.05, 0.4, 0.26, 0.02), mat('#f4f4f6', 0.35));
  shellR.position.set(0.035, 0.2, 0);
  const led = mesh(box(0.004, 0.3, 0.004, 0.001), new THREE.MeshBasicMaterial({ color: '#6fb6ff', toneMapped: false }));
  led.position.set(0, 0.22, 0.125);
  ps.add(shellL, core, shellR, led);
  g.add(ps);
  // speaker soundbar
  const bar = mesh(box(1.0, 0.07, 0.1, 0.03), mat('#1d1f24', 0.5));
  bar.position.set(0, 0.49, 0.12);
  g.add(bar);
  return g;
}
drawTv();

const LOUNGE_PADS = [];
// kopi & meja rapat
(function buildFurniture() {
  bookshelf(ROOM.x0 + 0.25, 3.8, Math.PI / 2);
  plant(ROOM.x0 + 0.6, ROOM.z0 + 0.6, 1.25, 2);
  plant(6.6, ROOM.z0 + 0.6, 1.0, 4);
  plant(ROOM.x0 + 0.6, 1.2, 1.0, 6);
  plant(ROOM.x1 - 0.7, 5.2, 1.3, 8);
  // pojok kopi di sudut kanan belakang (menempel dinding belakang)
  const counter = mesh(box(2.4, 0.95, 0.9, 0.03), mat('#ece5da', 0.7));
  counter.position.set(8.2, 0.475, ROOM.z0 + 0.55);
  const top = mesh(box(2.5, 0.05, 0.98, 0.02), mat('#8c6a4f', 0.5));
  top.position.set(8.2, 0.97, ROOM.z0 + 0.55);
  const shelf = mesh(box(1.6, 0.04, 0.3, 0.01), mat('#8c6a4f', 0.5));
  shelf.position.set(8.2, 1.75, ROOM.z0 + 0.18);
  scene.add(counter, top, shelf);
  const esp = espressoMachine(7.7, 0.995, ROOM.z0 + 0.55);
  esp.rotation.y = 0;
  scene.add(esp);
  const disp = waterDispenser(ROOM.x1 - 0.45, 0, ROOM.z0 + 1.55);
  disp.rotation.y = -Math.PI / 2;
  scene.add(disp);
  [['#e8e2d6', 8.85], ['#3f6fd1', 9.1], ['#d9772f', 8.6]].forEach(([c, x]) => {
    const m = mugMesh(c);
    m.position.set(x, 0.995, ROOM.z0 + 0.7);
    scene.add(m);
    const sm = mugMesh(c);
    sm.position.set(x - 0.9, 1.77, ROOM.z0 + 0.18);
    scene.add(sm);
  });
  // karpet + meja rapat bundar
  const rug = mesh(new THREE.CircleGeometry(2.3, 48).rotateX(-Math.PI / 2), mat('#cdbba4', 1), { cast: false });
  rug.position.set(-5.0, 0.01, 0.9);
  scene.add(rug);
  const tbl = mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.05, 40), mat('#e9e2d6', 0.5));
  tbl.position.set(-5.0, 0.74, 0.9);
  const leg = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.72, 12), mat('#8a8f98', 0.4, 0.6));
  leg.position.set(-5.0, 0.37, 0.9);
  const foot = mesh(new THREE.CylinderGeometry(0.4, 0.45, 0.04, 24), mat('#8a8f98', 0.4, 0.6));
  foot.position.set(-5.0, 0.02, 0.9);
  scene.add(tbl, leg, foot);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.6;
    const c = officeChair('#b9a58c');
    c.position.set(-5.0 + Math.sin(a) * 1.35, 0, 0.9 + Math.cos(a) * 1.35);
    c.rotation.y = a + Math.PI;
    scene.add(c);
  }
  // sudut santai: sofa + meja kopi
  const lounge = new THREE.Group();
  lounge.position.set(4.9, 0, 1.45);
  lounge.rotation.y = Math.PI;
  const fabric = mat('#6f8f86', 0.95);
  const sofaBase = mesh(box(2.6, 0.42, 0.95, 0.12), fabric);
  sofaBase.position.set(0, 0.3, 0);
  const sofaBack = mesh(box(2.6, 0.62, 0.25, 0.1), fabric);
  sofaBack.position.set(0, 0.7, -0.38);
  lounge.add(sofaBase, sofaBack);
  for (const s of [-1, 1]) {
    const armR = mesh(box(0.24, 0.55, 0.95, 0.1), fabric);
    armR.position.set(s * 1.32, 0.45, 0);
    const cushion = mesh(box(1.18, 0.14, 0.72, 0.07), mat('#7fa198', 0.95));
    cushion.position.set(s * 0.6, 0.57, 0.08);
    lounge.add(armR, cushion);
  }
  const pillow = mesh(box(0.42, 0.36, 0.14, 0.07), mat('#e2c16b', 0.9));
  pillow.position.set(-0.85, 0.78, -0.18);
  pillow.rotation.set(-0.2, 0.3, 0.15);
  lounge.add(pillow);
  const low = mesh(box(1.2, 0.06, 0.6, 0.03), mat('#8c6a4f', 0.5));
  low.position.set(0, 0.42, 1.05);
  lounge.add(low);
  for (const [lx, lz] of [[-0.5, 0.8], [0.5, 0.8], [-0.5, 1.3], [0.5, 1.3]]) {
    const lg = mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.4, 8), mat('#3a3d44', 0.4, 0.5));
    lg.position.set(lx, 0.2, lz);
    lounge.add(lg);
  }
  const magazine = mesh(box(0.32, 0.015, 0.24, 0.005), mat('#d9772f', 0.8));
  magazine.position.set(-0.2, 0.46, 1.0);
  magazine.rotation.y = 0.3;
  const loungeMug = mugMesh('#f0ece4');
  loungeMug.position.set(0.3, 0.45, 1.1);
  lounge.add(magazine, loungeMug);
  const loungeRug = mesh(new THREE.PlaneGeometry(3.4, 2.4).rotateX(-Math.PI / 2), mat('#d9cbb5', 1), { cast: false });
  loungeRug.position.set(0, 0.012, 0.6);
  lounge.add(loungeRug);
  // dua stik PS di meja kopi (koordinat lokal lounge: meja di z 1.05)
  const pad1 = gamepad('#f4f4f6');
  pad1.position.set(-0.35, 0.47, 1.05);
  pad1.rotation.y = 0.5;
  const pad2 = gamepad('#1d1f24');
  pad2.position.set(0.1, 0.47, 0.95);
  pad2.rotation.y = -0.3;
  lounge.add(pad1, pad2);
  LOUNGE_PADS.push(pad1, pad2);
  scene.add(lounge);
  scene.add(tvCorner(4.9, 0, -1.3));
  plant(7.3, 1.9, 0.9, 14);
  const laptop = new THREE.Group();
  const lb = mesh(box(0.42, 0.02, 0.3, 0.01), mat('#c9ccd2', 0.3, 0.7));
  const ls = mesh(box(0.42, 0.28, 0.015, 0.01), mat('#c9ccd2', 0.3, 0.7));
  ls.position.set(0, 0.14, -0.15);
  ls.rotation.x = -0.25;
  laptop.add(lb, ls);
  laptop.position.set(-4.8, 0.78, 0.8);
  laptop.rotation.y = 0.4;
  scene.add(laptop);
})();

// ---------------------------------------------------------------- papan di dinding
function wallBoard({ w, h, cw, ch, pos, rotY, frame = '#b9bec6', corkish = false }) {
  const g = new THREE.Group();
  g.position.copy(pos);
  g.rotation.y = rotY;
  const t = canvasTex(cw, ch);
  const face = mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: t.tex, roughness: corkish ? 0.95 : 0.35 }), { cast: false });
  face.position.z = 0.03;
  g.add(face);
  const fm = mat(frame, 0.4, corkish ? 0 : 0.5);
  for (const [fw, fh, px, py] of [[w + 0.1, 0.06, 0, h / 2], [w + 0.1, 0.06, 0, -h / 2], [0.06, h, -w / 2, 0], [0.06, h, w / 2, 0]]) {
    const f = mesh(new THREE.BoxGeometry(fw, fh, 0.06), fm);
    f.position.set(px, py, 0.03);
    g.add(f);
  }
  if (!corkish) {
    const tray = mesh(box(w * 0.5, 0.05, 0.1, 0.02), fm);
    tray.position.set(0, -h / 2 - 0.05, 0.08);
    g.add(tray);
    ['#2f5bd3', '#d64545', '#23a55f'].forEach((c, i) => {
      const mk = mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.14, 8), mat(c, 0.5));
      mk.rotation.z = Math.PI / 2;
      mk.position.set(-0.3 + i * 0.22, -h / 2 - 0.02, 0.1);
      g.add(mk);
    });
  }
  scene.add(g);
  return t;
}
const kanban = wallBoard({ w: 6.4, h: 2.6, cw: 2048, ch: 832, pos: new THREE.Vector3(-1.4, 2.75, ROOM.z0 + 0.02), rotY: 0 });
const roadmapBoard = wallBoard({ w: 4.6, h: 2.4, cw: 2048, ch: 1068, pos: new THREE.Vector3(-7.4, 2.75, ROOM.z0 + 0.02), rotY: 0 });
const cork = wallBoard({ w: 2.6, h: 2.1, cw: 1200, ch: 970, pos: new THREE.Vector3(ROOM.x0 + 0.02, 2.6, -3.4), rotY: Math.PI / 2, frame: '#9b7b58', corkish: true });

// jam dinding (waktu asli)
const clockTex = canvasTex(256, 256);
(function buildClock() {
  const face = mesh(new THREE.CircleGeometry(0.42, 48), new THREE.MeshStandardMaterial({ map: clockTex.tex, roughness: 0.4 }), { cast: false });
  face.position.set(8.6, 3.4, ROOM.z0 + 0.05);
  const rim = mesh(new THREE.TorusGeometry(0.43, 0.035, 10, 48), mat('#3a3d44', 0.4, 0.4));
  rim.position.copy(face.position);
  scene.add(face, rim);
})();
function drawClock() {
  const { ctx, tex } = clockTex;
  const now = new Date();
  ctx.fillStyle = '#fbfaf7';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#3a3d44';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.save();
    ctx.translate(128, 128);
    ctx.rotate(a);
    ctx.fillRect(-3, -118, 6, i % 3 ? 14 : 24);
    ctx.restore();
  }
  const hand = (a, len, w, c) => {
    ctx.save();
    ctx.translate(128, 128);
    ctx.rotate(a);
    ctx.fillStyle = c;
    ctx.fillRect(-w / 2, -len, w, len + 12);
    ctx.restore();
  };
  const h = now.getHours() % 12;
  const m = now.getMinutes();
  const s = now.getSeconds();
  hand(((h + m / 60) / 12) * Math.PI * 2, 62, 9, '#2b2a28');
  hand(((m + s / 60) / 60) * Math.PI * 2, 92, 6, '#2b2a28');
  hand((s / 60) * Math.PI * 2, 100, 2, '#d64545');
  ctx.fillStyle = '#d64545';
  ctx.beginPath();
  ctx.arc(128, 128, 7, 0, Math.PI * 2);
  ctx.fill();
  tex.needsUpdate = true;
}

// ---------------------------------------------------------------- karakter orang
function buildPerson(cfg, seated) {
  const root = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = seated ? 0.57 : 0.9;
  root.add(hips);
  const pantsM = mat(cfg.pants, 0.85);
  const shirtM = mat(cfg.shirt, 0.8);
  const skinM = mat(cfg.skin, 0.6);
  const hairM = mat(cfg.hair, 0.75);
  const shoeM = mat('#2b2622', 0.55);
  const dark = mat('#231c18', 0.4);
  const tag = (m) => {
    m.userData.role = cfg.key;
    return m;
  };
  hips.add(tag(mesh(box(0.34, 0.17, 0.22, 0.07), pantsM)));
  const spine = new THREE.Group();
  spine.position.y = 0.06;
  hips.add(spine);
  const torso = tag(mesh(new THREE.CapsuleGeometry(0.16, 0.26, 6, 18), shirtM));
  torso.scale.set(1.14, 1, 0.74);
  torso.position.y = 0.25;
  spine.add(torso);
  if (cfg.headphones) {
    const hood = mesh(new THREE.TorusGeometry(0.1, 0.035, 10, 20), shirtM);
    hood.position.set(0, 0.5, -0.08);
    hood.rotation.x = 1.2;
    spine.add(hood);
  } else {
    const collar = mesh(new THREE.TorusGeometry(0.07, 0.022, 8, 18, Math.PI * 1.3), mat('#ffffff', 0.7));
    collar.position.set(0, 0.5, 0.01);
    collar.rotation.set(Math.PI / 2 - 0.2, 0, Math.PI * 0.85);
    spine.add(collar);
  }
  const neck = mesh(new THREE.CylinderGeometry(0.048, 0.055, 0.1, 12), skinM);
  neck.position.y = 0.53;
  spine.add(neck);
  const head = new THREE.Group();
  head.position.y = 0.67;
  spine.add(head);
  const R = 0.128;
  const skull = tag(mesh(new THREE.SphereGeometry(R, 32, 24), skinM));
  skull.scale.set(1, 1.1, 1.02);
  head.add(skull);
  for (const s of [-1, 1]) {
    const eye = mesh(new THREE.SphereGeometry(0.016, 10, 8), dark);
    eye.position.set(s * 0.046, 0.012, R * 0.93);
    const brow = mesh(box(0.04, 0.008, 0.01, 0.003), hairM);
    brow.position.set(s * 0.047, 0.045, R * 0.96);
    const ear = mesh(new THREE.SphereGeometry(0.03, 10, 8), skinM);
    ear.scale.set(0.6, 1, 0.8);
    ear.position.set(s * R * 0.98, 0, 0);
    head.add(eye, brow, ear);
  }
  const nose = mesh(new THREE.SphereGeometry(0.018, 10, 8), skinM);
  nose.position.set(0, -0.012, R * 1.02);
  const mouth = mesh(new THREE.TorusGeometry(0.022, 0.005, 6, 12, Math.PI), mat('#7a3b2e', 0.6));
  mouth.position.set(0, -0.055, R * 0.93);
  mouth.rotation.z = Math.PI;
  head.add(nose, mouth);
  // rambut
  const cap = mesh(new THREE.SphereGeometry(R * 1.07, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.52), hairM);
  cap.position.set(0, 0.012, -0.012);
  cap.scale.set(1, 1.1, 1.04);
  head.add(cap);
  if (cfg.hairStyle === 'short' || cfg.hairStyle === 'side') {
    const backHair = mesh(new THREE.SphereGeometry(R * 1.04, 20, 14, Math.PI * 0.55, Math.PI * 0.9, Math.PI * 0.3, Math.PI * 0.35), hairM);
    backHair.position.y = -0.01;
    head.add(backHair);
    if (cfg.hairStyle === 'side') {
      const part = mesh(box(0.1, 0.03, 0.06, 0.012), hairM);
      part.position.set(0.05, 0.1, 0.08);
      part.rotation.z = -0.25;
      head.add(part);
    }
  } else if (cfg.hairStyle === 'curly') {
    const r = rng(9);
    for (let i = 0; i < 16; i++) {
      const c = mesh(new THREE.SphereGeometry(0.038, 10, 8), hairM);
      const a = r() * Math.PI * 2;
      const up = 0.3 + r() * 0.6;
      c.position.set(Math.sin(a) * R * 0.9 * Math.cos(up), R * 0.55 + Math.sin(up) * 0.06, Math.cos(a) * R * 0.85 * Math.cos(up) - 0.015);
      head.add(c);
    }
  } else if (cfg.hairStyle === 'bun') {
    const long = mesh(new THREE.CylinderGeometry(R * 1.02, R * 1.1, 0.26, 20, 1, true, Math.PI * 0.62, Math.PI * 0.76), hairM);
    long.material = hairM;
    long.position.y = -0.08;
    const bun = mesh(new THREE.SphereGeometry(0.058, 14, 10), hairM);
    bun.position.set(0, 0.12, -0.1);
    const fringe = mesh(new THREE.SphereGeometry(R * 1.05, 20, 10, Math.PI * 1.7, Math.PI * 0.6, 0.2, 0.55), hairM);
    head.add(long, bun, fringe);
    hairM.side = THREE.DoubleSide;
  }
  if (cfg.glasses) {
    const gm = mat('#1f2328', 0.3, 0.4);
    for (const s of [-1, 1]) {
      const ring = mesh(new THREE.TorusGeometry(0.03, 0.005, 8, 20), gm);
      ring.position.set(s * 0.047, 0.012, R * 1.01);
      head.add(ring);
    }
    const bridge = mesh(new THREE.BoxGeometry(0.03, 0.005, 0.005), gm);
    bridge.position.set(0, 0.015, R * 1.03);
    head.add(bridge);
  }
  if (cfg.headphones) {
    const hm = mat('#2b2f36', 0.45, 0.2);
    const band = mesh(new THREE.TorusGeometry(R * 1.12, 0.014, 8, 28, Math.PI), hm);
    band.position.y = 0.01;
    head.add(band);
    for (const s of [-1, 1]) {
      const cup = mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.035, 16), mat('#3a9b72', 0.5));
      cup.rotation.z = Math.PI / 2;
      cup.position.set(s * R * 1.05, 0, 0);
      head.add(cup);
    }
  }
  // lengan
  const sh = [];
  const el = [];
  const hand = [];
  for (const s of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(s * 0.2, 0.44, 0);
    spine.add(shoulder);
    const upper = tag(mesh(new THREE.CapsuleGeometry(0.05, 0.19, 4, 12), shirtM));
    upper.position.y = -0.14;
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.29;
    shoulder.add(elbow);
    const fore = tag(mesh(new THREE.CapsuleGeometry(0.043, 0.17, 4, 12), shirtM));
    fore.position.y = -0.12;
    elbow.add(fore);
    const h = mesh(new THREE.SphereGeometry(0.047, 12, 10), skinM);
    h.position.y = -0.26;
    h.scale.set(0.9, 1.1, 0.7);
    elbow.add(h);
    sh.push(shoulder);
    el.push(elbow);
    hand.push(h);
  }
  // kaki
  const hip = [];
  const knee = [];
  for (const s of [-1, 1]) {
    const hp = new THREE.Group();
    hp.position.set(s * 0.095, -0.03, 0);
    hips.add(hp);
    const thigh = tag(mesh(new THREE.CapsuleGeometry(0.068, 0.26, 4, 12), pantsM));
    thigh.position.y = -0.2;
    hp.add(thigh);
    const kn = new THREE.Group();
    kn.position.y = -0.41;
    hp.add(kn);
    const shin = mesh(new THREE.CapsuleGeometry(0.058, 0.27, 4, 12), pantsM);
    shin.position.y = -0.18;
    kn.add(shin);
    const foot = mesh(box(0.11, 0.07, 0.23, 0.03), shoeM);
    foot.position.set(0, -0.4, 0.05);
    kn.add(foot);
    hip.push(hp);
    knee.push(kn);
  }
  return { root, hips, spine, head, sh, el, hand, hip, knee, cfg, nod: 0 };
}
const lerpK = (a, b, k) => a + (b - a) * k;
function applyPose(p, T, dt) {
  const k = Math.min(1, dt * 7);
  p.spine.rotation.x = lerpK(p.spine.rotation.x, T.spineX ?? 0, k);
  p.spine.rotation.z = lerpK(p.spine.rotation.z, T.spineZ ?? 0, k);
  p.head.rotation.x = lerpK(p.head.rotation.x, (T.headX ?? 0) + p.nod, k * 1.4);
  p.head.rotation.y = lerpK(p.head.rotation.y, T.headY ?? 0, k);
  p.head.rotation.z = lerpK(p.head.rotation.z, T.headZ ?? 0, k);
  const side = ['l', 'r'];
  for (let i = 0; i < 2; i++) {
    const s = side[i];
    p.sh[i].rotation.x = lerpK(p.sh[i].rotation.x, T[`${s}ShX`] ?? 0, k);
    p.sh[i].rotation.z = lerpK(p.sh[i].rotation.z, T[`${s}ShZ`] ?? (i ? -0.08 : 0.08), k);
    p.el[i].rotation.x = lerpK(p.el[i].rotation.x, T[`${s}ElX`] ?? 0, k);
    p.el[i].rotation.z = lerpK(p.el[i].rotation.z, T[`${s}ElZ`] ?? 0, k);
    p.hip[i].rotation.x = lerpK(p.hip[i].rotation.x, T[`${s}HipX`] ?? 0, k * 1.5);
    p.knee[i].rotation.x = lerpK(p.knee[i].rotation.x, T[`${s}KneeX`] ?? 0, k * 1.5);
  }
  p.hips.position.y = lerpK(p.hips.position.y, T.hipsY ?? p.hips.position.y, k);
}
const SEATED = { lHipX: -1.5, rHipX: -1.5, lKneeX: 1.45, rKneeX: 1.45 };
function seatedPose(mode, t, seed) {
  const T = { ...SEATED };
  const tw = Math.sin(t * 13 + seed);
  switch (mode) {
    case 'type':
    case 'terminal':
      Object.assign(T, { spineX: 0.12, headX: 0.08 + Math.sin(t * 1.3 + seed) * 0.03, headY: mode === 'terminal' ? -0.35 + Math.sin(t * 0.4) * 0.1 : Math.sin(t * 0.5 + seed) * 0.08,
        lShX: -0.62, lShZ: 0.2, lElX: -0.95 + tw * 0.09, rShX: -0.62, rShZ: -0.2, rElX: -0.95 - tw * 0.09 });
      break;
    case 'read':
      Object.assign(T, { spineX: 0.05, headX: 0.04, headY: Math.sin(t * 0.7 + seed) * 0.16,
        lShX: -0.38, lShZ: 0.32, lElX: -1.2, rShX: -0.5, rShZ: -0.02, rElX: -0.95 + Math.sin(t * 2.2) * 0.04 });
      break;
    case 'think':
      Object.assign(T, { spineX: -0.02, headX: -0.1, headZ: 0.1, headY: 0.15,
        lShX: -0.4, lShZ: 0.35, lElX: -1.25, rShX: -1.25, rShZ: -0.3, rElX: -2.1 });
      break;
    case 'wait':
      Object.assign(T, { spineX: 0, headX: -0.08, headY: 0,
        lShX: -0.25, lShZ: 0.15, lElX: -0.5, rShX: -0.2, rShZ: -2.75 + Math.sin(t * 7) * 0.22, rElX: -0.2, rElZ: -0.35 });
      break;
    case 'done':
      Object.assign(T, { spineX: -0.2, headX: -0.15, lShX: -0.3, lShZ: -2.5, lElZ: 2.1, rShX: -0.3, rShZ: 2.5, rElZ: -2.1 });
      break;
    case 'coffee': {
      const sip = (t + seed) % 8 < 2.2;
      Object.assign(T, { spineX: -0.08, headX: sip ? -0.12 : 0.05, headY: sip ? 0 : 0.25 + Math.sin(t * 0.3) * 0.2,
        lShX: -0.35, lShZ: 0.3, lElX: -1.2, rShX: sip ? -1.05 : -0.55, rShZ: sip ? -0.35 : -0.2, rElX: sip ? -2.05 : -1.35 });
      break;
    }
    case 'sleep':
      Object.assign(T, { spineX: 0.78, headX: 0.5, headZ: 0.3, lShX: -1.15, lShZ: 0.55, lElX: -1.5, rShX: -1.15, rShZ: -0.55, rElX: -1.5 });
      break;
    case 'celebrate':
      Object.assign(T, { spineX: -0.05, headX: -0.15, lShZ: -2.75 + Math.sin(t * 9) * 0.15, rShZ: 2.75 - Math.sin(t * 9) * 0.15, lElX: -0.25, rElX: -0.25 });
      break;
    case 'facepalm':
      Object.assign(T, { spineX: 0.15, headX: 0.25, headY: Math.sin(t * 9) * 0.18, lShX: -0.35, lShZ: 0.3, lElX: -1.2, rShX: -1.3, rShZ: -0.4, rElX: -2.35 });
      break;
    default:
      break;
  }
  return T;
}

// ---------------------------------------------------------------- meja kerja + monitor
const workers = {};
const pickables = [];
function monitor(w, h) {
  const g = new THREE.Group();
  const bezel = mesh(box(w + 0.06, h + 0.06, 0.035, 0.015), mat('#22252b', 0.4, 0.2));
  const scr = canvasTex(1024, Math.round((1024 * h) / w));
  const screen = mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: scr.tex, toneMapped: false }), { cast: false });
  screen.position.z = 0.019;
  const neck = mesh(new THREE.BoxGeometry(0.05, 0.22, 0.04), mat('#3a3d44', 0.4, 0.5));
  neck.position.set(0, -h / 2 - 0.08, -0.03);
  const foot = mesh(box(0.3, 0.02, 0.2, 0.01), mat('#3a3d44', 0.4, 0.5));
  foot.position.set(0, -h / 2 - 0.19, 0);
  g.add(bezel, screen, neck, foot);
  return { g, scr, screenMat: screen.material };
}
function buildDesk(cfg) {
  const desk = new THREE.Group();
  desk.position.set(cfg.deskX, 0, -4.3);
  scene.add(desk);
  const wood = mat('#c9a27a', 0.55);
  const top = mesh(box(2.3, 0.05, 1.05, 0.02), wood);
  top.position.y = 0.74;
  desk.add(top);
  const legM = mat('#e9e4dc', 0.6);
  for (const s of [-1, 1]) {
    const panel = mesh(new THREE.BoxGeometry(0.04, 0.72, 0.95), legM);
    panel.position.set(s * 1.08, 0.36, 0);
    desk.add(panel);
  }
  const modesty = mesh(new THREE.BoxGeometry(2.1, 0.35, 0.03), legM);
  modesty.position.set(0, 0.52, -0.45);
  desk.add(modesty);
  const main = monitor(1.0, 0.58);
  main.g.position.set(-0.3, 1.26, -0.25);
  const side = monitor(0.82, 0.5);
  side.g.position.set(0.68, 1.22, -0.18);
  side.g.rotation.y = -0.35;
  desk.add(main.g, side.g);
  const kb = mesh(box(0.46, 0.022, 0.15, 0.008), mat('#e7e7ea', 0.5));
  kb.position.set(-0.25, 0.775, 0.3);
  const mouse = mesh(new THREE.CapsuleGeometry(0.025, 0.04, 4, 10), mat('#e7e7ea', 0.5));
  mouse.rotation.x = Math.PI / 2;
  mouse.scale.set(1, 1, 0.5);
  mouse.position.set(0.2, 0.78, 0.3);
  desk.add(kb, mouse);
  const deskMug = mugMesh(cfg.mug);
  deskMug.position.set(0.8, 0.765, 0.3);
  desk.add(deskMug);
  const papers = mesh(box(0.3, 0.02, 0.4, 0.005), mat('#fbfaf6', 0.9));
  papers.position.set(-0.85, 0.775, 0.15);
  papers.rotation.y = 0.2;
  desk.add(papers);
  if (cfg.prop === 'plant') {
    const p = plant(0, 0, 0.35, 12);
    scene.remove(p);
    p.position.set(-0.95, 0.765, -0.3);
    desk.add(p);
  }
  if (cfg.prop === 'notes') {
    ['#fff1a8', '#ffd8b5', '#cfe0ff'].forEach((c, i) => {
      const n = mesh(new THREE.PlaneGeometry(0.07, 0.07), new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, side: THREE.DoubleSide }), { cast: false });
      n.position.set(-0.78 + i * 0.08, 1.5 - (i % 2) * 0.05, -0.23);
      n.rotation.z = (i - 1) * 0.12;
      desk.add(n);
    });
  }
  if (cfg.prop === 'can') {
    const can = mesh(new THREE.CylinderGeometry(0.033, 0.033, 0.12, 14), mat(cfg.css, 0.3, 0.5));
    can.position.set(-0.85, 0.83, -0.1);
    desk.add(can);
  }
  if (cfg.prop === 'server') {
    const srv = mesh(box(0.22, 0.32, 0.3, 0.02), mat('#2a2d33', 0.4, 0.3));
    srv.position.set(-0.85, 0.93, -0.15);
    desk.add(srv);
    ['#2fbf71', '#2fbf71', '#f5c542'].forEach((c, i) => {
      const led = mesh(new THREE.BoxGeometry(0.02, 0.02, 0.005), new THREE.MeshBasicMaterial({ color: c, toneMapped: false }), { cast: false });
      led.position.set(-0.92 + i * 0.04, 1.02, 0.003);
      desk.add(led);
    });
  }
  if (DESK_SCALE !== 1) desk.scale.x = DESK_SCALE;
  // papan nama
  const np = canvasTex(512, 128);
  np.ctx.fillStyle = '#fbfaf7';
  np.ctx.fillRect(0, 0, 512, 128);
  np.ctx.fillStyle = cfg.css;
  np.ctx.fillRect(0, 0, 14, 128);
  np.ctx.fillStyle = '#2b2a28';
  np.ctx.font = `700 54px ${SANS}`;
  np.ctx.fillText(cfg.name, 40, 64);
  np.ctx.fillStyle = '#6f6a62';
  np.ctx.font = `500 34px ${SANS}`;
  np.ctx.fillText(cfg.role, 40, 108);
  np.tex.needsUpdate = true;
  const plate = mesh(new THREE.PlaneGeometry(0.5, 0.125), new THREE.MeshStandardMaterial({ map: np.tex, roughness: 0.5 }), { cast: false });
  plate.position.set(0.55, 0.81, 0.46);
  plate.rotation.x = -0.6;
  desk.add(plate);
  const lamp = new THREE.PointLight('#ffd9a0', 0, 5, 2);
  lamp.position.set(0, 1.9, 0.3);
  desk.add(lamp);

  // kursi + orang (grup putar)
  const seat = new THREE.Group();
  seat.position.set(cfg.deskX, 0, -3.35);
  seat.rotation.y = Math.PI;
  scene.add(seat);
  seat.add(officeChair());
  const p = buildPerson(cfg, true);
  p.root.position.z = 0.02;
  seat.add(p.root);
  const handMug = mugMesh(cfg.mug);
  handMug.position.set(0.02, -0.09, 0.05);
  handMug.rotation.z = Math.PI;
  handMug.scale.setScalar(0.9);
  p.hand[1].add(handMug);
  handMug.visible = false;
  p.root.traverse((o) => { if (o.isMesh && o.userData.role) pickables.push(o); });

  const el = document.createElement('div');
  el.className = 'person';
  el.style.setProperty('--c', cfg.css);
  el.innerHTML = `<div class="bubble hide"></div><div class="tag">${esc(cfg.name)} <small>· ${esc(cfg.role)}</small></div>`;
  const label = new CSS2DObject(el);
  scene.add(label);

  workers[cfg.key] = {
    cfg, desk, seat, p, main, side, deskMug, handMug, lamp, label, bubble: el.querySelector('.bubble'),
    state: 'siaga', data: null, mode: 'coffee', override: null, overrideUntil: 0, overrideText: '', seed: hash(cfg.key) % 100,
    swivel: Math.PI, sig: '', drawnAt: 0, lastEvt: '',
  };
}
Object.values(PEOPLE).forEach(buildDesk);

// ---------------------------------------------------------------- Risko (berdiri, berjalan)
const RISKO_HOME = new THREE.Vector3(-4.2, 0, -5.95);
const RISKO_IDLE_HEADING = Math.PI - 0.55;
const risko = (() => {
  const p = buildPerson(RISKO, false);
  p.root.position.copy(RISKO_HOME);
  scene.add(p.root);
  const tablet = new THREE.Group();
  const body = mesh(box(0.3, 0.21, 0.018, 0.012), mat('#2b2f36', 0.4, 0.3));
  const scr = mesh(new THREE.PlaneGeometry(0.27, 0.18), new THREE.MeshBasicMaterial({ color: '#dfe8fb', toneMapped: false }), { cast: false });
  scr.position.z = 0.011;
  tablet.add(body, scr);
  tablet.position.set(0, 0.2, 0.26);
  tablet.rotation.x = -0.9;
  p.spine.add(tablet);
  p.root.traverse((o) => { if (o.isMesh && o.userData.role) pickables.push(o); });
  const el = document.createElement('div');
  el.className = 'person';
  el.style.setProperty('--c', RISKO.css);
  el.innerHTML = `<div class="bubble hide"></div><div class="tag">${esc(RISKO.name)} <small>· ${esc(RISKO.role)}</small></div>`;
  const label = new CSS2DObject(el);
  scene.add(label);
  return { p, tablet, label, bubble: el.querySelector('.bubble'), heading: RISKO_IDLE_HEADING, queue: [], task: null, phase: 0, state: 'siaga' };
})();
function riskoSend(role, text) {
  if (risko.queue.length > 2) risko.queue.shift();
  risko.queue.push({ role, text });
}
// jalur lewat koridor belakang meja lalu lorong di antara meja
function routeTo(role) {
  const spot = new THREE.Vector3(PEOPLE[role].deskX + 1.05 * DESK_SCALE, 0, -2.75);
  return [new THREE.Vector3(-8.6, 0, -5.95), new THREE.Vector3(-8.6, 0, -2.4), spot];
}

// ---------------------------------------------------------------- mode istirahat
// Aktif saat analyst/developer/qa tidak ada yang bekerja >90 dtk. Keempat karakter bergiliran
// nonton, main PS, ambil kopi & air, main gitar, peregangan — lalu kembali ke meja saat kerja dimulai lagi.
const BREAK = { on: false, since: 0, chatAt: 0, gameAt: 0, tvMode: 'tv' };
const SLOT_MS = 45000;
const CYCLE = ['tv', 'coffee', 'ps', 'water', 'guitar', 'window', 'meeting', 'bookshelf'];
const V = (x, z) => new THREE.Vector3(x, 0, z);
const HUB = V(1.5, -0.2);
const SPOTS = {
  tv: { pos: V(4.3, 1.25), heading: Math.PI, via: [V(3.2, 1.05)] },
  ps: { pos: V(5.5, 1.25), heading: Math.PI, via: [V(7.2, -0.2), V(6.9, 1.05)] },
  coffee: { pos: V(7.7, -5.55), heading: Math.PI, via: [V(7.2, -0.2), V(7.4, -5.0)] },
  water: { pos: V(8.75, -5.45), heading: Math.PI / 2, via: [V(7.2, -0.2), V(7.4, -5.0)] },
  guitar: { pos: V(-2.3, 1.7), heading: 0.35, via: [] },
  window: { pos: V(3.5, -6.2), heading: Math.PI, via: [V(7.2, -0.2), V(7.4, -5.3), V(5.8, -5.5)] },
  meeting: { pos: V(-4.24, 2.01), heading: -2.54, via: [V(-3.0, 2.8), V(-3.85, 2.58)] },
  bookshelf: { pos: V(-8.9, 3.8), heading: -Math.PI / 2, via: [V(-3.0, 3.6)] },
};
const QUIPS = {
  tv: ['Filmnya lagi seru nih 🍿', 'Eh, aktornya siapa ya?', 'Jangan di-skip dulu!'],
  ps: ['Gooool! ⚽', 'Satu match lagi ah 🎮', 'Stiknya agak nge-drift nih'],
  coffee: ['Ngopi dulu biar melek ☕', 'Espresso double, please', 'Wangi banget kopinya'],
  water: ['Minum air putih dulu 💧', 'Galonnya tinggal dikit', 'Seger!'],
  guitar: ['🎸 jreng… jreng…', 'Request lagu dong', 'Kuncinya G atau C ya?'],
  window: ['Langitnya cerah ya ☀️', 'Peregangan dulu, pegal 🙆', 'Macet banget di bawah'],
  meeting: ['Diskusi ringan dulu ☕', 'Rapat 5 menit, janji!', 'Siapa yang pesan kopi?'],
  bookshelf: ['Buku ini seru juga 📚', 'Nyari referensi dulu', 'Wah, ada komik!'],
};
const CHAT = [
  ['{to}, main FIFA yuk! Yang kalah traktir bakso', 'Ogah, kemarin aku kalah 3–0 😅'],
  ['Filmnya jangan di-spoiler ya, {to}!', 'Siap, mulutku terkunci 🤐'],
  ['Kopinya kok pahit banget?', 'Itu espresso, bukan kopi sachet 😂'],
  ['Galon siapa yang ngabisin?', 'Bukan aku, sumpah!'],
  ['Gitarnya fals dikit tuh, {to}', 'Namanya juga gitar kantor'],
  ['Besok hujan nggak ya?', 'Bawa payung aja biar aman ☔'],
  ['Ada gorengan nggak di pantry?', 'Tadi ada, udah habis 🙃'],
  ['Ngantuk banget habis makan siang', 'Sama, butuh kopi kedua'],
  ['Kucingku tadi pagi nyolong ikan', 'Wkwk pasti kucing oranye'],
  ['{to}, weekend mau ke mana?', 'Rebahan aja, paling mewah 😴'],
  ['Lagu apa ini? Enak juga', 'Lagu lama, tapi masih enak'],
  ['{to}, itu gelas kopi ketiga ya?', 'Biar fokus nanti 😆'],
  ['Kemarin nemu warung mi ayam enak', 'Wah, share lokasinya dong!'],
  ['{to}, kamu tim bubur diaduk?', 'Nggak diaduk dong, garis keras'],
  ['AC-nya dingin banget ya', 'Pakai jaket, jangan kalah sama AC'],
  ['{to}, headset-mu mana?', 'Lagi di-charge 🔋'],
];
const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];

function guitarMesh() {
  const g = new THREE.Group();
  const wood = mat('#b5703a', 0.5);
  const body = mesh(new THREE.SphereGeometry(0.13, 20, 14), wood);
  body.scale.set(1, 1.15, 0.35);
  const upper = mesh(new THREE.SphereGeometry(0.1, 18, 12), wood);
  upper.scale.set(1, 1, 0.35);
  upper.position.set(-0.13, 0.02, 0);
  const hole = mesh(new THREE.CircleGeometry(0.035, 16), mat('#2a1a10', 0.8), { cast: false });
  hole.position.set(-0.1, 0.02, 0.048);
  const neck = mesh(new THREE.BoxGeometry(0.42, 0.04, 0.025), mat('#6b4423', 0.5));
  neck.position.set(-0.42, 0.02, 0.01);
  const head = mesh(box(0.1, 0.06, 0.03, 0.01), mat('#2b2622', 0.5));
  head.position.set(-0.68, 0.02, 0.01);
  g.add(body, upper, hole, neck, head);
  return g;
}
const actors = [];
function makeActor(key, name, p, opts) {
  const guitar = guitarMesh();
  guitar.scale.x = -1;
  guitar.position.set(0.02, 0.2, 0.2);
  guitar.rotation.z = -0.35;
  guitar.visible = false;
  p.spine.add(guitar);
  const pad = gamepad('#1d1f24');
  pad.position.set(0, 0.1, 0.3);
  pad.rotation.x = -0.6;
  pad.visible = false;
  p.spine.add(pad);
  const book = mesh(box(0.2, 0.26, 0.03, 0.01), mat('#3f6fd1', 0.7));
  book.position.set(0, 0.12, 0.28);
  book.rotation.x = -0.9;
  book.visible = false;
  p.spine.add(book);
  const a = { key, name, p, book, free: false, heading: 0, path: [], i: 0, goal: null, at: null, arrived: false, arrivedAt: 0, phase: 0, holding: null, offset: 0, jitter: 0, bubbleText: '', bubbleUntil: 0, guitar, pad, ...opts };
  actors.push(a);
  return a;
}
Object.values(workers).forEach((w, i) => {
  w.actor = makeActor(w.cfg.key, w.cfg.name, w.p, { worker: w, offset: [0, 2, 4, 6, 1, 3][i], jitter: i * 9000, mug: w.handMug, bubbleEl: w.bubble });
});
risko.mug = mugMesh('#7a5cc4');
risko.mug.position.set(0.02, -0.09, 0.05);
risko.mug.rotation.z = Math.PI;
risko.mug.scale.setScalar(0.9);
risko.mug.visible = false;
risko.p.hand[1].add(risko.mug);
risko.actor = makeActor('orkestrator', RISKO.name, risko.p, { offset: ROLE_KEYS.length >= 5 ? 5 : 1, jitter: 27000, mug: risko.mug, bubbleEl: risko.bubble });

function say(a, text, ms = 4200) {
  a.bubbleText = text;
  a.bubbleUntil = performance.now() + ms;
}
function setBreak(on) {
  if (on === BREAK.on) return;
  BREAK.on = on;
  if (!on) return;
  BREAK.since = performance.now();
  BREAK.chatAt = BREAK.since + 5000;
  for (const a of actors) {
    if (a.free) continue;
    if (a.worker) {
      scene.attach(a.p.root);
      a.p.root.rotation.x = 0;
      a.p.root.rotation.z = 0;
      a.heading = a.p.root.rotation.y;
      a.at = 'desk';
    } else {
      risko.task = null;
      risko.queue.length = 0;
      a.heading = risko.heading;
      a.at = 'home';
    }
    a.free = true;
    a.goal = null;
    a.arrived = true;
    a.path = [];
  }
}
function exitPath(a) {
  if (a.at === 'desk') return [V(a.worker.cfg.deskX, -2.5)];
  if (a.at === 'home') return [V(-8.6, -5.95), V(-8.6, -2.4)];
  if (a.at && SPOTS[a.at]) return [...SPOTS[a.at].via].reverse();
  return [];
}
function homePath(a) {
  if (a.worker) {
    const x = a.worker.cfg.deskX;
    return [V(x, -2.5), V(x, -3.35)];
  }
  return [V(-8.6, -2.4), V(-8.6, -5.95), RISKO_HOME.clone()];
}
function planRoute(a, goal) {
  const out = a.arrived ? exitPath(a) : [];
  const dest = goal === 'home' ? homePath(a) : [...SPOTS[goal].via, SPOTS[goal].pos];
  a.path = [...out, HUB, ...dest];
  a.i = 0;
  a.arrived = false;
  a.goal = goal;
  a.at = null;
}
function desired(a, now) {
  const k = Math.max(0, Math.floor((now - BREAK.since - a.jitter) / SLOT_MS));
  return CYCLE[(k + a.offset) % CYCLE.length];
}
function arrive(a, now) {
  a.arrived = true;
  a.arrivedAt = now;
  if (a.goal === 'home') {
    a.holding = null;
    a.guitar.visible = false;
    a.pad.visible = false;
    a.book.visible = false;
    if (a.mug) a.mug.visible = false;
    if (a.worker) {
      const w = a.worker;
      w.seat.rotation.y = Math.PI;
      w.seat.attach(a.p.root);
      a.p.root.position.set(0, 0, 0.02);
      a.p.root.rotation.set(0, 0, 0);
      a.at = 'desk';
    } else {
      risko.heading = RISKO_IDLE_HEADING;
      a.at = 'home';
    }
    a.free = false;
    return;
  }
  a.at = a.goal;
  if (a.goal !== 'coffee' && a.goal !== 'water') a.holding = null;
  if (Math.random() < 0.6 && now > a.bubbleUntil) say(a, pickOne(QUIPS[a.goal]));
}
function breakPose(a, walking, t, now) {
  const sw = Math.sin(a.phase);
  const mug = a.holding === 'mug';
  if (walking || !a.arrived) {
    return {
      hipsY: 0.9 + Math.abs(Math.cos(a.phase)) * 0.03, spineX: 0.04, headX: 0.05,
      lHipX: sw * 0.5, rHipX: -sw * 0.5, lKneeX: Math.max(0, -sw) * 0.7, rKneeX: Math.max(0, sw) * 0.7,
      lShX: -sw * 0.35, lShZ: 0.1, lElX: -0.25, rShX: mug ? -0.55 : sw * 0.35, rShZ: -0.1, rElX: mug ? -1.35 : -0.25,
    };
  }
  const st = (now - a.arrivedAt) / 1000;
  const stand = { hipsY: 0.9, lHipX: 0, rHipX: 0, lKneeX: 0, rKneeX: 0 };
  const sofa = { ...SEATED, hipsY: 0.64 };
  switch (a.goal) {
    case 'tv': {
      const laugh = Math.sin(t * 0.7 + a.offset) > 0.93;
      return { ...sofa, spineX: laugh ? -0.25 : -0.12, headX: laugh ? -0.25 : -0.02, lShX: -0.45, lShZ: 0.25, lElX: -0.95, rShX: -0.45, rShZ: -0.25, rElX: -0.95 };
    }
    case 'ps':
      return { ...sofa, spineX: 0.14 + Math.sin(t * 2.3) * 0.03, headX: 0.05, lShX: -0.8, lShZ: 0.3, lElX: -1.25 + Math.sin(t * 9) * 0.05, rShX: -0.8, rShZ: -0.3, rElX: -1.25 - Math.sin(t * 11) * 0.05 };
    case 'coffee':
    case 'water': {
      if (st < 2.5) return { ...stand, spineX: 0.1, headX: 0.25, rShX: -1.1, rShZ: -0.1, rElX: -0.5 };
      a.holding = 'mug';
      const sip = st % 6 < 1.8;
      return { ...stand, spineX: -0.03, headX: sip ? -0.15 : 0.05, headY: sip ? 0 : 0.5, lElX: -0.1, rShX: sip ? -1.05 : -0.55, rShZ: sip ? -0.35 : -0.15, rElX: sip ? -2.05 : -1.35 };
    }
    case 'guitar':
      return { ...stand, spineX: 0.06, headX: 0.25 + Math.sin(t * 4) * 0.05, headZ: Math.sin(t * 2) * 0.08, rShX: -0.9, rShZ: 0.6, rElX: -0.7, lShX: -0.5, lShZ: 0.25, lElX: -1.3 + Math.sin(t * 12) * 0.25 };
    case 'meeting':
      return { ...SEATED, hipsY: 0.57, spineX: 0.1, headX: 0.05 + Math.sin(t * 1.7 + a.offset) * 0.06, headY: Math.sin(t * 0.6 + a.offset) * 0.25,
        lShX: -0.85, lShZ: 0.2, lElX: -0.9, rShX: -0.85 + Math.sin(t * 3 + a.offset) * 0.15, rShZ: -0.2, rElX: -0.9 };
    case 'bookshelf':
      return { ...stand, spineX: 0.08, headX: 0.35 + Math.sin(t * 0.8) * 0.04, lShX: -0.7, lShZ: 0.25, lElX: -1.3, rShX: -0.7, rShZ: -0.25, rElX: -1.3 };
    case 'window': {
      const stretch = st % 9 < 2.5;
      return stretch
        ? { ...stand, spineX: -0.12, headX: -0.25, lShZ: -2.8, rShZ: 2.8, lElX: -0.2, rElX: -0.2 }
        : { ...stand, headX: -0.05, headY: Math.sin(t * 0.5) * 0.3, lShX: 0.25, lShZ: 0.15, lElX: -0.4, rShX: 0.25, rShZ: -0.15, rElX: -0.4 };
    }
    default:
      return stand;
  }
}
function updateActor(a, dt, t, now) {
  const want = BREAK.on ? desired(a, now) : 'home';
  if (a.goal !== want) planRoute(a, want);
  const root = a.p.root;
  let walking = false;
  if (!a.arrived) {
    const g = a.path[a.i];
    tmpV.subVectors(g, root.position).setY(0);
    const dist = tmpV.length();
    if (dist > 0.06) {
      walking = true;
      root.position.addScaledVector(tmpV.normalize(), Math.min(dist, 1.6 * dt));
      a.heading = turnTo(a.heading, Math.atan2(tmpV.x, tmpV.z), dt * 6);
    } else if (a.i < a.path.length - 1) {
      a.i++;
    } else {
      arrive(a, now);
      if (!a.free) return;
    }
  } else if (SPOTS[a.goal]) {
    a.heading = turnTo(a.heading, SPOTS[a.goal].heading, dt * 4);
  }
  root.rotation.y = a.heading;
  a.phase += dt * (walking ? 8 : 0);
  a.p.nod = Math.max(0, a.p.nod - dt * 0.6);
  applyPose(a.p, breakPose(a, walking, t, now), dt);
  a.guitar.visible = a.arrived && a.goal === 'guitar';
  a.pad.visible = a.arrived && a.goal === 'ps';
  a.book.visible = a.arrived && a.goal === 'bookshelf';
  if (a.mug) a.mug.visible = a.holding === 'mug';
}
function breakChatter(now) {
  if (!BREAK.on || now < BREAK.chatAt) return;
  BREAK.chatAt = now + 6500 + Math.random() * 4000;
  const avail = actors.filter((a) => a.free && now > a.bubbleUntil);
  if (avail.length < 2) return;
  const sp = pickOne(avail);
  const ls = pickOne(avail.filter((a) => a !== sp));
  const [q, r] = pickOne(CHAT);
  say(sp, q.replace('{to}', ls.name), 4800);
  setTimeout(() => { if (BREAK.on && ls.free) say(ls, r, 4200); }, 2300);
}
function drawGame(t, name) {
  const { ctx, tex } = tvScreen;
  const W = 1280;
  const H = 720;
  const hz = H * 0.42;
  const sky = ctx.createLinearGradient(0, 0, 0, hz);
  sky.addColorStop(0, '#2f5fcf');
  sky.addColorStop(1, '#a4cfff');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, hz);
  ctx.fillStyle = '#5a7fa8';
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 240 - 60, hz);
    ctx.lineTo(i * 240 + 60, hz - 90 - (i % 2) * 40);
    ctx.lineTo(i * 240 + 180, hz);
    ctx.fill();
  }
  ctx.fillStyle = '#3f9b4f';
  ctx.fillRect(0, hz, W, H - hz);
  ctx.fillStyle = '#44474f';
  ctx.beginPath();
  ctx.moveTo(W * 0.47, hz);
  ctx.lineTo(W * 0.53, hz);
  ctx.lineTo(W * 0.98, H);
  ctx.lineTo(W * 0.02, H);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#f4f4f4';
  for (let k = 0; k < 10; k++) {
    const z = ((k + ((t * 2.5) % 1)) / 10);
    const y = hz + z * z * (H - hz);
    const w = 3 + z * 26;
    ctx.fillRect(W / 2 - w / 2, y, w, 4 + z * 34);
  }
  const ox = W / 2 + Math.sin(t * 0.7) * 150;
  ctx.fillStyle = '#d64545';
  ctx.fillRect(ox - 40, hz + 110, 80, 44);
  const px = W / 2 + Math.sin(t * 1.3) * 180;
  ctx.fillStyle = '#3f6fd1';
  ctx.fillRect(px - 110, H - 170, 220, 110);
  ctx.fillStyle = '#1d1f24';
  ctx.fillRect(px - 100, H - 70, 50, 20);
  ctx.fillRect(px + 50, H - 70, 50, 20);
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  ctx.fillRect(24, 22, 360, 96);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 34px ${SANS}`;
  ctx.fillText(`P1 · ${name}`, 44, 66);
  ctx.font = `500 26px ${SANS}`;
  ctx.fillText(`LAP ${1 + (Math.floor(t / 20) % 3)}/3 · POS ${1 + (Math.floor(t / 7) % 4)}`, 44, 102);
  tex.needsUpdate = true;
}

// ---------------------------------------------------------------- layar monitor (data real)
function screenApp(mode) {
  return { type: 'Editor', read: 'Membaca berkas', terminal: 'Terminal', think: 'Catatan', wait: 'Menunggu keputusan', done: 'Ringkasan hasil', coffee: 'Desktop', sleep: 'Layar terkunci' }[mode] || 'Aplikasi kerja';
}
function drawMain(w) {
  const { ctx, canvas, tex } = w.main.scr;
  const W = canvas.width;
  const H = canvas.height;
  const d = w.data;
  const css = w.cfg.css;
  const mode = w.mode;
  if (mode === 'coffee' || mode === 'sleep') {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, mode === 'sleep' ? '#2d3140' : css);
    g.addColorStop(1, mode === 'sleep' ? '#1d2029' : '#f3eee6');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = mode === 'sleep' ? 'rgba(255,255,255,.6)' : '#ffffff';
    ctx.font = `600 120px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.fillText(fmtTime.format(new Date()).slice(0, 5).replace('.', ':'), W / 2, H / 2 + 20);
    ctx.font = `500 36px ${SANS}`;
    ctx.fillText(mode === 'sleep' ? 'Layar terkunci — jeda' : `${w.cfg.name} · ${STATES[w.state]?.label || ''}`, W / 2, H / 2 + 90);
    ctx.textAlign = 'left';
    tex.needsUpdate = true;
    return;
  }
  const term = mode === 'terminal';
  ctx.fillStyle = term ? '#1f2330' : '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = term ? '#2a2f3d' : '#f1ede6';
  ctx.fillRect(0, 0, W, 58);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(30 + i * 30, 29, 9, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = term ? '#cfd6e6' : '#4a463f';
  ctx.font = `600 28px ${SANS}`;
  ctx.fillText(fit(ctx, `${screenApp(mode)} — ${d?.task || w.cfg.role}`, W - 160), 130, 39);
  const rows = (d?.last || []).slice(0, 9);
  ctx.font = `500 25px ${MONO}`;
  let y = 104;
  if (!rows.length) {
    ctx.fillStyle = term ? '#8b93a7' : '#9a938a';
    ctx.fillText('Belum ada aktivitas.', 34, y);
  }
  rows.forEach((e, i) => {
    ctx.fillStyle = term ? '#6c7489' : '#b0a89c';
    ctx.fillText(hhmmss(e.t).slice(0, 5), 34, y);
    ctx.fillStyle = term ? (i === 0 ? '#9ef0b9' : '#d7deeb') : i === 0 ? '#1f1d1a' : e.kind === 'text' ? '#8a847b' : '#45413b';
    ctx.fillText(fit(ctx, `${term ? '$ ' : ''}${e.text}`, W - 160), 132, y);
    y += 44;
  });
  ctx.fillStyle = css;
  ctx.fillRect(0, H - 50, W, 50);
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 24px ${SANS}`;
  ctx.fillText(fit(ctx, `${w.cfg.name} · ${STATES[w.state]?.label || w.state} · ${fmtNum.format(d?.tools || 0)} aksi · ${fmtCompact.format(d?.tokens_all || 0)} token`, W - 60), 30, H - 17);
  tex.needsUpdate = true;
}
const imgCache = new Map();
function loadImg(src) {
  if (!imgCache.has(src)) {
    const im = new Image();
    im.onload = () => { for (const w of Object.values(workers)) w.sig = ''; };
    im.src = src;
    imgCache.set(src, im);
  }
  return imgCache.get(src);
}
function drawSide(w) {
  const { ctx, canvas, tex } = w.side.scr;
  const W = canvas.width;
  const H = canvas.height;
  const kind = w.cfg.screen;
  const dark = kind === 'files' || kind === 'commands';
  ctx.fillStyle = dark ? '#1e2230' : '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = dark ? '#282d3b' : '#f1ede6';
  ctx.fillRect(0, 0, W, 60);
  ctx.fillStyle = dark ? '#cfd6e6' : '#4a463f';
  ctx.font = `600 30px ${SANS}`;
  const auto = S?.mode === 'auto';
  const title = auto
    ? { docs: 'Commit terbaru (git)', files: 'File yang diubah', evidence: 'Daftar tugas', commands: 'Terminal' }[kind]
    : { docs: 'Dokumen planning', files: 'Perubahan file', evidence: 'Bukti QA terbaru', commands: 'Terminal & deploy' }[kind];
  ctx.fillText(title, 28, 41);
  if (auto && kind === 'docs') {
    const cm = S?.fallback?.commits;
    const items = (cm?.items || []).slice(0, 8);
    let y = 110;
    ctx.font = `500 26px ${SANS}`;
    if (!items.length) {
      ctx.fillStyle = '#9a938a';
      ctx.fillText(fit(ctx, cm && !cm.available ? `Git: ${cm.reason}` : 'Belum ada commit.', W - 60), 28, y);
    }
    for (const c of items) {
      ctx.fillStyle = '#b08a3a';
      ctx.font = `500 24px ${MONO}`;
      ctx.fillText(c.hash, 28, y);
      ctx.fillStyle = '#2b2a28';
      ctx.font = `500 26px ${SANS}`;
      ctx.fillText(fit(ctx, c.subject, W - 360), 160, y);
      ctx.fillStyle = '#9a938a';
      ctx.fillText(fit(ctx, ago(c.t), 170), W - 190, y);
      y += 48;
    }
  } else if (auto && kind === 'evidence') {
    const list = (S?.fallback?.todos || []).find((l) => l.role === w.cfg.key);
    let y = 110;
    ctx.font = `500 26px ${SANS}`;
    if (!list) {
      ctx.fillStyle = '#9a938a';
      ctx.fillText('Belum ada daftar tugas.', 28, y);
    }
    for (const it of (list?.items || []).slice(0, 8)) {
      const st = TODO_STATUS[it.status] || TODO_STATUS.pending;
      ctx.fillStyle = st.css;
      ctx.fillText(it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '▶' : '○', 28, y);
      ctx.fillStyle = it.status === 'completed' ? '#9a938a' : '#2b2a28';
      ctx.fillText(fit(ctx, it.text, W - 90), 66, y);
      y += 48;
    }
  } else if (kind === 'commands') {
    const cmds = (w.data?.last || []).filter((e) => e.tool === 'Bash').slice(0, 8);
    let y = 112;
    ctx.font = `500 25px ${MONO}`;
    if (!cmds.length) {
      ctx.fillStyle = '#8b93a7';
      ctx.fillText('$ _', 28, y);
    }
    cmds.forEach((e) => {
      ctx.fillStyle = '#9ef0b9';
      ctx.fillText('$', 28, y);
      ctx.fillStyle = '#d7deeb';
      ctx.fillText(fit(ctx, e.text.replace(/^Menjalankan:\s*/, ''), W - 90), 62, y);
      y += 46;
    });
  } else if (kind === 'docs') {
    const docs = (S?.docs || []).slice(0, 8);
    let y = 110;
    ctx.font = `500 26px ${SANS}`;
    if (!docs.length) {
      ctx.fillStyle = '#9a938a';
      ctx.fillText('Belum ada dokumen.', 28, y);
    }
    for (const doc of docs) {
      ctx.fillStyle = '#3f6fd1';
      ctx.fillRect(28, y - 20, 18, 22);
      ctx.fillStyle = '#2b2a28';
      ctx.fillText(fit(ctx, doc.title, W - 260), 60, y);
      ctx.fillStyle = '#9a938a';
      ctx.fillText(fit(ctx, ago(doc.updated), 190), W - 210, y);
      y += 48;
    }
  } else if (kind === 'files') {
    const files = (w.data?.files || []).slice().reverse().slice(0, 8);
    let y = 112;
    ctx.font = `500 25px ${MONO}`;
    if (!files.length) {
      ctx.fillStyle = '#8b93a7';
      ctx.fillText('// belum ada perubahan kode', 28, y);
      ctx.fillText('// menunggu plan dikerjakan', 28, y + 44);
    }
    files.forEach((f) => {
      ctx.fillStyle = '#e5c07b';
      ctx.fillText('M', 28, y);
      ctx.fillStyle = '#d7deeb';
      ctx.fillText(fit(ctx, f, W - 90), 70, y);
      y += 46;
    });
  } else {
    const ev = S?.evidence?.[0];
    if (ev) {
      const im = loadImg(`/kerja/evidence/${ev.path.split('/').map(encodeURIComponent).join('/')}`);
      if (im.complete && im.naturalWidth) {
        const bw = W - 40;
        const bh = H - 150;
        const sc = Math.max(bw / im.naturalWidth, bh / im.naturalHeight);
        ctx.save();
        ctx.beginPath();
        ctx.rect(20, 76, bw, bh);
        ctx.clip();
        ctx.drawImage(im, 20, 76, im.naturalWidth * sc, im.naturalHeight * sc);
        ctx.restore();
      }
      ctx.fillStyle = '#6f6a62';
      ctx.font = `500 24px ${MONO}`;
      ctx.fillText(fit(ctx, ev.path, W - 60), 24, H - 30);
    } else {
      ctx.fillStyle = '#9a938a';
      ctx.font = `500 26px ${SANS}`;
      ctx.fillText('Belum ada screenshot bukti.', 28, 112);
    }
    const qa = (S?.qa || []).find((q) => q.verdict);
    if (qa) {
      ctx.fillStyle = qa.verdict === 'PASS' ? '#2f9a6d' : '#d64545';
      roundRect(ctx, W - 190, 14, 170, 34, 17);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `700 22px ${SANS}`;
      ctx.fillText(`${qa.plan} ${qa.verdict}`, W - 170, 39);
    }
  }
  tex.needsUpdate = true;
}

// ---------------------------------------------------------------- papan tugas, whiteboard roadmap, papan keputusan
function drawKanban(plans) {
  const { ctx, canvas, tex } = kanban;
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#fbfbf9';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#2b2a28';
  ctx.font = `76px ${HAND}`;
  ctx.fillText('Papan Tugas', 40, 84);
  ctx.font = `36px ${HAND}`;
  ctx.fillStyle = '#6f6a62';
  ctx.fillText(`${plans.length} plan · diperbarui ${hhmmss(new Date().toISOString()).slice(0, 5)}`, 420, 76);
  const cols = ['Rencana', 'Dikerjakan', REVIEW_LABEL, 'Selesai'];
  const colW = (W - 80) / 4;
  cols.forEach((c, i) => {
    const x = 40 + i * colW;
    ctx.strokeStyle = '#d6cdc0';
    ctx.lineWidth = 3;
    if (i) {
      ctx.beginPath();
      ctx.moveTo(x - 6, 110);
      ctx.lineTo(x - 6, H - 30);
      ctx.stroke();
    }
    const items = plans.filter((p) => (PLAN_STATUS[p.status]?.col ?? 0) === i);
    ctx.fillStyle = '#2b2a28';
    ctx.font = `52px ${HAND}`;
    ctx.fillText(`${c} (${items.length})`, x + 10, 158);
    const nw = 222;
    const nh = 168;
    const per = Math.floor((colW - 20) / (nw + 12));
    const maxRows = Math.floor((H - 250) / (nh + 14));
    items.slice(0, per * maxRows).forEach((p, k) => {
      const r = rng(hash(p.id));
      const nx = x + 10 + (k % per) * (nw + 12);
      const ny = 190 + Math.floor(k / per) * (nh + 14);
      ctx.save();
      ctx.translate(nx + nw / 2, ny + nh / 2);
      ctx.rotate((r() - 0.5) * 0.08);
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.fillRect(-nw / 2 + 4, -nh / 2 + 6, nw, nh);
      ctx.fillStyle = PLAN_STATUS[p.status]?.note || '#fff1a8';
      ctx.fillRect(-nw / 2, -nh / 2, nw, nh);
      ctx.fillStyle = '#2b2a28';
      ctx.font = `48px ${HAND}`;
      ctx.fillText(p.id, -nw / 2 + 14, -nh / 2 + 48);
      ctx.font = `30px ${HAND}`;
      wrap(ctx, p.title, -nw / 2 + 14, -nh / 2 + 84, nw - 26, 30, 2);
      if (p.tasks_total) {
        ctx.fillStyle = 'rgba(0,0,0,.12)';
        ctx.fillRect(-nw / 2 + 12, nh / 2 - 16, nw - 24, 6);
        ctx.fillStyle = PLAN_STATUS[p.status]?.css || '#2b2a28';
        ctx.fillRect(-nw / 2 + 12, nh / 2 - 16, (nw - 24) * (p.tasks_done / p.tasks_total), 6);
      }
      ctx.restore();
    });
    const extra = items.length - per * maxRows;
    if (extra > 0) {
      ctx.fillStyle = '#6f6a62';
      ctx.font = `34px ${HAND}`;
      ctx.fillText(`+${extra} lagi`, x + 10, H - 40);
    }
  });
  tex.needsUpdate = true;
}
function drawRoadmap(rm) {
  const { ctx, canvas, tex } = roadmapBoard;
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#fdfdfc';
  ctx.fillRect(0, 0, W, H);
  const mods = rm?.modules || [];
  const pct = mods.length ? Math.round(mods.reduce((s, m) => s + (m.progress || 0), 0) / mods.length) : 0;
  ctx.fillStyle = '#2f5bd3';
  ctx.font = `72px ${HAND}`;
  ctx.fillText(`Roadmap ${PROJECT}`, 50, 90);
  ctx.fillStyle = '#2b2a28';
  ctx.font = `44px ${HAND}`;
  ctx.fillText(mods.length ? `${mods.length} modul · ${(rm.phases || []).length} fase · total ${pct}%` : `Sedang disusun ${ASKER_NAME}…`, 700, 88);
  const half = Math.ceil(mods.length / 2);
  mods.forEach((m, i) => {
    const col = i < half ? 0 : 1;
    const row = i < half ? i : i - half;
    const x = 50 + col * ((W - 60) / 2);
    const y = 170 + row * 86;
    ctx.fillStyle = '#2b2a28';
    ctx.font = `38px ${HAND}`;
    ctx.fillText(`${m.id} ${fit(ctx, m.name, 470)}`, x, y);
    const bx = x + 560;
    const bw = 300;
    ctx.strokeStyle = '#2b2a28';
    ctx.lineWidth = 3;
    ctx.strokeRect(bx, y - 28, bw, 30);
    const c = m.progress >= 100 ? '#23a55f' : m.plan_status === 'in-progress' ? '#23a55f' : m.plan_status === 'ready-for-qa' ? '#d9772f' : m.plan_status === 'qa-failed' ? '#d64545' : '#2f5bd3';
    ctx.fillStyle = c;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(bx + 3, y - 25, (bw - 6) * (m.progress / 100), 24);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#2b2a28';
    ctx.font = `36px ${HAND}`;
    ctx.fillText(`${m.progress}%`, bx + bw + 14, y);
  });
  tex.needsUpdate = true;
}
function drawCork(d) {
  const { ctx, canvas, tex } = cork;
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#c69c6d';
  ctx.fillRect(0, 0, W, H);
  const r = rng(21);
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = r() > 0.5 ? 'rgba(120,80,40,.18)' : 'rgba(255,230,190,.14)';
    ctx.fillRect(r() * W, r() * H, 3, 3);
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(40, 30, 560, 90);
  ctx.fillStyle = '#2b2a28';
  ctx.font = `58px ${HAND}`;
  ctx.fillText('Perlu Keputusan', 60, 95);
  const pending = d.pending_questions || [];
  const deferred = (d.deferred || []).filter((x) => !x.done);
  const answered = (d.roadmap?.questions || []).filter((q) => q.answered).length;
  const notes = [
    ...pending.map((q) => ({ c: '#fff1a8', h: q.id, t: q.title })),
    ...deferred.map((x) => ({ c: '#ffffff', h: `Ditunda · ${x.plan}`, t: x.item })),
  ];
  if (!notes.length) notes.push({ c: '#dff1e3', h: 'Aman', t: `Tidak ada yang menunggu keputusan. ${answered} keputusan sudah dijawab.` });
  notes.slice(0, 6).forEach((n, i) => {
    const nx = 50 + (i % 3) * 375;
    const ny = 160 + Math.floor(i / 3) * 350;
    ctx.save();
    ctx.translate(nx + 165, ny + 150);
    ctx.rotate((rng(i + 3)() - 0.5) * 0.1);
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.fillRect(-160, -140, 330, 300);
    ctx.fillStyle = n.c;
    ctx.fillRect(-165, -150, 330, 300);
    ctx.fillStyle = '#d64545';
    ctx.beginPath();
    ctx.arc(0, -135, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2b2a28';
    ctx.font = `42px ${HAND}`;
    ctx.fillText(fit(ctx, n.h, 300), -145, -90);
    ctx.font = `34px ${HAND}`;
    wrap(ctx, n.t, -145, -45, 300, 36, 5);
    ctx.restore();
  });
  tex.needsUpdate = true;
}

// ---------------------------------------------------------------- papan cadangan (project tanpa planning/)
// sumber selalu ditulis di papan: daftar tugas agent, git log, file yang sering diubah — tidak ada data karangan
function drawTodoBoard(fb) {
  const { ctx, canvas, tex } = kanban;
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#fbfbf9';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#2b2a28';
  ctx.font = `76px ${HAND}`;
  ctx.fillText('Papan Tugas', 40, 84);
  const lists = fb?.todos || [];
  const items = [];
  for (const l of lists) for (const it of l.items) items.push({ ...it, role: l.role, t: l.t });
  ctx.font = `36px ${HAND}`;
  ctx.fillStyle = '#6f6a62';
  ctx.fillText(fit(ctx, `sumber: daftar tugas agent (TodoWrite/Task) · ${items.length} tugas dari ${lists.length} agent`, W - 480), 420, 76);
  const cols = ['pending', 'in_progress', 'completed'];
  const colW = (W - 80) / cols.length;
  cols.forEach((st, i) => {
    const x = 40 + i * colW;
    if (i) {
      ctx.strokeStyle = '#d6cdc0';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x - 6, 110);
      ctx.lineTo(x - 6, H - 30);
      ctx.stroke();
    }
    const mine = items.filter((it) => it.status === st);
    ctx.fillStyle = '#2b2a28';
    ctx.font = `52px ${HAND}`;
    ctx.fillText(`${TODO_STATUS[st].label} (${mine.length})`, x + 10, 158);
    const nw = 260;
    const nh = 168;
    const per = Math.max(1, Math.floor((colW - 20) / (nw + 12)));
    const maxRows = Math.floor((H - 250) / (nh + 14));
    mine.slice(0, per * maxRows).forEach((it, k) => {
      const r = rng(hash(`${it.role}|${it.text}`));
      const nx = x + 10 + (k % per) * (nw + 12);
      const ny = 190 + Math.floor(k / per) * (nh + 14);
      ctx.save();
      ctx.translate(nx + nw / 2, ny + nh / 2);
      ctx.rotate((r() - 0.5) * 0.08);
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      ctx.fillRect(-nw / 2 + 4, -nh / 2 + 6, nw, nh);
      ctx.fillStyle = TODO_STATUS[st].note;
      ctx.fillRect(-nw / 2, -nh / 2, nw, nh);
      ctx.fillStyle = whoOf(it.role).css;
      ctx.fillRect(-nw / 2, -nh / 2, nw, 8);
      ctx.fillStyle = '#2b2a28';
      ctx.font = `36px ${HAND}`;
      ctx.fillText(fit(ctx, whoOf(it.role).name, nw - 28), -nw / 2 + 14, -nh / 2 + 46);
      ctx.font = `30px ${HAND}`;
      wrap(ctx, it.text, -nw / 2 + 14, -nh / 2 + 84, nw - 26, 30, 3);
      ctx.restore();
    });
    const extra = mine.length - per * maxRows;
    if (extra > 0) {
      ctx.fillStyle = '#6f6a62';
      ctx.font = `34px ${HAND}`;
      ctx.fillText(`+${extra} lagi`, x + 10, H - 40);
    }
  });
  if (!items.length) {
    ctx.fillStyle = '#9a938a';
    ctx.font = `44px ${HAND}`;
    ctx.textAlign = 'center';
    ctx.fillText('Belum ada daftar tugas dari agent.', W / 2, H / 2 + 40);
    ctx.font = `34px ${HAND}`;
    ctx.fillText('Muncul otomatis saat agent memakai TodoWrite / TaskCreate.', W / 2, H / 2 + 96);
    ctx.textAlign = 'left';
  }
  tex.needsUpdate = true;
}
function drawCommits(cm) {
  const { ctx, canvas, tex } = roadmapBoard;
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#fdfdfc';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#2f5bd3';
  ctx.font = `72px ${HAND}`;
  ctx.fillText('Commit terbaru', 50, 90);
  const items = cm?.items || [];
  ctx.fillStyle = '#6f6a62';
  ctx.font = `40px ${HAND}`;
  ctx.fillText(fit(ctx, cm?.available ? `sumber: git log · ${items.length} commit` : `sumber: git — ${cm?.reason || 'belum dibaca'}`, W - 640), 600, 88);
  if (!items.length) {
    ctx.fillStyle = '#9a938a';
    ctx.font = `44px ${HAND}`;
    ctx.fillText(cm?.available ? 'Belum ada commit.' : 'Riwayat commit tidak tersedia.', 50, 200);
  }
  items.slice(0, 10).forEach((c, i) => {
    const y = 175 + i * 86;
    ctx.fillStyle = '#b08a3a';
    ctx.font = `38px ${HAND}`;
    ctx.fillText(c.hash, 50, y);
    ctx.fillStyle = '#2b2a28';
    ctx.font = `40px ${HAND}`;
    ctx.fillText(fit(ctx, c.subject, W - 620), 250, y);
    ctx.fillStyle = '#6f6a62';
    ctx.font = `34px ${HAND}`;
    ctx.fillText(fit(ctx, ago(c.t), 300), W - 330, y);
    ctx.strokeStyle = 'rgba(43,42,40,.12)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(50, y + 26);
    ctx.lineTo(W - 50, y + 26);
    ctx.stroke();
  });
  tex.needsUpdate = true;
}
function drawHotFiles(hot) {
  const { ctx, canvas, tex } = cork;
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = '#c69c6d';
  ctx.fillRect(0, 0, W, H);
  const r = rng(21);
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = r() > 0.5 ? 'rgba(120,80,40,.18)' : 'rgba(255,230,190,.14)';
    ctx.fillRect(r() * W, r() * H, 3, 3);
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(40, 30, 760, 90);
  ctx.fillStyle = '#2b2a28';
  ctx.font = `50px ${HAND}`;
  ctx.fillText('File paling sering diubah', 60, 92);
  const list = hot || [];
  const notes = list.slice(0, 6).map((f) => {
    const slash = f.path.lastIndexOf('/');
    const names = f.roles.map((k) => whoOf(k).name).join(', ');
    return { c: '#ffffff', h: slash >= 0 ? f.path.slice(slash + 1) : f.path, t: `${f.count}× diubah${slash >= 0 ? ` · ${f.path.slice(0, slash)}/` : ''} · ${names}` };
  });
  if (!notes.length) notes.push({ c: '#dff1e3', h: 'Belum ada', t: 'Belum ada file yang diubah agent (Write/Edit) dalam 7 hari terakhir.' });
  notes.forEach((n, i) => {
    const nx = 50 + (i % 3) * 375;
    const ny = 160 + Math.floor(i / 3) * 350;
    ctx.save();
    ctx.translate(nx + 165, ny + 150);
    ctx.rotate((rng(i + 3)() - 0.5) * 0.1);
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.fillRect(-160, -140, 330, 300);
    ctx.fillStyle = n.c;
    ctx.fillRect(-165, -150, 330, 300);
    ctx.fillStyle = '#d64545';
    ctx.beginPath();
    ctx.arc(0, -135, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2b2a28';
    ctx.font = `40px ${HAND}`;
    ctx.fillText(fit(ctx, n.h, 300), -145, -90);
    ctx.font = `32px ${HAND}`;
    wrap(ctx, n.t, -145, -45, 300, 36, 5);
    ctx.restore();
  });
  tex.needsUpdate = true;
}

// ---------------------------------------------------------------- data real
let S = null;
let prevRuns = new Map();
let prevFeedKeys = new Set();
let prevQa = null;
let firstLoad = true;
let boardSig = '';

async function poll() {
  try {
    const r = await fetch(API, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    apply(await r.json());
  } catch {
    $('liveDot').classList.add('off');
    $('liveTxt').textContent = 'Terputus — mencoba lagi';
  } finally {
    setTimeout(poll, document.hidden ? POLL_MS * 4 : POLL_MS);
  }
}
function modeFor(w, now) {
  if (w.override && now < w.overrideUntil) return w.override;
  const a = w.data;
  switch (w.state) {
    case 'bekerja': {
      const e = a?.last?.[0];
      if (!e) return 'type';
      if (e.kind === 'text') return 'think';
      if (['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(e.tool)) return 'read';
      if (e.tool === 'Bash') return 'terminal';
      if (['Agent', 'Task', 'SendMessage', 'AskUserQuestion'].includes(e.tool)) return 'think';
      return 'type';
    }
    case 'menunggu':
      return 'wait';
    case 'selesai':
      return a?.updated && Date.now() - new Date(a.updated).getTime() < 90000 ? 'done' : 'coffee';
    case 'limit':
    case 'terhenti':
      return 'sleep';
    default:
      return 'coffee';
  }
}
function setBubble(el, text, cls = '') {
  if (!text) {
    el.className = 'bubble hide';
    return;
  }
  el.className = `bubble ${cls}`;
  if (el.textContent !== text) el.textContent = text;
}
function workerBubble(w, now) {
  if (w.override && now < w.overrideUntil) return [w.overrideText, ''];
  const a = w.data;
  switch (w.state) {
    case 'bekerja': {
      const t = a?.last?.[0]?.text || a?.task || 'Sedang bekerja';
      return [`${a?.parallel > 1 ? `(${a.parallel} tugas) ` : ''}${clip(t, 64)}`, ''];
    }
    case 'menunggu':
      return ['Butuh keputusanmu — cek tab Keputusan', 'warn'];
    case 'selesai':
      return w.mode === 'done' ? [`Beres: ${clip(a?.task || 'tugas selesai', 50)}`, ''] : ['', ''];
    case 'limit':
      return ['Zzz… jeda karena limit pemakaian', 'sleep'];
    case 'terhenti':
      return ['Terhenti, menunggu dilanjutkan', 'sleep'];
    default:
      return ['', ''];
  }
}

// susunan meja berubah (peran baru paling aktif / config diubah) → muat ulang halaman, paling sering 1× per menit
let reloading = false;
function maybeReload(d) {
  if (reloading || LAYOUT === null || typeof d.layout !== 'string' || d.layout === LAYOUT) return false;
  let last = 0;
  try { last = Number(sessionStorage.getItem('kerja.reloadAt') || 0); } catch { /* penyimpanan tidak tersedia */ }
  if (Date.now() - last < 60000) return false;
  try { sessionStorage.setItem('kerja.reloadAt', String(Date.now())); } catch { /* abaikan */ }
  reloading = true;
  location.reload();
  return true;
}
const NO_AGENT = { state: 'siaga', parallel: 0, task: null, since: null, updated: null, last: [], final: null, limit: null, files: [], runs: 0, tools: 0, tokens_out: 0, tokens_all: 0 };

function apply(d) {
  if (maybeReload(d)) return;
  // peran di halaman tapi (sementara) tidak ada di state → tampil siaga, jangan error
  for (const role of [...ROLE_KEYS, 'orkestrator']) if (!d.agents[role]) d.agents[role] = { ...NO_AGENT };
  S = d;
  EXTRA_WHO = Object.fromEntries((d.overflow || []).map((o) => [o.key, { key: o.key, name: o.name, role: o.role, css: o.color || '#9a938a' }]));
  $('liveDot').classList.remove('off');
  $('liveTxt').textContent = `Live · ${hhmmss(d.now)}`;
  const now = performance.now();

  for (const role of ROLE_KEYS) {
    const w = workers[role];
    const a = d.agents[role];
    const prev = w.state;
    w.data = a;
    w.state = a.state;
    if (!firstLoad && prev !== a.state && a.state === 'selesai' && PEOPLE[role].screen !== 'evidence') {
      w.override = 'celebrate';
      w.overrideUntil = now + 3500;
      w.overrideText = `Selesai! ${clip(a.task || '', 40)}`;
    }
  }
  risko.state = d.agents.orkestrator.state;
  // istirahat hanya bila tidak ada yang bekerja — termasuk sesi utama (project tanpa subagent pun terlihat bekerja)
  const keysAll = [...ROLE_KEYS, 'orkestrator'];
  const anyWorking = keysAll.some((r) => d.agents[r].state === 'bekerja');
  const lastUpd = Math.max(0, ...keysAll.map((r) => (d.agents[r].updated ? Date.parse(d.agents[r].updated) : 0)));
  setBreak(!anyWorking && Date.now() - lastUpd > 90000);

  // event baru -> anggukan
  const keys = new Set(d.feed.map((e) => `${e.t}|${e.role}|${e.text}`));
  if (!firstLoad) {
    for (const e of d.feed) {
      const k = `${e.t}|${e.role}|${e.text}`;
      if (prevFeedKeys.has(k)) continue;
      const w = workers[e.role];
      if (w) w.p.nod = 0.18;
      else if (e.role === 'orkestrator') risko.p.nod = 0.15;
    }
  }
  const fresh = firstLoad ? new Set() : new Set([...keys].filter((k) => !prevFeedKeys.has(k)));
  prevFeedKeys = keys;

  // Risko mendelegasikan / menerima hasil
  for (const r of d.runs) {
    const p = prevRuns.get(r.id);
    if (!firstLoad && PEOPLE[r.role]) {
      const nm = PEOPLE[r.role].name;
      if (!p && r.status === 'bekerja') riskoSend(r.role, `${nm}, tolong: ${clip(r.description, 48)}`);
      else if (p && p.status === 'bekerja' && r.status === 'selesai') riskoSend(r.role, `Mantap ${nm}, hasilnya kuterima!`);
    }
    prevRuns.set(r.id, r);
  }

  // verdict QA baru -> Lulu bereaksi
  const latestQa = d.qa.find((q) => q.verdict);
  const qaKey = latestQa ? `${latestQa.file}|${latestQa.verdict}` : null;
  if (!firstLoad && qaKey && qaKey !== prevQa && QA_ROLE) {
    const lulu = workers[QA_ROLE.key];
    const pass = latestQa.verdict === 'PASS';
    lulu.override = pass ? 'celebrate' : 'facepalm';
    lulu.overrideUntil = now + 5000;
    lulu.overrideText = pass ? `Plan ${latestQa.plan} lulus QA!` : `Ada bug di ${latestQa.plan}, balik ke ${DEV_ROLE ? DEV_ROLE.name : 'developer'} ya`;
  }
  prevQa = qaKey;

  const auto = d.mode === 'auto';
  const sig = JSON.stringify(auto
    ? ['auto', d.fallback, (d.overflow || []).map((o) => o.key)]
    : ['planning', d.plans.map((p) => [p.id, p.status, p.tasks_done, p.title]), (d.roadmap.modules || []).map((m) => [m.id, m.progress, m.plan_status]), d.pending_questions.length, (d.deferred || []).length]);
  if (sig !== boardSig) {
    boardSig = sig;
    if (auto) {
      drawTodoBoard(d.fallback);
      drawCommits(d.fallback?.commits);
      drawHotFiles(d.fallback?.hot_files);
    } else {
      drawKanban(d.plans || []);
      drawRoadmap(d.roadmap);
      drawCork(d);
    }
  }
  renderUi(d, fresh);
  firstLoad = false;
}

// ---------------------------------------------------------------- UI HTML
function renderUi(d, fresh) {
  const auto = d.mode === 'auto';
  const mods = d.roadmap.modules || [];
  const todoItems = auto ? (d.fallback?.todos || []).flatMap((l) => l.items) : [];
  const todoDone = todoItems.filter((it) => it.status === 'completed').length;
  const pct = auto
    ? (todoItems.length ? Math.round((100 * todoDone) / todoItems.length) : 0)
    : (mods.length ? Math.round(mods.reduce((s, m) => s + (m.progress || 0), 0) / mods.length) : 0);
  $('pctLabel').textContent = auto ? 'Progres tugas' : 'Progres roadmap';
  $('pct').textContent = auto && !todoItems.length ? '–' : `${pct}%`;
  $('pctBar').style.width = `${pct}%`;
  const done = d.plans.filter((p) => p.status === 'done').length;
  $('sPlansLabel').textContent = auto ? 'Tugas selesai' : 'Plan selesai';
  $('sPlans').textContent = auto ? (todoItems.length ? `${todoDone}/${todoItems.length}` : '0') : d.plans.length ? `${done}/${d.plans.length}` : '0';
  $('sTools').textContent = fmtNum.format(d.totals.tools);
  $('sTok').textContent = fmtCompact.format(d.totals.tokens);
  $('sRuns').textContent = fmtNum.format(d.totals.runs);

  const working = ROLE_KEYS.filter((r) => d.agents[r].state === 'bekerja');
  const limited = ROLE_KEYS.filter((r) => d.agents[r].state === 'limit');
  const pending = d.pending_questions || [];
  const orkBusy = d.agents.orkestrator?.state === 'bekerja';
  let phase;
  if (!ROLE_KEYS.length && !orkBusy) phase = 'Belum ada agent — meja muncul otomatis saat agent pertama bekerja di project ini';
  else if (BREAK.on) phase = 'Waktunya istirahat ☕ — nonton, main PS, ngopi & ngobrol. Otomatis kembali kerja saat ada agent bekerja lagi.';
  else if (limited.length) phase = 'Istirahat sebentar: limit pemakaian tercapai — lanjut otomatis saat limit aktif lagi';
  else if (working.length) phase = `Sedang bekerja: ${working.map((r) => `${PEOPLE[r].name} (${d.agents[r].task || PEOPLE[r].role})`).join(' · ')}`;
  else if (pending.length) phase = `${ASKER_NAME} menunggu keputusanmu: ${pending.length} pertanyaan`;
  else if (orkBusy) phase = `${RISKO.name} sedang bekerja di sesi utama`;
  else if (auto) phase = 'Tim sedang santai — menunggu tugas berikutnya';
  else if (!d.roadmap.exists) phase = 'Belum ada roadmap';
  else phase = d.plans.length && done === d.plans.length ? 'Semua plan selesai 🎉' : 'Tim sedang santai — menunggu langkah berikutnya';
  $('phase').textContent = phase;
  $('phase').title = phase;

  const banner = $('banner');
  banner.className = 'banner';
  if (limited.length) {
    banner.classList.add('show', 'bad');
    banner.textContent = `${limited.map((r) => PEOPLE[r].name).join(', ')} jeda karena limit pemakaian. ${d.agents[limited[0]].limit || ''}`;
  } else if (pending.length && !working.length) {
    banner.classList.add('show', 'warn');
    banner.textContent = `${ASKER_NAME} menunggu keputusanmu — ${pending.length} pertanyaan. Buka tab “Keputusan”.`;
  }

  const feedHtml = d.feed.slice(0, 80).map((e) => {
    const k = `${e.t}|${e.role}|${e.text}`;
    const who = whoOf(e.role);
    return `<li class="k-${e.kind}${fresh.has(k) ? ' fresh' : ''}"><span class="av" style="background:${who.css}">${esc(who.name[0])}</span><div><div class="meta"><span class="who" style="color:${who.css}">${esc(who.name)}</span><time>${esc(hhmmss(e.t))}</time></div><div class="txt">${esc(e.text)}</div></div></li>`;
  }).join('') || '<li><div class="empty" style="grid-column:1/-1">Belum ada aktivitas.</div></li>';
  for (const id of ['feed', 'feed2']) $(id).innerHTML = feedHtml;
  $('feedCount').textContent = fmtNum.format(d.feed.length);

  // label tab mengikuti mode: planning (Roadmap/Keputusan/Output/Bukti) atau cadangan (Commit/Tugas/File)
  const labels = auto ? { roadmap: 'Commit', keputusan: 'Tugas', output: 'File', bukti: '' } : { roadmap: 'Roadmap', keputusan: 'Keputusan', output: 'Output', bukti: REVIEW_LABEL === 'Uji QA' ? 'Bukti QA' : 'Bukti' };
  for (const [tab, label] of Object.entries(labels)) {
    const b = document.querySelector(`[data-tab="${tab}"]`);
    if (!b) continue;
    b.hidden = label === '';
    b.querySelector('.tl').textContent = label;
    if (b.hidden && b.getAttribute('aria-selected') === 'true') document.querySelector('[data-tab="roadmap"]').click();
  }
  if (auto) renderAutoPanes(d);
  else renderPlanningPanes(d, mods, pending);

  const hasMore = (d.overflow || []).length > 0;
  $('cards').style.gridTemplateColumns = `repeat(${ROLE_KEYS.length + 1}, minmax(0, 1fr))${hasMore ? ' minmax(0, .8fr)' : ''}`;
  $('cards').classList.toggle('compact', ROLE_KEYS.length + 1 + (hasMore ? 1 : 0) > 5);
  $('cards').innerHTML = [...ROLE_KEYS, 'orkestrator'].map((role) => {
    const a = d.agents[role];
    const who = WHO[role];
    const resting = BREAK.on && (role === 'orkestrator' || (a.state !== 'bekerja' && a.state !== 'limit'));
    const sc = resting ? '#c98a00' : STATES[a.state]?.css || '#9a938a';
    const stLabel = resting ? 'Istirahat ☕' : STATES[a.state]?.label || a.state;
    const act = a.last?.[0]?.text || (a.final ? a.final.split('\n')[0] : '—');
    return `<button class="card card-ui ${a.state === 'bekerja' ? 'working' : ''}" data-focus="${role}" style="--c:${who.css}"><span class="ava">${esc(who.name[0])}</span><div class="h"><span class="nm">${esc(who.name)}</span><span class="role">${esc(who.role)}</span><span class="chip st" style="color:${sc}"><i></i>${esc(stLabel)}${a.parallel > 1 ? ` ×${a.parallel}` : ''}</span></div><div class="task">${esc(a.task || (role === 'orkestrator' ? 'Mengatur alur tim' : 'Belum ada tugas'))}</div><div class="act" title="${esc(act)}">${esc(act)}</div><div class="nums"><span>${fmtNum.format(a.tools)} aksi</span><span>${fmtCompact.format(a.tokens_all)} tok</span><span>${a.runs} sesi</span></div></button>`;
  }).join('') + (hasMore ? moreCard(d.overflow) : '');
}

// agent tanpa meja (lebih dari 6 peran): ditampilkan jujur, tidak disembunyikan
function moreCard(list) {
  const title = list.map((o) => `${o.name} (${o.role}) — ${STATES[o.state]?.label || o.state}${o.updated ? `, ${ago(o.updated)}` : ''}${o.task ? `: ${o.task}` : ''}`).join('\n');
  const busy = list.filter((o) => o.state === 'bekerja').length;
  return `<div class="card card-ui more" title="${esc(title)}" tabindex="0" aria-label="${esc(`${list.length} agent lain tanpa meja: ${list.map((o) => o.name).join(', ')}`)}"><span class="ava" style="--c:#9a938a">+${list.length}</span><div class="h"><span class="nm">+${list.length} agent lain</span>${busy ? `<span class="chip st" style="color:#23a55f"><i></i>${busy} bekerja</span>` : ''}</div><div class="task">${list.slice(0, 3).map((o) => `<span class="dotc" style="background:${esc(o.color || '#9a938a')}"></span>${esc(o.name)}`).join(' ')}${list.length > 3 ? ' …' : ''}</div><div class="act">tanpa meja — meja untuk yang paling baru aktif</div></div>`;
}

function renderAutoPanes(d) {
  const fb = d.fallback || {};
  const cm = fb.commits || { available: false, reason: 'belum dibaca', items: [] };
  $('paneRoadmap').innerHTML = `<div class="src">Sumber: <b>git log</b>${cm.available ? ` · ${cm.items.length} commit terbaru` : ` — ${esc(cm.reason || 'tidak tersedia')}`}</div>`
    + (cm.items.length ? cm.items.map((c) => `<div class="row"><code>${esc(c.hash)}</code><span class="t" title="${esc(c.subject)}">${esc(c.subject)}</span><time>${esc(ago(c.t))}</time></div>`).join('') : '<div class="empty">Belum ada commit.</div>');
  const lists = fb.todos || [];
  const open = lists.reduce((n, l) => n + l.items.filter((it) => it.status !== 'completed').length, 0);
  $('paneQ').innerHTML = '<div class="src">Sumber: <b>daftar tugas agent</b> (TodoWrite / TaskCreate di transkrip)</div>'
    + (lists.length ? lists.map((l) => {
      const who = whoOf(l.role);
      return `<h3 class="sub" style="color:${who.css}">${esc(who.name)} · ${esc(ago(l.t))}</h3>${l.items.map((it) => `<div class="todo s-${esc(it.status)}"><i>${it.status === 'completed' ? '✓' : it.status === 'in_progress' ? '▶' : '○'}</i><span>${esc(it.text)}</span></div>`).join('')}`;
    }).join('') : '<div class="empty">Belum ada daftar tugas dari agent.</div>');
  const nQ = $('nQ');
  nQ.textContent = open;
  nQ.classList.remove('hot');
  const hot = fb.hot_files || [];
  const max = Math.max(1, ...hot.map((f) => f.count));
  $('paneDocs').innerHTML = '<div class="src">Sumber: <b>event Write/Edit</b> di transkrip (7 hari terakhir)</div>'
    + (hot.length ? hot.map((f) => `<div class="mod"><div class="h"><span class="nm" title="${esc(f.path)}">${esc(f.path)}</span><span class="pc">${f.count}×</span></div><div class="bar"><i style="width:${Math.round((100 * f.count) / max)}%;background:#3f6fd1"></i></div><div class="meta">${f.roles.map((k) => `<span class="chip"><i style="color:${whoOf(k).css}"></i>${esc(whoOf(k).name)}</span>`).join('')}<span class="chip">${esc(ago(f.last))}</span></div></div>`).join('') : '<div class="empty">Belum ada file yang diubah agent.</div>');
  $('nDocs').textContent = hot.length;
  $('paneEv').innerHTML = '';
  $('nEv').textContent = '0';
}

function renderPlanningPanes(d, mods, pending) {
  let rm = '';
  if (!d.roadmap.exists) {
    rm = `<div class="empty">${ASKER && d.agents[ASKER.key]?.state === 'bekerja' ? `${esc(ASKER.name)} sedang menyusun roadmap dari brief…` : 'Roadmap belum dibuat.'}</div>`;
  } else {
    rm += `<button class="doc" data-doc="planning/ROADMAP.md"><b>ROADMAP.md</b><time>${esc(ago(d.roadmap.updated))}</time><small>${mods.length} modul · ${(d.roadmap.phases || []).length} fase · klik untuk membaca</small></button>`;
    const ph = d.roadmap.phases || [];
    if (ph.length) {
      const byId = Object.fromEntries(mods.map((m) => [m.id, m]));
      rm += `<ol class="phases">${ph.map((p) => {
        const ids = (p.modules.match(/M\d{2}/g) || []).filter((v, i, a) => a.indexOf(v) === i);
        const prog = ids.length ? Math.round(ids.reduce((s, id) => s + (byId[id]?.progress || 0), 0) / ids.length) : 0;
        const active = ids.some((id) => ['in-progress', 'ready-for-qa', 'qa-failed', 'approved', 'draft'].includes(byId[id]?.plan_status));
        return `<li class="${prog >= 100 ? 'done' : active ? 'active' : ''}"><span class="pn">${p.n}</span><div><b>${esc(p.name)}</b><small>${esc(ids.join(' · '))}</small></div><span class="pp">${prog}%</span></li>`;
      }).join('')}</ol>`;
    }
    rm += mods.map((m) => {
      const col = m.progress >= 100 ? '#2f9a6d' : m.plan_status ? PLAN_STATUS[m.plan_status]?.css || '#3f6fd1' : '#3f6fd1';
      const chips = [
        m.status ? `<span class="chip"><i style="color:${m.status === 'SUDAH' ? '#2f9a6d' : m.status === 'SEBAGIAN' ? '#3f6fd1' : '#9a938a'}"></i>Audit: ${esc(m.status.toLowerCase())}</span>` : '',
        m.size ? `<span class="chip">Ukuran ${esc(m.size)}</span>` : '',
        m.plan_status ? `<span class="chip" style="color:${PLAN_STATUS[m.plan_status]?.css || '#9a938a'}"><i></i>${esc(PLAN_STATUS[m.plan_status]?.label || m.plan_status)}</span>` : '',
        m.plans?.length ? `<span class="chip">Plan ${esc(m.plans.join(', '))}</span>` : '',
      ].join('');
      return `<div class="mod"><div class="h"><span class="id">${esc(m.id)}</span><span class="nm" title="${esc(m.name)}">${esc(m.name)}</span><span class="pc" style="color:${col}">${m.progress}%</span></div><div class="bar"><i style="width:${m.progress}%;background:${col}"></i></div><div class="meta">${chips}</div></div>`;
    }).join('');
  }
  $('paneRoadmap').innerHTML = rm;

  const qs = [...(d.roadmap.questions || [])].sort((a, b) => (a.answered - b.answered) || ((b.tag === 'BLOKIR') - (a.tag === 'BLOKIR')));
  let qh = qs.length ? qs.map((q) => `<div class="q ${q.answered ? 'done' : q.tag === 'BLOKIR' ? 'pending' : ''}"><div class="h"><span class="qid">${esc(q.id)}</span><span class="t">${esc(q.title)}</span>${q.answered ? '<span class="chip" style="color:#2f9a6d">Dijawab</span>' : q.tag ? `<span class="chip">${esc(q.tag)}</span>` : ''}</div>${q.recommendation ? `<div class="rec">Rekomendasi ${esc(ASKER_NAME)}: ${esc(q.recommendation)}</div>` : ''}</div>`).join('') : `<div class="empty">Belum ada pertanyaan dari ${esc(ASKER_NAME)}.</div>`;
  const dfr = d.deferred || [];
  if (dfr.length) {
    qh += `<h3 class="sub">Ditunda — dilewati dulu (${dfr.filter((x) => !x.done).length})</h3>` + dfr.map((x) => `<div class="q ${x.done ? 'done' : ''}"><div class="h"><span class="qid" style="color:#9a938a">${esc(x.plan)}</span><span class="t">${esc(x.item)}</span>${x.done ? '<span class="chip" style="color:#2f9a6d">Beres</span>' : ''}</div><div class="rec">${esc(x.reason)}${x.need ? ` · Butuh: ${esc(x.need)}` : ''}</div></div>`).join('');
  }
  $('paneQ').innerHTML = qh;
  const nQ = $('nQ');
  nQ.textContent = pending.length || qs.length;
  nQ.classList.toggle('hot', pending.length > 0);

  const qaByPath = Object.fromEntries(d.qa.map((q) => [q.path, q]));
  const planByPath = Object.fromEntries(d.plans.map((p) => [p.path, p]));
  $('paneDocs').innerHTML = d.docs.length ? d.docs.map((doc) => {
    const q = qaByPath[doc.path];
    const p = planByPath[doc.path];
    let chip = '';
    if (q?.verdict) chip = `<span class="chip verdict" style="color:${q.verdict === 'PASS' ? '#2f9a6d' : '#d64545'}"><i></i>${q.verdict}</span>`;
    else if (p) chip = `<span class="chip verdict" style="color:${PLAN_STATUS[p.status]?.css || '#9a938a'}"><i></i>${esc(PLAN_STATUS[p.status]?.label || p.status)}</span>`;
    return `<button class="doc" data-doc="${esc(doc.path)}"><b>${esc(doc.title)}</b><time>${esc(ago(doc.updated))}</time><small>${esc(doc.path)}</small>${chip}</button>`;
  }).join('') : '<div class="empty">Belum ada dokumen.</div>';
  $('nDocs').textContent = d.docs.length;

  $('paneEv').innerHTML = d.evidence.length ? `<div class="gallery">${d.evidence.map((e) => `<button data-ev="${esc(e.path)}" title="${esc(e.path)}"><img loading="lazy" src="/kerja/evidence/${e.path.split('/').map(encodeURIComponent).join('/')}?t=${encodeURIComponent(e.updated)}" alt="${esc(e.name)}"><span>${esc(e.path)}</span></button>`).join('')}</div>` : '<div class="empty">Belum ada screenshot bukti QA.</div>';
  $('nEv').textContent = d.evidence.length;

}

// ---------------------------------------------------------------- interaksi
// panel bisa diperkecil; ponsel default kecil; pilihan diingat per penonton
function setMin(side, on) {
  const panel = document.querySelector(`.side.${side}`);
  if (!panel) return;
  panel.classList.toggle('min', on);
  document.body.classList.toggle(`min-${side}`, on);
  const b = panel.querySelector('.minbtn');
  b.setAttribute('aria-expanded', String(!on));
  b.title = on ? 'Buka panel' : 'Perkecil panel';
  try { localStorage.setItem(`kerja.min.${side}`, on ? '1' : '0'); } catch { /* abaikan */ }
}
for (const side of ['left', 'right']) {
  let saved = null;
  try { saved = localStorage.getItem(`kerja.min.${side}`); } catch { /* abaikan */ }
  setMin(side, saved === null ? innerWidth <= 820 : saved === '1');
}
document.addEventListener('click', (e) => {
  const mb = e.target.closest('[data-min]');
  if (mb) {
    const side = mb.dataset.min;
    setMin(side, !document.querySelector(`.side.${side}`).classList.contains('min'));
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    if (document.querySelector('.side.right').classList.contains('min')) setMin('right', false);
    document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b === tab)));
    document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('on', p.dataset.pane === tab.dataset.tab));
    return;
  }
  const doc = e.target.closest('[data-doc]');
  if (doc) {
    openDoc(doc.dataset.doc);
    return;
  }
  const ev = e.target.closest('[data-ev]');
  if (ev) {
    $('lbTitle').textContent = ev.dataset.ev;
    $('lbImg').src = ev.querySelector('img').src;
    $('lightbox').showModal();
    return;
  }
  const f = e.target.closest('[data-focus]');
  if (f) focusOn(f.dataset.focus);
});
function setLapang(on) {
  document.body.classList.toggle('lapang', on);
  $('togglePanel').textContent = on ? 'Tampilkan panel' : 'Lihat kantor penuh';
  try { localStorage.setItem('kerja.lapang', on ? '1' : '0'); } catch { /* penyimpanan tidak tersedia */ }
  onResize();
}
$('togglePanel').onclick = () => setLapang(!document.body.classList.contains('lapang'));
addEventListener('keydown', (e) => { if (e.key === 'h' && !e.target.closest('input,textarea') && !document.querySelector('dialog[open]')) setLapang(!document.body.classList.contains('lapang')); });
$('readerClose').onclick = () => $('reader').close();
$('lbClose').onclick = () => $('lightbox').close();
for (const id of ['reader', 'lightbox']) $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).close(); });
async function openDoc(path) {
  $('readerTitle').textContent = path;
  $('readerBody').innerHTML = '<div class="empty">Memuat…</div>';
  $('reader').showModal();
  try {
    const r = await fetch(`/kerja/api/doc?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    const md = (await r.text()).replace(/^---\n[\s\S]*?\n---\n/, '');
    $('readerBody').innerHTML = DOMPurify.sanitize(marked.parse(md));
  } catch {
    $('readerBody').innerHTML = '<div class="empty">Dokumen tidak bisa dimuat.</div>';
  }
}

let tween = null;
function focusOn(role) {
  let target;
  let pos;
  if (role === 'orkestrator') {
    target = risko.p.root.position.clone().add(new THREE.Vector3(0, 1.2, 0));
    pos = target.clone().add(new THREE.Vector3(3.2, 2.2, 4.2));
  } else if (workers[role]) {
    const x = PEOPLE[role].deskX;
    target = new THREE.Vector3(x, 1.2, -3.9);
    pos = new THREE.Vector3(x + 1.6, 3.0, 1.6);
  } else return;
  tween = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target };
}
renderer.domElement.addEventListener('dblclick', () => {
  tween = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: HOME.pos.clone(), t1: HOME.target.clone() };
});
const ray = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; tween = null; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const hit = pick(e);
  if (hit?.userData.role) focusOn(hit.userData.role);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  renderer.domElement.style.cursor = pick(e)?.userData.role ? 'pointer' : '';
});
function pick(e) {
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  return ray.intersectObjects(pickables, false)[0]?.object || null;
}
function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.fov = innerWidth < 820 ? 58 : innerWidth < 1180 ? 42 : document.body.classList.contains('lapang') ? 34 : 38;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
  document.querySelector('.mfeed').hidden = innerWidth > 1180;
}
addEventListener('resize', onResize);
try { if (localStorage.getItem('kerja.lapang') === '1') document.body.classList.add('lapang'); } catch { /* abaikan */ }
onResize();
if (document.body.classList.contains('lapang')) $('togglePanel').textContent = 'Tampilkan panel';

// siang / malam mengikuti jam asli penonton
let nightState = null;
function updateDaylight() {
  const h = new Date().getHours();
  const night = h >= 18 || h < 6;
  if (night === nightState) return;
  nightState = night;
  paintSky(night);
  sun.intensity = night ? 0.25 : 2.3;
  hemi.intensity = night ? 0.45 : 1.05;
  scene.background.set(night ? '#d9d3ca' : '#e9e3da');
  for (const w of Object.values(workers)) w.lamp.intensity = night ? 4 : 0;
}

// ---------------------------------------------------------------- loop animasi
const clock = new THREE.Clock();
const tmpV = new THREE.Vector3();
let lastClock = 0;
function frame() {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const now = performance.now();

  if (t - lastClock > 1) {
    lastClock = t;
    drawClock();
    updateDaylight();
  }

  for (const w of Object.values(workers)) {
    const mode = modeFor(w, now);
    if (mode !== w.mode) {
      w.mode = mode;
      w.sig = '';
    }
    if (w.actor.free) updateActor(w.actor, dt, t, now);
    if (!w.actor.free) {
    // kursi berputar menghadap kamera saat menunggu/merayakan
    const faceCam = mode === 'wait' || mode === 'celebrate' || mode === 'done';
    const target = faceCam ? Math.atan2(camera.position.x - w.seat.position.x, camera.position.z - w.seat.position.z) : Math.PI;
    let diff = target - w.seat.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    w.seat.rotation.y += diff * Math.min(1, dt * 3);
    w.p.nod = Math.max(0, w.p.nod - dt * 0.6);
    applyPose(w.p, seatedPose(mode, t, w.seed), dt);
    w.p.spine.position.y = 0.06 + Math.sin(t * 1.6 + w.seed) * 0.004;
    w.handMug.visible = mode === 'coffee';
    w.deskMug.visible = mode !== 'coffee';
    } else {
      w.deskMug.visible = true;
    }
    // layar
    const sig = JSON.stringify([w.state, mode, w.data?.task, w.data?.last?.[0]?.t, w.data?.tools, S?.docs?.[0]?.updated, S?.evidence?.[0]?.path]);
    if (sig !== w.sig || now - w.drawnAt > 20000) {
      w.sig = sig;
      w.drawnAt = now;
      drawMain(w);
      drawSide(w);
    }
    // gelembung + nama
    w.p.head.getWorldPosition(tmpV);
    w.label.position.set(tmpV.x, tmpV.y + 0.42, tmpV.z);
    if (w.actor.free || BREAK.on) setBubble(w.bubble, now < w.actor.bubbleUntil ? w.actor.bubbleText : '');
    else {
      const [txt, cls] = workerBubble(w, now);
      setBubble(w.bubble, txt, cls);
    }
  }

  // Risko: antre -> jalan ke meja -> bicara -> kembali (atau ikut istirahat)
  const rp = risko.p;
  if (risko.actor.free) {
    updateActor(risko.actor, dt, t, now);
    rp.head.getWorldPosition(tmpV);
    risko.label.position.set(tmpV.x, tmpV.y + 0.42, tmpV.z);
    setBubble(risko.bubble, now < risko.actor.bubbleUntil ? risko.actor.bubbleText : '');
  } else {
  if (!risko.task && risko.queue.length) {
    const q = risko.queue.shift();
    risko.task = { ...q, stage: 'go', until: 0, path: routeTo(q.role), i: 0 };
  }
  let goal = null;
  let walking = false;
  let talking = false;
  if (risko.task) {
    const tk = risko.task;
    if (tk.stage === 'go' || tk.stage === 'back') goal = tk.path[tk.i];
    else if (tk.stage === 'talk') {
      talking = true;
      if (now > tk.until) {
        tk.stage = 'back';
        tk.path = [...routeTo(tk.role).slice(0, 2).reverse(), RISKO_HOME];
        tk.i = 0;
      }
    }
    if (goal) {
      tmpV.subVectors(goal, rp.root.position).setY(0);
      const dist = tmpV.length();
      if (dist > 0.06) {
        walking = true;
        const step = Math.min(dist, 1.5 * dt);
        rp.root.position.addScaledVector(tmpV.normalize(), step);
        risko.heading = turnTo(risko.heading, Math.atan2(tmpV.x, tmpV.z), dt * 6);
      } else if (tk.i < tk.path.length - 1) {
        tk.i++;
      } else if (tk.stage === 'go') {
        tk.stage = 'talk';
        tk.until = now + 3800;
      } else {
        risko.task = null;
      }
    }
    if (talking) {
      const x = PEOPLE[tk.role].deskX;
      risko.heading = turnTo(risko.heading, Math.atan2(x - rp.root.position.x, -3.35 - rp.root.position.z), dt * 5);
    }
  } else {
    risko.heading = turnTo(risko.heading, RISKO_IDLE_HEADING, dt * 3);
  }
  rp.root.rotation.y = risko.heading;
  risko.phase += dt * (walking ? 9 : 0);
  const sw = Math.sin(risko.phase);
  const atBoard = !risko.task && risko.state === 'bekerja';
  const T = {
    hipsY: 0.9 + (walking ? Math.abs(Math.cos(risko.phase)) * 0.03 : 0),
    spineX: walking ? 0.05 : 0.02,
    headX: atBoard ? -0.12 : talking ? -0.02 : 0.25,
    headY: talking ? Math.sin(t * 2) * 0.1 : 0,
    lHipX: walking ? sw * 0.5 : 0, rHipX: walking ? -sw * 0.5 : 0,
    lKneeX: walking ? Math.max(0, -sw) * 0.7 : 0, rKneeX: walking ? Math.max(0, sw) * 0.7 : 0,
    lShX: -0.55, lShZ: 0.3, lElX: -1.3,
    rShX: atBoard ? -1.9 + Math.sin(t * 3) * 0.12 : talking ? -0.9 + Math.sin(t * 4) * 0.25 : -0.55,
    rShZ: -0.3, rElX: atBoard ? -0.4 : talking ? -0.9 : -1.3,
  };
  rp.nod = Math.max(0, rp.nod - dt * 0.6);
  applyPose(rp, T, dt);
  rp.head.getWorldPosition(tmpV);
  risko.label.position.set(tmpV.x, tmpV.y + 0.42, tmpV.z);
  if (talking) setBubble(risko.bubble, risko.task.text);
  else if (walking) setBubble(risko.bubble, risko.task?.stage === 'go' ? `Menuju meja ${PEOPLE[risko.task.role].name}…` : '');
  else if (atBoard) setBubble(risko.bubble, 'Merapikan papan tugas');
  else setBubble(risko.bubble, '');
  }

  // suasana istirahat: obrolan receh, TV jadi game saat ada yang main PS
  breakChatter(now);
  const player = actors.find((x) => x.free && x.arrived && x.goal === 'ps');
  LOUNGE_PADS[1].visible = !player;
  if (player) {
    if (now - BREAK.gameAt > 120) {
      drawGame(t, player.name);
      BREAK.gameAt = now;
      BREAK.tvMode = 'game';
    }
  } else if (BREAK.tvMode === 'game') {
    drawTv();
    BREAK.tvMode = 'tv';
  }

  if (tween) {
    tween.t = Math.min(1, tween.t + dt / 1.2);
    const e = 1 - Math.pow(1 - tween.t, 3);
    camera.position.lerpVectors(tween.p0, tween.p1, e);
    controls.target.lerpVectors(tween.t0, tween.t1, e);
    if (tween.t >= 1) tween = null;
  }
  controls.target.x = THREE.MathUtils.clamp(controls.target.x, ROOM.x0 + 1, ROOM.x1 - 1);
  controls.target.z = THREE.MathUtils.clamp(controls.target.z, ROOM.z0 + 1, ROOM.z1 - 1);
  controls.target.y = THREE.MathUtils.clamp(controls.target.y, 0.3, 3.5);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
function turnTo(cur, target, k) {
  const d = Math.atan2(Math.sin(target - cur), Math.cos(target - cur));
  return cur + d * Math.min(1, k);
}

let started = false;
function ready() {
  if (started) return;
  started = true;
  $('loading').classList.add('gone');
  setTimeout(() => $('loading').remove(), 900);
}
// papan memakai font tulisan tangan — gambar ulang setelah font siap
document.fonts?.load(`40px ${HAND}`).then(() => { boardSig = ''; if (S) apply(S); }).catch(() => {});
drawKanban([]);
drawRoadmap(null);
drawCork({ pending_questions: [], deferred: [], roadmap: { questions: [] } });
updateDaylight();
drawClock();
document.fonts?.ready.then(drawTv).catch(() => {});
frame();
poll();
setTimeout(ready, 600);
