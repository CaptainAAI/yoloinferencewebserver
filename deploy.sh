#!/usr/bin/env bash
# Deploys the YOLO inference web dashboard (server.js + public/) on this Jetson.
#
# Run it ON the Jetson, from a clone of this repository:
#
#   git clone https://github.com/CaptainAAI/yoloinferencewebserver.git
#   cd yoloinferencewebserver
#   bash deploy.sh             install and restart in the background (nohup)
#   bash deploy.sh --service   install as a systemd service that also starts after a
#                              reboot (asks for your sudo password)
#   bash deploy.sh --status    only show what is running
#
# To update later: git pull && bash deploy.sh
#
# Settings (environment variables):
#   WEB_DIR     folder the dashboard runs in    default ~/yoloinferenceweb
#   WEB_PORT    port                            default 8080 (3000 is another app on the Jetson)
#   INFER_PORT  port of server.py on this Jetson, default 6767
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="${WEB_DIR:-$HOME/yoloinferenceweb}"
WEB_PORT="${WEB_PORT:-8080}"
INFER_PORT="${INFER_PORT:-6767}"
MODE="${1:-}"
UNIT=yolo-dashboard

say()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

port_pid() { ss -ltnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true; }
has_unit() { [ -f "/etc/systemd/system/$1.service" ]; }

wait_http() {  # url seconds
  for _ in $(seq 1 "$2"); do curl -fs -m 2 -o /dev/null "$1" && return 0; sleep 1; done
  return 1
}

stop_port() {  # stops the process (of this user) listening on port $1
  local pid; pid="$(port_pid "$1")"
  [ -z "$pid" ] && return 0
  echo "stopping pid $pid on port $1: $(ps -o cmd= -p "$pid")"
  kill "$pid"
  for _ in $(seq 1 30); do [ -z "$(port_pid "$1")" ] && return 0; sleep 1; done
  fail "port $1 is still in use"
}

status() {
  say "Status"
  ss -ltn | grep -E ":$WEB_PORT " || echo "nothing listening on $WEB_PORT"
  has_unit "$UNIT" && echo "systemd $UNIT: $(systemctl is-active "$UNIT" || true)"
  if curl -fs -m 3 -o /dev/null "http://127.0.0.1:$WEB_PORT/"; then
    echo "dashboard, at any of this Jetson's addresses:"
    for ip in $(hostname -I); do echo "  http://$ip:$WEB_PORT"; done
    curl -fs -m 3 -o /dev/null "http://127.0.0.1:$WEB_PORT/api/models" \
      && echo "  server.py reachable through /api" \
      || warn "  server.py not reachable on port $INFER_PORT (deploy yoloinferencemodel)"
    curl -fs -m 3 -o /dev/null "http://127.0.0.1:$WEB_PORT/images-api/health" \
      && echo "  image server reachable through /images-api" \
      || warn "  image server not reachable (deploy yoloinferenceimageserver if you save images)"
  else
    warn "the dashboard does not answer on port $WEB_PORT"
  fi
}

if [ "$MODE" = "--status" ]; then status; exit 0; fi
[ -z "$MODE" ] || [ "$MODE" = "--service" ] || fail "unknown option $MODE (use --service or --status)"

# ----- 1. Check what is needed -----
say "Checking requirements"
[ -f "$SRC/server.js" ] && [ -d "$SRC/public" ] || fail "server.js or public/ not found in $SRC"
command -v node >/dev/null || fail "node not found (Node.js 18 or newer is needed)"
command -v npm >/dev/null || fail "npm not found"
echo "node $(node -v), npm $(npm -v)"

# ----- 2. Install the files -----
say "Installing the dashboard to $WEB_DIR"
mkdir -p "$WEB_DIR"
cp -f "$SRC/package.json" "$SRC/server.js" "$WEB_DIR/"
[ -f "$SRC/package-lock.json" ] && cp -f "$SRC/package-lock.json" "$WEB_DIR/"
rm -rf "$WEB_DIR/public"
cp -r "$SRC/public" "$WEB_DIR/public"
(cd "$WEB_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

# ----- 3. (Re)start -----
if [ "$MODE" = "--service" ]; then
  say "Installing systemd service $UNIT (sudo)"
  stop_port "$WEB_PORT"
  sudo tee "/etc/systemd/system/$UNIT.service" >/dev/null <<UNIT
[Unit]
Description=YOLO inference dashboard (port $WEB_PORT)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$WEB_DIR
Environment=PORT=$WEB_PORT
Environment=YOLO_API=http://127.0.0.1:$INFER_PORT
ExecStart=$(command -v node) $WEB_DIR/server.js
Restart=on-failure
RestartSec=5
StandardOutput=append:$WEB_DIR/web.log
StandardError=append:$WEB_DIR/web.log

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable "$UNIT" >/dev/null
  sudo systemctl restart "$UNIT"
elif has_unit "$UNIT"; then
  say "Restarting the systemd service (installed earlier with --service)"
  sudo systemctl restart "$UNIT"
else
  say "Restarting the dashboard on port $WEB_PORT (background)"
  stop_port "$WEB_PORT"
  # Redirect the whole background subshell, so it never holds this terminal (or an ssh session) open
  (cd "$WEB_DIR" && PORT="$WEB_PORT" YOLO_API="http://127.0.0.1:$INFER_PORT" exec nohup node server.js) \
    >> "$WEB_DIR/web.log" 2>&1 < /dev/null &
fi
wait_http "http://127.0.0.1:$WEB_PORT/" 30 || fail "the dashboard did not start; see $WEB_DIR/web.log"

# ----- 4. Check -----
status
if [ -z "$MODE" ] && ! has_unit "$UNIT"; then
  warn "Running in the background with nohup: after a reboot run this script again, or use --service."
fi
