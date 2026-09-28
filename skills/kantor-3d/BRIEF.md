# BRIEF — Kantor 3D (visualisasi tim agent Claude Code, data nyata)

Halaman satu layar di `<host>/kerja` yang menampilkan agent Claude Code sebuah project sebagai karyawan di kantor 3D
(three.js). Semua yang tampil berasal dari **data nyata**: transkrip Claude Code project itu dan (bila ada) folder
`planning/`. Read-only, tanpa login, tanpa konfigurasi. Berjalan di **PHP ≥ 8.1** atau **Node ≥ 18** dengan rute & JSON
yang sama. Asal: dashboard "Ruang Kerja Tim" yang lahir di sebuah project internal (2026-09), dipecah menjadi skill
mandiri; tim agent-nya kini di skill `tim-ai`.

---

## 1. Tujuan & prinsip
- User bisa memantau "agent-ku sedang apa" dari HP/desktop tanpa membuka terminal — untuk project **apa pun** (kode,
  konten, riset, job cron `claude -p`), selama pekerjaannya berjalan lewat Claude Code di folder project itu.
- **Nol konfigurasi.** Peran, nama, warna, gaya karakter, dan papan terisi otomatis. `kerja/config.json` opsional.
- **Tidak ada data palsu.** Tidak ada aktivitas → karakter istirahat; tidak ada data papan → papan kosong + sumbernya.
- Suasana kantor manusia yang terang. Karakter dirakit prosedural (tanpa model eksternal).
- Aman dibagikan: hanya ringkasan aksi (nama tool + deskripsi/path), redaksi rahasia, tidak pernah isi `tool_result`.

## 2. Arsitektur

```
$CLAUDE_CONFIG_DIR|~/.claude/projects/<slug>/<session>.jsonl                          ← sesi utama (orkestrator)
                                         /<session>/subagents/agent-<id>.jsonl (+ .meta.json {agentType, description})
<project>/.claude/agents/*.md  (frontmatter name/description/color)  · <project>/.claude/tim-ai.json (opsional)
<project>/planning/ (ROADMAP, BACKLOG, DITUNDA, plans/, qa/, qa/evidence/)  — opsional
<project>/.git (git log)                                                                 — opsional
        │
        ▼  sumber kebenaran aturan: kerja/src/rules.json (dibaca kedua runtime)
  PHP:  src/Config.php · Discovery.php · Transcripts.php · Planning.php · Fallback.php · State.php · public/index.php
  Node: node/config.mjs · discovery.mjs · transcripts.mjs · planning.mjs · fallback.mjs · state.mjs · bin/serve-node.mjs
        │   (port satu-satu; kesetaraan dijaga bin/parity.mjs)
        ▼
   GET /kerja                → views/page.html + window.KERJA_CONFIG (peran terpilih, layout, team)
   GET /kerja/api/state      → JSON status (dipolling tiap 3 dtk)
   GET /kerja/api/doc?path=  → markdown di bawah planning/ (regex whitelist, tanpa ..) — sudah diredaksi
   GET /kerja/evidence/<rel> → PNG/JPG/WEBP bukti QA (regex whitelist)
   GET /kerja/assets/<file>  → hanya .js di public/assets (realpath dicek) — three.js r170, marked, DOMPurify, kantor.js
        ▼
   public/assets/kantor.js (three.js vendored, ES module + importmap) — satu file untuk kedua runtime
```

- Slug transkrip = path absolut (realpath) project dengan setiap karakter non-alfanumerik → `-`.
- `HOME` (atau `CLAUDE_CONFIG_DIR`) proses server menentukan folder transkrip → server harus berjalan sebagai user
  yang menjalankan Claude Code (Valet/`php -S`/Node lokal otomatis; Nginx: pool/unit sebagai user itu).
- Cache ringkasan per transkrip di `kerja/storage/cache/` (PHP `t-*.json`, Node `n-*.json`; hanya byte baru dibaca).
- Semua waktu keluar dalam UTC (`…+00:00` atau timestamp transkrip `…Z`); browser menampilkannya di jam lokal.

## 3. Penemuan peran otomatis (`Discovery`)
Kandidat peran, berurutan menurut sumber:
1. `kerja/config.json` → `roles[]` (atau format lama `team{}`): **dipin** (selalu dapat meja, urutan config).
2. Agent project `.claude/agents/*.md`: key = slug `name` (atau nama file); warna dari frontmatter `color`.
3. Setiap `agentType` di `.meta.json` transkrip 7 hari terakhir — termasuk bawaan (`general-purpose`, `Explore`,
   `Plan`, `claude`, `statusline-setup`, `claude-code-guide`, …) dan agent plugin/user.
