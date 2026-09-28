#!/usr/bin/env bash
# Buka (ulang) tunnel publik untuk kantor 3D: https://<acak>.trycloudflare.com/kerja  (butuh cloudflared)
# Asal lokal:
#   - "host" di kerja/config.json (mis. kerja.proyek.test di Valet https) → tunnel ke https://127.0.0.1:443 dengan Host itu
#   - tanpa host → http://127.0.0.1:${KERJA_PORT:-8787} (server PHP bin/serve.sh ATAU Node bin/serve-node.mjs)
# Timpa dengan env: KERJA_HOST=… atau KERJA_ORIGIN=http://127.0.0.1:9000
# URL aktif ditulis ke kerja/storage/tunnel-url.txt (juga tampil di halaman). Hentikan: kill "$(cat kerja/storage/tunnel.pid)"
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$DIR/storage/tunnel.log"
PIDF="$DIR/storage/tunnel.pid"
mkdir -p "$DIR/storage/cache"
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared belum terpasang (macOS: brew install cloudflared; Linux: lihat developers.cloudflare.com)." >&2; exit 1
fi
if [[ -f "$PIDF" ]] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
  echo "tunnel sudah jalan (pid $(cat "$PIDF")): $(cat "$DIR/storage/tunnel-url.txt" 2>/dev/null)"; exit 0
fi
# host dari config.json tanpa bergantung pada PHP: php → node → sed
config_host() {
  local f="$DIR/config.json"
  [[ -f "$f" ]] || return 0
  if command -v php >/dev/null 2>&1; then
    php -r '$c = json_decode((string) @file_get_contents($argv[1]), true); echo is_array($c) && is_string($c["host"] ?? null) ? $c["host"] : "";' "$f"
  elif command -v node >/dev/null 2>&1; then
    node -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(typeof c.host === "string" ? c.host : ""); } catch {}' "$f"
  else
    sed -n 's/.*"host"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1
  fi
}
HOST="${KERJA_HOST:-$(config_host)}"
ORIGIN="${KERJA_ORIGIN:-http://127.0.0.1:${KERJA_PORT:-8787}}"
: > "$LOG"
if [[ -n "$HOST" && -z "${KERJA_ORIGIN:-}" ]]; then
  nohup cloudflared tunnel --no-autoupdate --url https://127.0.0.1:443 \
    --http-host-header "$HOST" --origin-server-name "$HOST" --no-tls-verify >>"$LOG" 2>&1 &
else
  if ! curl -s -o /dev/null --max-time 3 "$ORIGIN/kerja/api/state"; then
    echo "peringatan: $ORIGIN/kerja belum menjawab — jalankan dulu bin/serve.sh atau bin/serve-node.mjs" >&2
  fi
  nohup cloudflared tunnel --no-autoupdate --url "$ORIGIN" >>"$LOG" 2>&1 &
fi
echo $! > "$PIDF"
for _ in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  if [[ -n "$URL" ]] && grep -q "Registered tunnel connection" "$LOG"; then
    echo "$URL/kerja" > "$DIR/storage/tunnel-url.txt"; echo "$URL/kerja"; exit 0
  fi
  sleep 1
done
echo "tunnel belum siap — lihat $LOG" >&2; exit 1
