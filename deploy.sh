#!/usr/bin/env bash
# deploy.sh - installs the YOLO inference web dashboard (server.js + public/) on this
# Jetson as the systemd service "yolo-dashboard", and manages that service.
#
# Run it ON the Jetson, as your normal user (not with sudo), from a clone of this
# repository. It asks for your sudo password once, to install system packages and
# the service:
#
#   git clone https://github.com/CaptainAAI/yoloinferencewebserver.git
#   cd yoloinferencewebserver
#   bash deploy.sh
#
# To update later:  git pull && bash deploy.sh
#
# Commands:
#   bash deploy.sh [install]     install or update everything, then (re)start the service
#   bash deploy.sh check         only check the requirements; installs and changes nothing
#   bash deploy.sh status        service state, port, addresses, links to the other servers, log
#   bash deploy.sh logs [N|-f]   the last N log lines (default 50), or -f to follow the log
#   bash deploy.sh start | stop | restart
#   bash deploy.sh unit          print the systemd unit file this script installs
#   bash deploy.sh uninstall     stop and remove the service (files stay)
#   bash deploy.sh help          this text
#
# What "install" does, step by step:
#   1. Requirements: installs what is missing with apt: curl, and Node.js + npm
#      (Node 18 or newer is needed; Ubuntu 24.04's nodejs package is 18).
#   2. Files: copies package.json, package-lock.json, server.js and public/ to WEB_DIR
#      (lists what changed), then installs the npm dependencies (express) there with
#      npm install --omit=dev.
#   3. Service: writes /etc/systemd/system/yolo-dashboard.service (prints the diff
#      when it changes) and enables it, so it starts at every boot.
#   4. Start: stops a copy of the dashboard started by hand (nohup) on the same port,
#      then restarts the service.
#   5. Wait: until the dashboard answers.
#   6. Report: the same output as "bash deploy.sh status".
#
# The service runs as your user, starts after the network (and after yolo-inference
# and yolo-images when they are installed), restarts 5 s after a crash, and appends
# its output to WEB_DIR/web.log.
#
# Settings (environment variables), e.g.  WEB_PORT=8081 bash deploy.sh
#   WEB_DIR      folder the dashboard runs in      default ~/yoloinferenceweb
#   WEB_PORT     port                              default 8080 (3000 is another app)
#   INFER_PORT   port of server.py on this Jetson  default 6767
# Settings given once are remembered in ~/.config/yolo-deploy/yolo-dashboard.env and
# used by later runs.
#
# Never touched: the log. Files in WEB_DIR that are not part of the dashboard stay.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT=yolo-dashboard
UNIT_FILE="/etc/systemd/system/$UNIT.service"
CONF="$HOME/.config/yolo-deploy/$UNIT.env"
SETTINGS="WEB_DIR WEB_PORT INFER_PORT"

# Remembered settings fill in what the environment does not set.
if [ -f "$CONF" ]; then
  while IFS='=' read -r key value; do
    case " $SETTINGS " in *" $key "*) if [ -z "${!key:-}" ]; then printf -v "$key" '%s' "$value"; fi ;; esac
  done < "$CONF"
fi
WEB_DIR="${WEB_DIR:-$HOME/yoloinferenceweb}"
WEB_PORT="${WEB_PORT:-8080}"
INFER_PORT="${INFER_PORT:-6767}"
START_TIMEOUT=30

PORT="$WEB_PORT"
LOG="$WEB_DIR/web.log"
HEALTH_URL="http://127.0.0.1:$PORT/"
RUN_USER="$(id -un)"
RUN_GROUP="$(id -gn)"
NODE="$(command -v node || echo /usr/bin/node)"
NODE_MIN=18

