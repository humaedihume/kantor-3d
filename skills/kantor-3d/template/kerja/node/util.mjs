// Bantuan agar port Node berperilaku sama dengan PHP (trim, strlen multibyte, strcmp, glob, date('c'), redaksi).
// Setiap perubahan perilaku di src/*.php harus dicerminkan di sini dan diuji dengan bin/parity.mjs.
import fs from 'node:fs';
import path from 'node:path';

// \s PCRE tanpa /u = spasi ASCII saja
export const WS = '[ \\t\\n\\x0b\\f\\r]';
const PHP_TRIM = ' \t\n\r\0\x0B';

export function phpTrim(s, chars = PHP_TRIM) {
  s = String(s);
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}
export function phpLtrim(s, chars = PHP_TRIM) {
  s = String(s);
  let a = 0;
  while (a < s.length && chars.includes(s[a])) a++;
  return s.slice(a);
}
// mb_strlen / mb_substr = titik kode (bukan unit UTF-16)
export function mbLen(s) {
  let n = 0;
  for (const _ of String(s)) n++;
  return n;
}
export function clip(s, n) {
  s = String(s);
  if (mbLen(s) <= n) return s;
  return `${Array.from(s).slice(0, n - 1).join('')}…`;
}
// strcmp PHP: urutan byte UTF-8
export function strcmp(a, b) {
  a = String(a ?? '');
  b = String(b ?? '');
  if (a === b) return 0;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return Buffer.compare(ba, bb) < 0 ? -1 : 1;
}
export const cmpNum = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// strtolower PHP 8 = ASCII saja
export const lowerAscii = (s) => String(s).replace(/[A-Z]/g, (c) => c.toLowerCase());
export const isObj = (v) => v !== null && typeof v === 'object';
export const isPlainObj = (v) => isObj(v) && !Array.isArray(v);
// foreach PHP atas array/objek JSON
export const values = (v) => (Array.isArray(v) ? v : isPlainObj(v) ? Object.values(v) : []);
// (int) PHP untuk string: angka di depan, selain itu 0
export function phpInt(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return 0;
  const m = /^[ \t\n\r\x0b\f]*([+-]?\d+)/.exec(v);
  return m ? Number(m[1]) : 0;
}
// date('c', ts) dengan zona UTC → 2026-09-28T03:04:05+00:00
export function isoC(sec) {
  const d = new Date(sec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+00:00`;
}
export const nowSec = () => Math.floor(Date.now() / 1000);
export function mtimeSec(f) {
  try {
    return Math.floor(fs.statSync(f).mtimeMs / 1000);
  } catch {
    return 0;
  }
}
export function isFile(f) {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
}
export function isDir(f) {
  try {
    return fs.statSync(f).isDirectory();
  } catch {
    return false;
  }
}
export function readText(f) {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
}
// glob('<dir>/*<suffix>') PHP: tanpa file tersembunyi, terurut
export function globDir(dir, suffix) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => !n.startsWith('.') && n.endsWith(suffix) && n.length > suffix.length - (suffix.startsWith('.') ? 0 : 0))
    .sort((a, b) => strcmp(a, b)).map((n) => path.join(dir, n));
}
// pemisah baris \R (mode /u)
export const splitR = (s) => String(s).split(/\r\n|[\n\x0b\x0c\r\x85\u2028\u2029]/);
export const basename = (p, ext = '') => {
  const b = path.basename(p);
  return ext && b.endsWith(ext) && b !== ext ? b.slice(0, -ext.length) : b;
};

export function redact(s) {
  s = String(s);
  s = s.replace(/(pass(word)?|sandi|secret|token|api[_-]?key)(["'\t\n\x0b\f\r ]*[:=][\t\n\x0b\f\r ]*)([^\t\n\x0b\f\r ]+)/gi, '$1$3•••');
  s = s.replace(/--login=['"]?[^'"\t\n\x0b\f\r ]+/g, '--login=•••');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-•••');
  s = s.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '•••');
  return s.replace(/\b[a-f0-9]{40,}\b/gi, '•••');
}

export function firstLine(s) {
  for (let l of splitR(s)) {
    l = phpTrim(l.replace(/[#*`>|_]+/g, ' '));
    if (l !== '') return l.replace(/[ \t\n\x0b\f\r]+/g, ' ');
  }
  return '';
}

// str_replace(['**','`'], '', …)
export const stripMd = (s, extra = []) => [...extra, '**', '`'].reduce((acc, t) => acc.split(t).join(''), String(s));
