#!/usr/bin/env bash
# Jalankan kantor 3D dengan server bawaan PHP (≥ 8.1): http://127.0.0.1:${KERJA_PORT:-8787}/kerja
# Tanpa PHP? Pakai Node (≥ 18): node kerja/bin/serve-node.mjs  (rute & JSON sama)
DIR="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v php >/dev/null 2>&1; then
  echo "PHP tidak ditemukan — pakai: node \"$DIR/bin/serve-node.mjs\"" >&2; exit 1
fi
if ! php -r 'exit(PHP_VERSION_ID >= 80100 ? 0 : 1);'; then
  echo "Butuh PHP ≥ 8.1 (terpasang $(php -r 'echo PHP_VERSION;')) — atau pakai Node: node \"$DIR/bin/serve-node.mjs\"" >&2; exit 1
fi
mkdir -p "$DIR/storage/cache"
exec php -S "${KERJA_BIND:-127.0.0.1}:${KERJA_PORT:-8787}" -t "$DIR/public" "$DIR/public/index.php"
