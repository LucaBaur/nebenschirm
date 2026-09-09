#!/usr/bin/env bash
# Nebenschirm deployen: Dienst -> Homeserver, Tafel-URL -> iMac.
# Prueft erst die Syntax, laedt nur bei gruen hoch.
set -euo pipefail
cd "$(dirname "$0")"

SERVER="you@homeserver"
IMAC="you@imac"

echo "== 1/4 Syntax =="
python -c "import ast; ast.parse(open('server.py', encoding='utf-8').read())" 2>/dev/null \
  || py -c "import ast; ast.parse(open('server.py', encoding='utf-8').read())"
echo "  ok server.py"
node --check static/board.js && echo "  ok board.js"

echo "== 2/4 Dienst hochladen =="
ssh "$SERVER" "mkdir -p ~/nebenschirm/static"
scp -q server.py "$SERVER:~/nebenschirm/server.py"
scp -q static/index.html static/board.js "$SERVER:~/nebenschirm/static/"
scp -q nebenschirm.service "$SERVER:~/.config/systemd/user/nebenschirm.service"

echo "== 3/4 Dienst neu starten =="
ssh "$SERVER" 'export XDG_RUNTIME_DIR=/run/user/$(id -u); \
  systemctl --user daemon-reload && systemctl --user restart nebenschirm.service && \
  sleep 2 && systemctl --user is-active nebenschirm.service'

echo "== 4/4 Erreichbarkeit =="
curl -s -m 10 -o /dev/null -w "  /api/ping  %{http_code}\n" http://homeserver:8300/api/ping
curl -s -m 20 -o /dev/null -w "  /api/board %{http_code}\n" http://homeserver:8300/api/board

echo "== Fertig. Tafel: http://homeserver:8300/ =="
