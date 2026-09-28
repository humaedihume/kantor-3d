---
name: kantor-3d
description: Pasang "Kantor 3D" — visualisasi kantor three.js di <host>/kerja yang menampilkan agent Claude Code sebuah project bekerja atau istirahat berdasarkan data nyata (transkrip ~/.claude/projects + planning/ bila ada). Tanpa konfigurasi — peran/karakter ditemukan otomatis (.claude/agents, agentType di transkrip, awalan "Peran: …"), papan dinding memakai planning/ atau cadangan (daftar tugas agent, git log, file yang sering diubah). Jalan di PHP ≥ 8.1 ATAU Node ≥ 18 (Valet, php -S, Node, Nginx), tunnel publik opsional. Cocok untuk project apa pun (kode, konten, riset, cron `claude -p`). Pakai saat user ingin memasang/memperbarui dashboard /kerja atau "kantor 3D" saja, tanpa tim agent (untuk tim + kantor pakai skill tim-ai).
argument-hint: [--node | --php] [--host kerja.xxx.test] [--publik] [--domain domain.com]
---

Brief teknis lengkap: `${CLAUDE_SKILL_DIR}/BRIEF.md` (baca §3 penemuan peran, §4 papan, §9 kustomisasi bila perlu).
Template: `${CLAUDE_SKILL_DIR}/template/kerja/` → disalin ke `<project>/kerja/`.

Argumen user: $ARGUMENTS

## Langkah (di root project saat ini — folder tempat Claude Code dijalankan)

1. **Cek lingkungan:** `bash ${CLAUDE_SKILL_DIR}/template/kerja/bin/detect.sh` (PHP/Node/Valet/Nginx/cloudflared/git +
   folder transkrip project). Pilih runtime: `--php`/`--node` dari argumen; bila tidak ada → PHP ≥ 8.1 (+ mbstring)
   bila tersedia, selain itu Node ≥ 18. Tidak ada keduanya → beri tahu user cara memasang salah satunya, berhenti.
2. **Salin template:** `rsync -a ${CLAUDE_SKILL_DIR}/template/kerja/ ./kerja/` (tanpa rsync: `mkdir -p kerja && cp -R ${CLAUDE_SKILL_DIR}/template/kerja/. ./kerja/`). Bila `kerja/` sudah ada: tanya dulu
   (AskUserQuestion) — perbarui kode saja dengan `rsync -a --exclude config.json --exclude storage/ …` atau batal.
   Jangan pernah menimpa `kerja/config.json` atau `kerja/storage/` milik user.
   Tambahkan `kerja/storage/` ke `.gitignore` (buat bila perlu); bila ada graphify/indexer, kecualikan `kerja/`.
3. **Config (opsional):** tanpa `kerja/config.json` semuanya otomatis (nama project = nama folder). Buat hanya bila
   user minta nama karakter/warna/urutan/sembunyikan peran, `host`, atau `public_url` — salin dari
   `config.example.json` dan hapus yang tidak perlu (BRIEF §9). Format lama `team{}`/`roles[]` tetap terbaca.
4. **Serve** (pilih satu; jalankan server di background):
   - **Valet** (macOS, PHP): `ln -sfn "$PWD/kerja" ~/.config/valet/Sites/<nama-site>` → `https://<nama-site>.test/kerja`;
     isi `"host": "<nama-site>.test"` di config (untuk tunnel).
   - **PHP bawaan:** `nohup bash kerja/bin/serve.sh > kerja/storage/serve.log 2>&1 &` → `http://127.0.0.1:8787/kerja`
     (`KERJA_PORT` untuk port lain).
   - **Node:** `nohup node kerja/bin/serve-node.mjs > kerja/storage/serve.log 2>&1 &` → port & rute sama.
   - **Server Linux + domain (Nginx):** `bash kerja/bin/nginx.sh <domain>` (PHP-FPM) atau `… <domain> --node`
     (reverse proxy + unit systemd). Skrip hanya MENCETAK konfigurasi. **Minta izin user sebelum** memasang paket,
     menulis pool/unit, mengedit Nginx, atau reload — itu server produksi. Tawarkan `auth_basic` bila domainnya publik.
     Setelah aktif isi `public_url` di config.
5. **URL publik (opsional, `--publik`):** `bash kerja/bin/tunnel.sh` (cloudflared; URL acak ditulis ke
   `kerja/storage/tunnel-url.txt` dan tampil di halaman). Ingatkan: siapa pun yang tahu link bisa membukanya (read-only).
6. **Verifikasi:** `node kerja/bin/check.mjs <url-dasar>` (halaman, JSON, header noindex, 404 path terlarang, redaksi)
   atau `curl` bila Node tidak ada. Bila Playwright tersedia: screenshot 1440 & 390 lebar, buka PNG-nya, 0 error
   konsol, tidak ada scroll horizontal di 390. Bila PHP **dan** Node ada: `node kerja/bin/parity.mjs` (harus "PARITY OK").
7. **Laporkan:** URL lokal/publik, runtime & cara menghentikan server, peran yang terdeteksi (dari `/kerja/api/state`
   → `roles`, `overflow`), mode papan (`planning` atau cadangan), dan konvensi agar data tampil:
   - agent kustom di `.claude/agents/<nama>.md` (frontmatter `name`, `description`, `color`); agent umum diberi
     deskripsi berawalan peran (`Penulis: …`) supaya duduk di meja peran itu;
   - saat menghentikan agent dengan TaskStop, tambahkan id agent ke `kerja/storage/stopped.txt` (langsung "Terhenti");
   - job cron/headless: jalankan `claude -p …` **di folder project** agar transkripnya ikut tampil.

## Aturan
- Read-only terhadap project: jangan mengubah kode/konten aplikasi; semua milik skill ini ada di `kerja/`.
- Tidak ada data palsu/dummy: data kosong → papan/karakter kosong atau istirahat, dengan label sumbernya.
- Jangan menyalin rahasia ke config atau dokumen; jangan membuka port ke publik tanpa persetujuan user.
