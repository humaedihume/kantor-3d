#!/usr/bin/env bash
# Cetak konfigurasi untuk menyajikan kantor 3D di https://<domain>/kerja lewat Nginx, menumpang di server block domain
# yang sudah ada. Skrip ini TIDAK mengubah apa pun: tinjau hasilnya, minta izin pemilik server, lalu terapkan sendiri.
#   bash kerja/bin/nginx.sh [domain]          → PHP-FPM (pool khusus, jalan sebagai user pemilik project)
#   bash kerja/bin/nginx.sh [domain] --node   → reverse proxy ke server Node (bin/serve-node.mjs) + unit systemd
# Server berjalan sebagai user pemilik project karena transkrip ada di ~/.claude/projects dan folder home biasanya 750.
set -euo pipefail
KERJA="$(cd "$(dirname "$0")/.." && pwd -P)"
PROJECT="$(dirname "$KERJA")"
DOMAIN="<domain>"
MODE=php
for a in "$@"; do
  case "$a" in
    --node) MODE=node ;;
    --php) MODE=php ;;
    -*) echo "opsi tidak dikenal: $a" >&2; exit 2 ;;
    *) DOMAIN="$a" ;;
  esac
done
RUN_USER="${KERJA_USER:-$(id -un)}"
HOME_DIR="$(getent passwd "$RUN_USER" 2>/dev/null | cut -d: -f6 || true)"
HOME_DIR="${HOME_DIR:-$HOME}"
SLUG="$(basename "$PROJECT" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9\n' '-')"

if [[ "$MODE" == node ]]; then
  NODE_BIN="$(command -v node || echo /usr/bin/node)"
  PORT="${KERJA_PORT:-8787}"
  UNIT="/etc/systemd/system/kerja-$SLUG.service"
  cat <<EOF2
# ── 1) $UNIT  (server Node, hanya mendengar di 127.0.0.1:$PORT) ──
[Unit]
Description=Kantor 3D tim AI ($PROJECT)
After=network.target

[Service]
User=$RUN_USER
Environment=HOME=$HOME_DIR
Environment=KERJA_PORT=$PORT
Environment=KERJA_BIND=127.0.0.1
ExecStart=$NODE_BIN $KERJA/bin/serve-node.mjs
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target

# ── 2) Tempel di dalam server { … } $DOMAIN (443), sebelum "location / {" ──
    # Kantor 3D tim AI (read-only) — $KERJA
    location = /kerja  { proxy_pass http://127.0.0.1:$PORT; proxy_set_header Host \$host; proxy_http_version 1.1; }
    location ^~ /kerja/ { proxy_pass http://127.0.0.1:$PORT; proxy_set_header Host \$host; proxy_http_version 1.1; }
    # Opsional (tidak untuk umum): auth_basic "Kantor"; auth_basic_user_file /etc/nginx/kerja.htpasswd;  (di kedua location)

# ── 3) Terapkan (sudo, setelah disetujui) ──
#   sudo nano $UNIT                                   # isi bagian 1
#   sudo systemctl daemon-reload && sudo systemctl enable --now kerja-$SLUG
#   curl -s http://127.0.0.1:$PORT/kerja/api/state | head -c 200            # JSON
#   sudo nano /etc/nginx/sites-available/<site>.conf  # isi bagian 2
#   sudo nginx -t && sudo systemctl reload nginx
#   curl -s -o /dev/null -w '%{http_code}\n' https://$DOMAIN/kerja            # 200
# Lalu isi "public_url": "https://$DOMAIN/kerja" di kerja/config.json (tanpa tunnel).
EOF2
  exit 0
fi

PHPV="${KERJA_PHP:-$(php -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;' 2>/dev/null || true)}"
if [[ -z "$PHPV" ]]; then
  echo "PHP belum terpasang. Pasang dulu (butuh sudo), mis.: sudo apt install php8.3-fpm php8.3-cli php8.3-mbstring" >&2
  echo "Atau pakai Node: bash kerja/bin/nginx.sh $DOMAIN --node" >&2
  exit 1
fi
POOL="/etc/php/$PHPV/fpm/pool.d/kerja-$SLUG.conf"
SOCK="/run/php/kerja-$SLUG.sock"

cat <<EOF2
# ── 1) $POOL ──
[kerja-$SLUG]
user = $RUN_USER
group = $RUN_USER
listen = $SOCK
listen.owner = www-data
listen.group = www-data
listen.mode = 0660
pm = ondemand
pm.max_children = 4
pm.process_idle_timeout = 30s
env[HOME] = $HOME_DIR
env[PATH] = /usr/local/bin:/usr/bin:/bin
; hanya yang dibaca kantor 3D: kerja/, planning/, agent project, tim-ai.json, .git (cek repo; git log jalan sebagai proses terpisah), transkrip
php_admin_value[open_basedir] = $KERJA:$PROJECT/planning:$PROJECT/.claude/agents:$PROJECT/.claude/tim-ai.json:$PROJECT/.git:$HOME_DIR/.claude/projects

# ── 2) Tempel di dalam server { … } $DOMAIN (443), sebelum "location / {" ──
    # Kantor 3D tim AI (read-only) — $KERJA
    location = /kerja  { include fastcgi_params; fastcgi_param SCRIPT_FILENAME $KERJA/public/index.php; fastcgi_pass unix:$SOCK; }
    location ^~ /kerja/ { include fastcgi_params; fastcgi_param SCRIPT_FILENAME $KERJA/public/index.php; fastcgi_pass unix:$SOCK; }
    # Opsional, bila tidak ingin terbuka untuk umum (buat file dengan: sudo htpasswd -c /etc/nginx/kerja.htpasswd <user>):
    # location = /kerja  { auth_basic "Kantor"; auth_basic_user_file /etc/nginx/kerja.htpasswd; … }  (sama untuk /kerja/)

# ── 3) Terapkan (sudo, setelah disetujui) ──
#   sudo nano $POOL                      # isi bagian 1
#   sudo php-fpm$PHPV -t && sudo systemctl reload php$PHPV-fpm
#   sudo nano /etc/nginx/sites-available/<site>.conf   # isi bagian 2
#   sudo nginx -t && sudo systemctl reload nginx
#   curl -s -o /dev/null -w '%{http_code}\n' https://$DOMAIN/kerja            # 200
#   curl -s https://$DOMAIN/kerja/api/state | head -c 200                     # JSON
# Lalu isi "public_url": "https://$DOMAIN/kerja" di kerja/config.json (tanpa tunnel).
# Papan commit memakai git lewat proc_open; bila proc_open dimatikan (disable_functions) papan itu menulis alasannya.
EOF2
