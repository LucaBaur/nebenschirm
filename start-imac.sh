#!/usr/bin/env bash
# Startet die Tafel am iMac in einem normalen Firefox-Fenster und schaltet es
# auf Vollbild. Anders als `--kiosk` bleiben Tastenkuerzel und Tabs nutzbar:
# F11 fuehrt aus dem Vollbild heraus, Strg+T oeffnet einen Tab.
#
# xdotool ist am iMac nicht installiert (und ohne sudo nicht nachzuruesten),
# deshalb setzt wmctrl den Vollbildzustand ueber den Fenstermanager.
set -u

URL="http://homeserver:8300/"
TITEL="Nebenschirm"

fenster_suchen() {
  wmctrl -l | grep -F "$TITEL" | head -1 | cut -d' ' -f1
}

vollbild() {
  # Kurz warten, bis Firefox das Fenster fertig aufgebaut hat.
  sleep 1
  wmctrl -i -a "$1"
  wmctrl -i -r "$1" -b add,fullscreen
}

# Laeuft die Tafel schon, wird sie nur nach vorn geholt. Ein zweiter Aufruf
# soll kein zweites Fenster und keinen weiteren Tab aufmachen — genau so
# haben sich frueher mehrere Nebenschirm-Tabs angesammelt.
vorhanden=$(fenster_suchen)
if [ -n "$vorhanden" ]; then
  echo "Tafel laeuft bereits — Fenster nach vorn geholt."
  vollbild "$vorhanden"
  exit 0
fi

firefox --new-window "$URL" &

# Auf das Fenster warten — der erste Start dauert am i3-550 ein paar Sekunden.
fenster=""
for _ in $(seq 1 60); do
  fenster=$(fenster_suchen)
  [ -n "$fenster" ] && break
  sleep 0.5
done

if [ -n "$fenster" ]; then
  vollbild "$fenster"
else
  echo "Fenster '$TITEL' nicht gefunden — Vollbild nicht gesetzt." >&2
fi
