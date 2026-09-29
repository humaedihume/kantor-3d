# Changelog

Format mengikuti [Keep a Changelog](https://keepachangelog.com/id-ID/1.1.0/); versi mengikuti
[Semantic Versioning](https://semver.org/lang/id/).

## [1.0.0] — 2026-09-28
### Ditambahkan
- Rilis publik pertama sebagai plugin Claude Code (`kantor-3d@kantor-3d`) dengan marketplace sendiri
  (`/plugin marketplace add humaedihume/kantor-3d`), sekaligus bisa dipasang manual sebagai skill `/kantor-3d`.
- Skill `kantor-3d`: memasang dashboard read-only `<host>/kerja` — kantor 3D (three.js r170) dari transkrip Claude Code
  nyata, penemuan peran otomatis, mode papan `planning` dan cadangan (tugas agent, git log, file sering diubah),
  mode istirahat, tampilan ponsel.
- Dua runtime setara: PHP ≥ 8.1 dan Node ≥ 18 (`bin/parity.mjs`), plus Valet, Nginx (`bin/nginx.sh`), dan tunnel
  cloudflared (`bin/tunnel.sh`); alat `bin/detect.sh` dan `bin/check.mjs`.
- `THIRD_PARTY_NOTICES.md` dan berkas lisensi di samping pustaka vendored (three.js, marked, DOMPurify).