4. Agent umum (`general-purpose`, `claude`, `Explore`, `Plan`) dengan deskripsi berawalan `Peran: …`/`Peran — …`
   → peran itu bila cocok dengan kandidat di atas (key, nama, label, `aliases`) atau kosakata tim di `rules.json`
   (`analyst`, `developer`, `developer-senior`, `developer-junior`, `qa`, `devops`, `editor`, `penulis`,
   `pemeriksa-fakta`, `peneliti`, `analis-data`, `penyunting`, `pemantau`, `pelapor` + alias `dev`, `analis`,
   `senior`, `junior`, `writer`, …). Awalan yang tidak dikenal tidak membuat peran baru (agent tetap di mejanya sendiri).
- Agent non-umum yang deskripsinya berawalan nama perannya sendiri (`Analyst: revisi …`) → tugas tanpa awalan.
- `hide` di config (atau `"hide": true` per peran) → peran dan run-nya tidak tampil sama sekali.
- `"auto": false` → hanya peran di config (perilaku lama; run lain diabaikan).

**Pemilihan meja** (maks `max_desks`, default & batas 6): peran config dulu, lalu yang **paling baru aktif**
(`updated` run terakhir), lalu agent project yang belum pernah aktif. Sisanya = `overflow`: ditampilkan jujur sebagai
kartu "+N agent lain" (nama, status, waktu aktif di tooltip) dan tetap muncul di feed dengan nama & warnanya.
**Urutan meja** stabil (tidak ikut berubah tiap ada aktivitas): config → agent project → lainnya, dalam kelompok
menurut `rules.json.order` lalu abjad. Bila susunan meja berubah (tanda `layout` di state ≠ halaman), halaman memuat
ulang sendiri (maks 1×/menit).

**Nama & gaya:** nama = config `name` → `rules.json.names` (mis. `general-purpose` → "Agen Umum") → key dimanusiakan
(`analis-data` → "Analis Data", akronim di `acronyms`). Label = config `role` → (bila config memberi nama karakter)
nama peran → asal peran ("Agent project", "Agent bawaan", "Agent", "Peran"). Warna = config `color` → frontmatter
`color` (blue/green/orange/pink/cyan/yellow/red/purple → hex) → warna preset analyst/developer/qa → palet
deterministik (hash key, tanpa bentrok). Gaya karakter = `PRESETS` (analyst/developer/qa) atau `EXTRA_LOOKS`
bergiliran dengan warna baju dari warna peran; `look` di config menimpa. Monitor kedua = `screen` config atau
otomatis dari key (`screenFor` di kantor.js): docs (analyst/editor/peneliti/pelapor/plan), files (developer/penulis/
analis-data/general), evidence (qa/review/pemeriksa-fakta/penyunting), commands (devops/pemantau/explore).
**Penanya** (status "Menunggu keputusanmu" saat ada `[BLOKIR]`): `asks_user` di config → peran `plan` di
`.claude/tim-ai.json` → `analyst` → meja pertama.

## 4. Papan dinding & panel
**Mode `planning`** — bila `planning/ROADMAP.md`, `planning/BACKLOG.md`, atau `planning/plans/` ada (format tim-ai):
- Whiteboard Roadmap (modul + progres), Papan Tugas (plan per kolom Rencana/Dikerjakan/Uji QA/Selesai — kolom ketiga
  "Direview" bila peninjau di tim-ai.json bukan `qa`), papan gabus "Perlu Keputusan" (`[BLOKIR]` + DITUNDA).
- Panel kanan: Roadmap · Keputusan · Output (dokumen markdown, disanitasi DOMPurify) · Bukti QA (galeri).
- Format yang dibaca (jaga!): ROADMAP baris `| Mxx | nama | SUDAH|SEBAGIAN|BELUM | NN% | S|M|L | plan |`, fase
  `| **N. nama** | modul (plan) | … |`, pertanyaan `### Qn. Judul — [BLOKIR|ASUMSI]` + `> ✅ **Jawaban user (tgl):** …`;
  plan `planning/plans/NNN-slug.md` frontmatter `id, judul, status, depends_on, qa_ronde`, tugas `- [ ]/[x]`, AC
  `| ACn |`; laporan `planning/qa/NNN-qa-rK.md` berisi `Verdict: PASS|FAIL`, bug `### Bn`; bukti di
  `planning/qa/evidence/**`; `planning/DITUNDA.md` baris `| YYYY-MM-DD | plan | item | alasan | butuh |`.
  Progres modul = % audit + porsi sisa × (tugas selesai/total; plan done = penuh). Plan `xyN` → modul `Mxy`.