# ---------------------------------------------------------------- output helpers
if [ -t 1 ]; then G=$'\033[1;32m' Y=$'\033[1;33m' R=$'\033[1;31m' N=$'\033[0m'; else G='' Y='' R='' N=''; fi
STEP=0
STEPS=6
step() { STEP=$((STEP + 1)); printf '\n%s[%d/%d] %s%s\n' "$G" "$STEP" "$STEPS" "$*" "$N"; }
head2() { printf '\n%s==> %s%s\n' "$G" "$*" "$N"; }
info() { printf '    %s\n' "$*"; }
ok() { printf '    %sok%s    %s\n' "$G" "$N" "$*"; }
warn() { printf '    %swarn%s  %s\n' "$Y" "$N" "$*"; }
fail() { printf '\n%sERROR: %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
kv() { printf '    %-11s %s\n' "$1" "$2"; }

usage() { awk 'NR > 1 { if (/^set -euo/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"; }

# ---------------------------------------------------------------- sudo and apt
SUDO=sudo
need_sudo() {  # $1 = what sudo is needed for
  if [ "$(id -u)" -eq 0 ]; then SUDO=''; return; fi
  command -v sudo >/dev/null || fail "sudo not found; it is needed to $1"
  if ! sudo -n true 2>/dev/null; then
    info "sudo is needed to $1; enter your password if asked"
    [ -t 0 ] || fail "sudo needs your password but there is no terminal: run this in a terminal on the Jetson (or over ssh -t)"
    sudo -v || fail "sudo failed"
  fi
}

not_root() {
  if [ "$(id -u)" -eq 0 ]; then
    fail "run this as your normal user, without sudo (the service runs as the user who installs it); it asks for sudo itself"
  fi
}

APT_UPDATED=''
apt_install() {  # packages...
  need_sudo "install $*"
  if [ -z "$APT_UPDATED" ]; then
    info "apt-get update"
    $SUDO apt-get update -qq
    APT_UPDATED=1
  fi
  info "apt-get install $*"
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
}

CHECK_ONLY=''
MISSING=0
missing() {  # $1 = what is missing, $2 = what install would do
  warn "$1 missing (install would: $2)"
  MISSING=1
}

ensure_cmd() {  # command apt-package label
  if command -v "$1" >/dev/null; then ok "$3: $(command -v "$1")"; return; fi
  if [ -n "$CHECK_ONLY" ]; then missing "$3" "apt-get install $2"; return; fi
  apt_install "$2"
  command -v "$1" >/dev/null || fail "$3 still missing after apt-get install $2"
  ok "$3 installed: $(command -v "$1")"
}

# ---------------------------------------------------------------- systemd helpers
prop() { systemctl show -p "$1" --value "$UNIT" 2>/dev/null || true; }
in_service() { grep -q "/$UNIT.service" "/proc/$1/cgroup" 2>/dev/null; }
port_pids() { ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true; }
port_busy() { [ -n "$(ss -ltnH "sport = :$PORT" 2>/dev/null)" ]; }
log_lines() { if [ -f "$LOG" ]; then wc -l < "$LOG"; else echo 0; fi; }

stop_stray() {  # stops a copy started by hand (nohup) that holds the port, so the service can bind it
  local pid
  for pid in $(port_pids); do
    if in_service "$pid"; then continue; fi
    info "stopping pid $pid on port $PORT, started by hand: $(ps -o cmd= -p "$pid" || true)"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      warn "pid $pid did not stop after 30 s, killing it"
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  if port_busy && [ -z "$(port_pids)" ] && [ "$(prop ActiveState)" != active ]; then
    fail "port $PORT is used by a process of another user; see: sudo ss -ltnp 'sport = :$PORT'"
  fi
}

wait_up() {  # $1 = log line count before the start; waits until HEALTH_URL answers
  local from="$1" t0=$SECONDS last=$SECONDS restarts0
  restarts0="$(prop NRestarts)"
  info "waiting for $HEALTH_URL (up to $START_TIMEOUT s)"
  while ! curl -fs -m 2 -o /dev/null "$HEALTH_URL"; do
    if [ "$(prop ActiveState)" = failed ] || [ "$(prop NRestarts)" != "$restarts0" ]; then
      printf '\n'
      tail -n +"$((from + 1))" "$LOG" 2>/dev/null | tail -n 25 | sed 's/^/    | /'
      fail "the service stopped while starting (log above; more: bash deploy.sh logs)"
    fi
    if [ $((SECONDS - t0)) -ge "$START_TIMEOUT" ]; then
      fail "no answer from $HEALTH_URL after $START_TIMEOUT s; see: bash deploy.sh logs"
    fi
    if [ $((SECONDS - last)) -ge 10 ]; then
      info "still starting, $((SECONDS - t0)) s; log: $(tail -n 1 "$LOG" 2>/dev/null | cut -c1-100)"
      last=$SECONDS
    fi
    sleep 1
  done
  ok "answers after $((SECONDS - t0)) s"
}

src_version() {
  if git -C "$SRC" rev-parse HEAD >/dev/null 2>&1; then
    local dirty=''
    if [ -n "$(git -C "$SRC" status --porcelain 2>/dev/null)" ]; then dirty=' + local changes'; fi
    echo "commit $(git -C "$SRC" log -1 --format='%h (%cs) %s')$dirty"
  else
    echo "$SRC (not a git clone)"
  fi
}

save_settings() {
  local key
  mkdir -p "$(dirname "$CONF")"
  for key in $SETTINGS; do echo "$key=${!key}"; done > "$CONF"
}

render_unit() {
  cat <<UNIT
# Written by deploy.sh of https://github.com/CaptainAAI/yoloinferencewebserver
# Changes made here are overwritten by the next deploy; change the settings instead.
[Unit]
Description=YOLO inference dashboard (port $PORT)
Documentation=https://github.com/CaptainAAI/yoloinferencewebserver
After=network-online.target yolo-inference.service yolo-images.service
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$WEB_DIR
Environment=PORT=$PORT
Environment=YOLO_API=http://127.0.0.1:$INFER_PORT
Environment=NODE_ENV=production
ExecStart=$NODE $WEB_DIR/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=multi-user.target
UNIT
}

install_unit() {
  local tmp
  tmp="$(mktemp)"
  render_unit > "$tmp"
  if [ -f "$UNIT_FILE" ] && cmp -s "$tmp" "$UNIT_FILE"; then
    ok "$UNIT_FILE unchanged"
  else
    if [ -f "$UNIT_FILE" ]; then
      info "changes to $UNIT_FILE:"
      diff -u "$UNIT_FILE" "$tmp" | tail -n +3 | sed 's/^/      /' || true
    fi
    $SUDO install -m 644 "$tmp" "$UNIT_FILE"
    $SUDO systemctl daemon-reload
    ok "wrote $UNIT_FILE"
  fi
  rm -f "$tmp"
  if [ "$(prop UnitFileState)" != enabled ]; then
    $SUDO systemctl enable "$UNIT" 2>&1 | sed 's/^/    /'
  fi
  ok "enabled: starts at every boot, restarts 5 s after a crash"
}

# ---------------------------------------------------------------- this server's checks
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

check_requirements() {
  ensure_cmd curl curl "curl"
  if command -v node >/dev/null && [ "$(node_major)" -ge "$NODE_MIN" ]; then
    ok "node $(node -v): $(command -v node)"
  elif [ -n "$CHECK_ONLY" ]; then
    if command -v node >/dev/null; then
      missing "Node.js $NODE_MIN+ (found $(node -v))" "apt-get install nodejs npm"
    else
      missing "Node.js" "apt-get install nodejs npm"
    fi
  else
    if command -v node >/dev/null; then warn "node $(node -v) is too old, $NODE_MIN or newer is needed"; fi
    apt_install nodejs npm
    hash -r
    [ "$(node_major)" -ge "$NODE_MIN" ] \
      || fail "node $(node -v 2>/dev/null) is still older than $NODE_MIN; install a newer Node.js (https://nodejs.org) and run this again"
    ok "node $(node -v) installed: $(command -v node)"
  fi
  ensure_cmd npm npm "npm"
  if command -v npm >/dev/null; then ok "npm $(npm -v)"; fi
  if command -v free >/dev/null; then ok "free (memory panel)"; else warn "free not found: the memory panel stays empty (apt-get install procps)"; fi
  if python3 -c 'import tensorrt' 2>/dev/null; then
    ok "TensorRT version for the system panel: $(python3 -c 'import tensorrt; print(tensorrt.__version__)')"
  else
    warn "python3 cannot import tensorrt: the system panel shows TensorRT as -"
  fi
}

changed_files() {  # what install would change in WEB_DIR
  local f n=0
  for f in package.json package-lock.json server.js; do
    if [ -f "$SRC/$f" ] && ! cmp -s "$SRC/$f" "$WEB_DIR/$f" 2>/dev/null; then echo "      $f"; n=$((n + 1)); fi
  done
  if [ -d "$WEB_DIR/public" ]; then
    diff -rq "$SRC/public" "$WEB_DIR/public" 2>/dev/null | sed -E 's#^Files .*/public/([^ ]+) and .*#      public/\1#; s#^Only in ([^:]+): (.*)#      \1/\2 (only on one side)#' || true
  else
    echo "      public/ (new)"
  fi
}

install_files() {
  local changes
  changes="$(changed_files)"
  if [ -z "$changes" ]; then
    ok "all files unchanged"
  else
    info "changed files:"
    printf '%s\n' "$changes"
  fi
  mkdir -p "$WEB_DIR"
  cp -f "$SRC/package.json" "$SRC/server.js" "$WEB_DIR/"
  if [ -f "$SRC/package-lock.json" ]; then cp -f "$SRC/package-lock.json" "$WEB_DIR/"; fi
  rm -rf "$WEB_DIR/public"
  cp -r "$SRC/public" "$WEB_DIR/public"
  ok "copied package.json, package-lock.json, server.js, public/ ($(find "$WEB_DIR/public" -type f | wc -l) files)"

  info "npm install --omit=dev in $WEB_DIR"
  (cd "$WEB_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error) 2>&1 | sed 's/^/    | /'
  [ -f "$WEB_DIR/node_modules/express/package.json" ] || fail "npm install did not install express (is the Jetson online?)"
  ok "express $(node -p "require('$WEB_DIR/node_modules/express/package.json').version")"
}

app_status() {
  head2 "Dashboard"
  if ! curl -fs -m 3 -o /dev/null "$HEALTH_URL"; then
    warn "no answer on $HEALTH_URL"
    return
  fi
  info "open it at any of this Jetson's addresses:"
  local ip
  for ip in $(hostname -I); do info "  http://$ip:$PORT"; done
  if curl -fs -m 3 -o /dev/null "http://127.0.0.1:$PORT/api/models"; then
    ok "server.py reachable through /api (http://127.0.0.1:$INFER_PORT)"
  else
    warn "server.py not reachable on port $INFER_PORT (deploy yoloinferencemodel)"
  fi
  if curl -fs -m 3 -o /dev/null "http://127.0.0.1:$PORT/images-api/health"; then
    ok "image server reachable through /images-api"
  else
    warn "image server not reachable (deploy yoloinferenceimageserver if you save images)"
  fi
  local sys
  if sys="$(curl -fs -m 5 "http://127.0.0.1:$PORT/sys")"; then
    node -e '
const s = JSON.parse(process.argv[1]);
const g = (b) => (b / 2 ** 30).toFixed(1) + " GiB";
console.log("    host        " + s.hostname + ", TensorRT " + (s.tensorrt || "-"));
if (s.memory && s.memory.mem) console.log("    memory      " + g(s.memory.mem.used) + " used of " + g(s.memory.mem.total) + ", " + g(s.memory.mem.available) + " available");
' "$sys" || true
  fi
}

# ---------------------------------------------------------------- commands
do_status() {
  head2 "Service $UNIT"
  if [ -f "$UNIT_FILE" ]; then
    local since mem
    since="$(prop ActiveEnterTimestamp)"
    kv state "$(prop ActiveState) ($(prop SubState))${since:+, since $since}"
    kv "at boot" "$(prop UnitFileState)"
    kv "main pid" "$(prop MainPID)"
    mem="$(prop MemoryCurrent)"
    case "$mem" in '' | '[not set]' | 18446744073709551615) ;; *) kv memory "$(numfmt --to=iec --suffix=B "$mem")" ;; esac
    kv restarts "$(prop NRestarts) automatic restart(s) after a crash"
    kv "unit file" "$UNIT_FILE"
  else
    warn "not installed; install it with: bash deploy.sh"
  fi
  kv folder "$WEB_DIR"
  if [ -f "$LOG" ]; then kv log "$LOG ($(du -h "$LOG" | cut -f1))"; else kv log "$LOG (not created yet)"; fi
  if [ -f "$WEB_DIR/.deployed" ]; then kv deployed "$(cat "$WEB_DIR/.deployed")"; fi
  kv settings "WEB_DIR=$WEB_DIR WEB_PORT=$WEB_PORT INFER_PORT=$INFER_PORT"

  head2 "Port $PORT"
  local line pid
  line="$(ss -ltnpH "sport = :$PORT" 2>/dev/null | head -n 1)"
  if [ -z "$line" ]; then
    warn "nothing listens on port $PORT"
  else
    pid="$(grep -o 'pid=[0-9]*' <<< "$line" | head -n 1 | cut -d= -f2 || true)"
    if [ -z "$pid" ]; then
      info "$(awk '{print $4}' <<< "$line"), a process of another user (sudo ss -ltnp 'sport = :$PORT')"
    elif in_service "$pid"; then
      ok "$(awk '{print $4}' <<< "$line"), pid $pid (the service)"
    else
      warn "$(awk '{print $4}' <<< "$line"), pid $pid, started by hand, not by the service: $(ps -o cmd= -p "$pid" || true)"
      info "bash deploy.sh replaces it with the service"
    fi
  fi

  app_status

  head2 "Last 8 log lines"
  if [ -f "$LOG" ]; then tail -n 8 "$LOG" | sed 's/^/    | /'; else info "(no log yet)"; fi
}

do_check() {
  CHECK_ONLY=1
  STEPS=1
  step "Checking requirements (nothing is installed or changed)"
  check_requirements
  head2 "Files"
  info "source: $(src_version)"
  if [ -f "$WEB_DIR/server.js" ]; then
    local changes
    changes="$(changed_files)"
    if [ -z "$changes" ]; then ok "installed dashboard is up to date"; else info "install would update:"; printf '%s\n' "$changes"; fi
    if [ -f "$WEB_DIR/node_modules/express/package.json" ]; then ok "npm dependencies installed"; else info "npm dependencies not installed yet"; fi
  else
    info "dashboard not installed yet in $WEB_DIR"
  fi
  if [ -f "$UNIT_FILE" ]; then ok "service $UNIT installed ($(prop ActiveState))"; else info "service $UNIT not installed yet"; fi
  if [ "$MISSING" -ne 0 ]; then
    printf '\n'
    warn "something is missing; bash deploy.sh installs it"
    exit 1
  fi
  printf '\n'
  ok "all requirements are there"
}

do_install() {
  not_root
  [ -f "$SRC/server.js" ] && [ -d "$SRC/public" ] || fail "server.js or public/ not found in $SRC; run deploy.sh from its repository"
  printf '%sDeploying the YOLO inference dashboard%s from %s\n' "$G" "$N" "$(src_version)"
  info "to $WEB_DIR, port $PORT, server.py on port $INFER_PORT, service $UNIT, as user $RUN_USER"

  step "Requirements"
  need_sudo "install missing packages and the systemd service"
  check_requirements
  NODE="$(command -v node)"

  step "Files and npm dependencies"
  install_files
  echo "$(src_version), deployed $(date '+%Y-%m-%d %H:%M')" > "$WEB_DIR/.deployed"
  save_settings
  ok "settings remembered in $CONF"

  step "systemd service $UNIT"
  install_unit

  step "Starting"
  stop_stray
  local from
  from="$(log_lines)"
  $SUDO systemctl restart "$UNIT"
  ok "systemctl restart $UNIT"

  step "Waiting for the dashboard"
  wait_up "$from"

  step "Report"
  do_status
  printf '\n%sDone.%s The dashboard runs as the service %s on port %s.\n' "$G" "$N" "$UNIT" "$PORT"
  info "logs: bash deploy.sh logs -f    status: bash deploy.sh status    update: git pull && bash deploy.sh"
}

do_ctl() {  # start | stop | restart
  not_root
  [ -f "$UNIT_FILE" ] || fail "the service is not installed; install it with: bash deploy.sh"
  need_sudo "$1 the service"
  local from
  from="$(log_lines)"
  if [ "$1" != stop ]; then stop_stray; fi
  $SUDO systemctl "$1" "$UNIT"
  ok "systemctl $1 $UNIT"
  if [ "$1" != stop ]; then wait_up "$from"; fi
  info "state: $(prop ActiveState) ($(prop SubState))"
}

do_uninstall() {
  not_root
  if [ ! -f "$UNIT_FILE" ]; then ok "the service is not installed"; return; fi
  need_sudo "remove the service"
  $SUDO systemctl disable --now "$UNIT" 2>&1 | sed 's/^/    /'
  $SUDO rm -f "$UNIT_FILE"
  $SUDO systemctl daemon-reload
  ok "service $UNIT stopped and removed"
  info "kept: $WEB_DIR (dashboard files, node_modules, web.log)"
}

do_logs() {
  [ -f "$LOG" ] || fail "no log yet: $LOG"
  case "${1:-50}" in
    -f) tail -n 30 -f "$LOG" ;;
    *[!0-9]*) fail "usage: bash deploy.sh logs [N|-f]" ;;
    *) tail -n "${1:-50}" "$LOG" ;;
  esac
}

CMD="${1:-install}"
if [ $# -gt 0 ]; then shift; fi
case "$CMD" in
  install | --service | update) do_install ;;
  check) do_check ;;
  status | --status) do_status ;;
  logs) do_logs "$@" ;;
  start | stop | restart) do_ctl "$CMD" ;;
  unit) render_unit ;;
  uninstall) do_uninstall ;;
  help | -h | --help) usage ;;
  *) usage; fail "unknown command: $CMD" ;;
esac
