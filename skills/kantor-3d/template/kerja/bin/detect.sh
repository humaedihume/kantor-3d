#!/usr/bin/env bash
# Cek runtime yang tersedia untuk kantor 3D (tidak mengubah apa pun).
ok() { printf '  %-12s %s\n' "$1" "$2"; }
echo "Kantor 3D — deteksi lingkungan"
if command -v php >/dev/null 2>&1; then
  v=$(php -r 'echo PHP_VERSION;'); php -r 'exit(PHP_VERSION_ID >= 80100 ? 0 : 1);' && ok php "$v (cukup, ≥ 8.1)" || ok php "$v (TERLALU LAMA, butuh ≥ 8.1)"
  php -r 'exit(function_exists("mb_strlen") ? 0 : 1);' || ok php-mbstring "TIDAK ADA (wajib untuk server PHP)"
else ok php "tidak ada"; fi
if command -v node >/dev/null 2>&1; then
  v=$(node -v); [[ "${v#v}" =~ ^([0-9]+) ]] && (( BASH_REMATCH[1] >= 18 )) && ok node "$v (cukup, ≥ 18)" || ok node "$v (TERLALU LAMA, butuh ≥ 18)"
else ok node "tidak ada"; fi
command -v valet >/dev/null 2>&1 && ok valet "ada" || ok valet "tidak ada"
command -v nginx >/dev/null 2>&1 && ok nginx "ada" || ok nginx "tidak ada"
command -v cloudflared >/dev/null 2>&1 && ok cloudflared "ada" || ok cloudflared "tidak ada (opsional, untuk URL publik)"
command -v git >/dev/null 2>&1 && ok git "ada" || ok git "tidak ada (papan commit akan kosong + alasannya)"
H="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
P="$(cd "$(dirname "$0")/../.." && pwd -P)"
S="$H/projects/$(printf '%s' "$P" | sed 's/[^a-zA-Z0-9]/-/g')"
[[ -d "$S" ]] && ok transkrip "$S ($(find "$S" -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ') file)" || ok transkrip "$S (belum ada — muncul setelah Claude Code dipakai di folder project ini)"