**Mode cadangan `auto`** — project tanpa format planning. Setiap papan menulis sumbernya:
- **Papan Tugas** ← daftar tugas terbaru para agent: `TodoWrite` (`input.todos[] {content,status}`, daftar penuh
  menggantikan yang lama) atau `TaskCreate {subject}` / `TaskUpdate {taskId,status}` (id = urutan TaskCreate di
  transkrip itu, karena id asli hanya ada di tool_result yang tidak dibaca). Maks 8 daftar terbaru (subagent + 5 sesi
  utama terbaru), kolom Rencana / Dikerjakan / Selesai.
- **Whiteboard "Commit terbaru"** ← `git log -n 12` (tanpa shell: `proc_open`/`execFile` dengan array argumen,
  batas 3 dtk, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`). Tidak ada git / bukan repo / exec dimatikan /
  timeout → papan menulis alasannya. Subjek commit diredaksi.
- **Papan gabus "File paling sering diubah"** ← hitungan event `Write/Edit/MultiEdit/NotebookEdit` per path.
- Panel kanan: Commit · Tugas · File (tab Bukti disembunyikan); progres atas = tugas agent selesai.

## 5. Model data run
| Status | Aturan |
|---|---|
| `bekerja` | belum final & transkrip berubah ≤ 15 menit (sesi utama: ≤ 90 dtk) |
| `selesai` | teks akhir `stop_reason: end_turn` **atau** `SubagentHandback` |
| `terhenti` | belum final & > 15 menit, atau id agent ada di `kerja/storage/stopped.txt` (TaskStop) |
| `limit` | teks pendek berisi "usage limit / limit reached / resets at" |
| `menunggu` | tidak ada peran bekerja & ada `[BLOKIR]` belum dijawab (diberikan ke peran penanya) |
| `siaga` | belum ada run |

Event feed dari `tool_use`: Read/Write/Edit (path relatif project), Bash (deskripsi atau kata pertama perintah —
argumen tidak pernah ditampilkan), Grep/Glob, Agent ("Mendelegasikan: …"), TodoWrite/TaskCreate/TaskUpdate, Skill,
AskUserQuestion, SubagentHandback; teks assistant → baris pertama. Sesi utama hanya menampilkan delegasi & instruksi
user. Token dijumlah per `message.id` unik. Redaksi (`redact()`, sama di PHP & Node): `password|sandi|secret|token|
api_key = …`, `--login=…`, `sk-…`, `ghp_…`/`gho_…`, `xox?-…`, `AKIA…`, hex ≥ 40 → `•••`; diterapkan sebelum dan
sesudah teks dipotong.

## 6. Scene 3D, karakter, mode istirahat, UI
Detail di komentar `kantor.js`: ruang diorama 20×13 m, langit & lampu mengikuti jam penonton,
jam dinding real-time, 1–6 meja otomatis (≤3: x = −5/0/5; 4–6 dirapatkan, 6 meja skala 85%), dua monitor data nyata
per meja, pantry, TV + konsol, sofa, meja rapat, rak buku. Pose kerja dari event terakhir (ketik/baca/terminal/berpikir/
melambai/bersandar/tidur/sorak). Orkestrator berjalan ke meja saat run dimulai/selesai. **Istirahat** bila tidak ada
yang bekerja (termasuk sesi utama) > 90 dtk: 8 aktivitas bergiliran + obrolan receh. Tanpa peran sama sekali, kantor
hanya berisi orkestrator + pesan "meja muncul otomatis". UI 2D: bar atas (fase, progres, statistik), feed kiri, panel
kanan bertab, kartu karyawan (compact bila > 5, kartu "+N agent lain" untuk overflow), panel bisa diperkecil, tombol H
= kantor penuh. Ponsel: panel bawah transparan, kartu bergeser horizontal, tanpa scroll horizontal halaman.

## 7. Runtime & penyajian
| Cara | Perintah | Catatan |
|---|---|---|
| Valet | `ln -sfn "$PWD/kerja" ~/.config/valet/Sites/<site>` | `https://<site>.test/kerja`; `host` di config untuk tunnel |
| PHP bawaan | `bash kerja/bin/serve.sh` | `127.0.0.1:${KERJA_PORT:-8787}`; cek versi ≥ 8.1 |
| Node | `node kerja/bin/serve-node.mjs` | sama; `KERJA_BIND` untuk alamat lain (mis. di belakang proxy) |
| Nginx + PHP-FPM | `bash kerja/bin/nginx.sh <domain>` | mencetak pool (user pemilik project, `open_basedir` = kerja/, planning/, .claude/agents, tim-ai.json, .git, ~/.claude/projects) + 2 location |
| Nginx + Node | `bash kerja/bin/nginx.sh <domain> --node` | mencetak unit systemd (127.0.0.1) + 2 location `proxy_pass` |
| Tunnel | `bash kerja/bin/tunnel.sh` | cloudflared quick tunnel ke Valet host atau `127.0.0.1:$KERJA_PORT` (PHP/Node); `KERJA_ORIGIN` menimpa |

Alat: `bin/detect.sh` (lingkungan), `bin/check.mjs <url>` (smoke test), `bin/parity.mjs` (PHP vs Node: state kecuali
`now`, KERJA_CONFIG, doc, evidence, assets+ETag, header, 14 path terlarang → 404, pola rahasia tidak bocor;
`--forbid=<regex>` untuk string uji tambahan).

## 8. Keamanan & privasi
Read-only; header `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`; path
doc/evidence divalidasi regex (tanpa `..`), assets dibatasi realpath + ekstensi `.js`; hanya ringkasan tool_use yang
keluar; tool_result tidak pernah dibaca; git dijalankan tanpa shell; Node hanya GET/HEAD. URL publik (tunnel/domain)
= anggap publik; tawarkan `auth_basic`.

## 9. Kustomisasi (`kerja/config.json`, semua opsional)
| Kunci | Arti |
|---|---|
| `project` | judul (default nama folder) |
| `host` | host Valet https (untuk tunnel); kosong = `127.0.0.1:$KERJA_PORT` |
| `public_url` | URL tetap (mode Nginx); tunnel aktif lebih diutamakan |
| `auto` | `false` = hanya peran di `roles` |
| `max_desks` | 1–6 |
| `hide` | daftar key peran yang disembunyikan (mis. `["statusline-setup"]`) |
| `roles[]` | `key` (wajib), `name`, `role`, `color` (#rrggbb), `look` (`shirt/pants/skin/hair/hairStyle` short·curly·bun·side, `glasses`, `headphones`, `prop` notes·can·plant·server), `screen` (docs·files·evidence·commands), `asks_user`, `aliases[]`, `hide` — peran di sini dipin |
| `orchestrator` | `name`, `role` (default "Orkestrator", "Sesi utama") |
Format lama `{"team":{"analyst":{…},"developer":{…},"qa":{…},"orkestrator":{…}}}` = tiga peran dipin.
Kode: `rules.json` (kosakata, alias, nama bawaan, urutan, palet), `kantor.js` (`PRESETS`, `EXTRA_LOOKS`, `screenFor`,
`CHAT`/`QUIPS`, `SLOT_MS`, `CYCLE`, `SPOTS`), `Transcripts::RUNNING_WINDOW` (15 mnt). Ubah logika server → ubah PHP
**dan** Node lalu jalankan `node kerja/bin/parity.mjs`.

## 10. Verifikasi setelah pasang
1. `node kerja/bin/check.mjs <url>` → OK (atau `curl` `/kerja` 200 + `/kerja/api/state` JSON).
2. Screenshot 1440×900 & 390×844 (Playwright bila ada) → buka PNG; 0 pageerror/console.error; di 390
   `document.documentElement.scrollWidth === 390`.
3. Jalankan satu subagent (mis. deskripsi `Penulis: uji`) → meja baru muncul (halaman memuat ulang) & feed terisi.
4. PHP + Node tersedia → `node kerja/bin/parity.mjs` = PARITY OK.
5. Tunggu > 90 dtk tanpa aktivitas → mode istirahat.

## 11. Batasan
- Agent yang dihentikan paksa hanya terdeteksi via `stopped.txt` atau setelah 15 menit.
- Id TaskCreate/TaskUpdate diperkirakan dari urutan (tool_result tidak dibaca); daftar tugas yang dibagi lintas sesi
  bisa tidak cocok. TodoWrite selalu akurat.
- Maks 6 meja + orkestrator; peran lain di kartu "+N". Susunan meja berubah → halaman memuat ulang (maks 1×/menit).
- Hanya sesi utama terbaru yang menjadi orkestrator; 5 sesi utama terbaru dipakai untuk papan cadangan.
- Quick tunnel berganti URL saat di-restart; pakai Nginx + domain untuk URL tetap. Satu `/kerja` per domain.
- Kesetaraan PHP/Node diuji pada data nyata; beda teoretis tersisa pada input patologis (UTF-8 rusak di plan, spasi
  Unicode eksotis di judul) — `parity.mjs` akan menunjukkannya bila terjadi.
