#!/usr/bin/env python3
"""Nebenschirm — sammelt die Daten fuer die Tafel am iMac ein.

Laeuft am Homeserver, weil dort Home Assistant und die Balu-Datenbank liegen.
Der iMac holt nur noch eine URL ab: kein HA-Token im Browser, kein CORS.

  GET /            -> die Tafel (static/index.html)
  GET /api/board   -> alle Werte als JSON
  GET /api/ping    -> {"ok": true, "bau": ...} — Stempel der ausgelieferten
                      Tafel; die Seite laedt sich neu, wenn er sich aendert
  POST /api/aktion -> abhaken, anlegen, Haushaltsroutine quittieren. Nur die
                      namentlich freigegebenen Listen (TODO_LISTEN,
                      HAUSHALT_ENTITIES) — siehe aktion().

Nur Standardbibliothek, damit kein venv noetig ist.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASIS = Path(__file__).resolve().parent
STATIC = BASIS / "static"
ELO_DB = Path(os.environ.get("ELO_DB", "/home/you/elo/elo.db"))
ELO_APP_JS = Path(os.environ.get("ELO_APP_JS", "/home/you/elo/static/app.js"))
PORT = int(os.environ.get("PORT", "8300"))

# Wie lange eine eingesammelte Fassung gilt. Die Tafel fragt alle 5 Minuten;
# der Cache faengt zusaetzliche Aufrufe (zweiter Schirm, Reload) ab.
CACHE_SEK = 60

WOCHENTAG = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]


# ── .env ────────────────────────────────────────────────────────────────────

def lies_env(pfad: Path) -> dict[str, str]:
    """Liest KEY=VALUE. Kommentare und kaputte Zeilen werden uebergangen."""
    werte: dict[str, str] = {}
    if not pfad.exists():
        return werte
    for zeile in pfad.read_text(encoding="utf-8", errors="replace").splitlines():
        zeile = zeile.strip()
        if not zeile or zeile.startswith("#") or "=" not in zeile:
            continue
        k, _, v = zeile.partition("=")
        werte[k.strip()] = v.strip().strip('"').strip("'")
    return werte


ENV = lies_env(BASIS / ".env")
HA_URL = ENV.get("HA_URL", "http://127.0.0.1:8123").rstrip("/")
HA_TOKEN = ENV.get("HA_TOKEN", "")

# Was die Tafel schreiben darf. Der Dienst lauscht ohne Anmeldung im Heimnetz
# und spricht mit einem HA-Admin-Token — deshalb wird beim Schreiben nichts
# durchgereicht. Erlaubt sind genau die Listen, die auch auf der Tafel stehen;
# alles andere bekommt 403.
TODO_LISTEN = {"todo.einkaufsliste", "todo.luca_handball", "todo.haushalt"}

# Ein Eintrag, den niemand mehr lesen kann, hilft keinem. Laengeres wird
# abgeschnitten statt abgelehnt.
TEXT_MAX = 200


# ── Home Assistant ──────────────────────────────────────────────────────────

def ha(pfad: str, daten: dict | None = None, timeout: float = 12.0):
    """Ruft die HA-REST-API. Gibt None zurueck, statt zu werfen."""
    url = HA_URL + pfad
    kopf = {"Authorization": "Bearer " + HA_TOKEN, "Content-Type": "application/json"}
    rumpf = json.dumps(daten).encode() if daten is not None else None
    req = urllib.request.Request(url, data=rumpf, headers=kopf,
                                 method="POST" if daten is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as a:
            return json.loads(a.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
        log("HA %s: %s" % (pfad, e))
        return None


def zustaende() -> dict[str, dict]:
    roh = ha("/api/states") or []
    return {e["entity_id"]: e for e in roh}


def todo_posten(entity: str) -> list[dict]:
    """Offene Punkte einer HA-Todo-Liste, in der Reihenfolge der Liste.

    Die `uid` kommt mit, weil die Tafel abhaken koennen soll. Der Text taugt
    dafuer nicht als Schluessel — zweimal "Milch" waere nicht auseinander-
    zuhalten.
    """
    antwort = ha("/api/services/todo/get_items?return_response", {"entity_id": entity})
    if not antwort:
        return []
    daten = (antwort.get("service_response") or {}).get(entity) or {}
    return [{"uid": p.get("uid"), "text": p.get("summary", "")}
            for p in daten.get("items", [])
            if p.get("status") == "needs_action"]


def kalender(entity: str, von: dt.date, bis: dt.date) -> list[dict]:
    p = "/api/calendars/%s?start=%sT00:00:00Z&end=%sT00:00:00Z" % (
        urllib.parse.quote(entity), von.isoformat(), bis.isoformat())
    return ha(p) or []


def zahl(states: dict, entity: str, default=None):
    e = states.get(entity)
    if not e:
        return default
    try:
        return float(e["state"])
    except (TypeError, ValueError):
        return default


def attr(states: dict, entity: str, name: str, default=None):
    e = states.get(entity)
    if not e:
        return default
    return e.get("attributes", {}).get(name, default)


# ── Balu-Datenbank ──────────────────────────────────────────────────────────

def elo_lesen() -> dict:
    """Eckdaten der Balu-App: Kaderzahl, Zahl der Trainings, Version."""
    aus: dict = {"spieler": None, "trainings": None, "version": None}
    if ELO_DB.exists():
        try:
            c = sqlite3.connect("file:%s?mode=ro" % ELO_DB, uri=True, timeout=5)
            aus["spieler"] = c.execute(
                "select count(*) from spieler where aktiv = 1").fetchone()[0]
            aus["trainings"] = c.execute("select count(*) from trainings").fetchone()[0]
            c.close()
        except sqlite3.Error as e:
            log("elo.db: %s" % e)
    try:
        m = re.search(r'APP_VERSION\s*=\s*["\']([^"\']+)["\']',
                      ELO_APP_JS.read_text(encoding="utf-8", errors="replace"))
        if m:
            aus["version"] = m.group(1)
    except OSError:
        pass
    return aus


def beteiligung(grenze: int = 12) -> list[dict]:
    """Anwesende je Training, aelteste zuerst — die Kurve auf der Tafel.

    Kommt aus `elo.db` und nicht aus Home Assistant: die Anwesenheit steht
    nirgends als Sensor, und der Recorder haelt ohnehin nur ein paar Tage.
    """
    if not ELO_DB.exists():
        return []
    try:
        c = sqlite3.connect("file:%s?mode=ro" % ELO_DB, uri=True, timeout=5)
        zeilen = c.execute(
            "select g.datum, g.art,"
            "       sum(case when t.status = 'anwesend' then 1 else 0 end),"
            "       count(t.spieler_id)"
            "  from trainings g join training_teilnahme t on t.training_id = g.id"
            " group by g.id having count(t.spieler_id) > 0"
            " order by g.datum desc limit ?", (grenze,)).fetchall()
        c.close()
    except sqlite3.Error as e:
        log("elo.db Beteiligung: %s" % e)
        return []
    return [{"datum": d, "art": art, "da": da or 0, "gesamt": gesamt or 0}
            for d, art, da, gesamt in reversed(zeilen)]


# ── SpielerPlus-Termine ─────────────────────────────────────────────────────

# Geschrieben von `termine_auto.py` im Projekt Anytype-Sync, ein paarmal am Tag.
# Die Tafel darf SpielerPlus nicht selbst befragen: keine offizielle API, der
# Client meldet sich wie ein Browser an — alle fuenf Minuten waere das zu viel.
TERMINE_JSON = Path(os.environ.get(
    "TERMINE_JSON", "/home/you/anytype-sync/daten/termine.json"))

# Wie lange ein Termin nach seinem Beginn noch als "der naechste" gilt, wenn
# kein Ende eingetragen ist.
LAEUFT_NOCH = dt.timedelta(hours=2, minutes=30)


def naechster_termin() -> tuple[dict | None, str | None]:
    """Der naechste Termin aus der abgelegten Liste, samt Datenstand.

    Ausgewaehlt wird hier und nicht beim Abholen: So springt die Tafel auch
    dann auf den uebernaechsten Termin, wenn die Datei ein paar Stunden alt
    ist. Welche Art der Termin hat, steht im Titel — SpielerPlus fuehrt
    Trainings, Testspiele und Punktspiele in derselben Liste.
    """
    try:
        daten = json.loads(TERMINE_JSON.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        log("termine.json: %s" % e)
        return None, None

    jetzt = dt.datetime.now().astimezone()
    for t in daten.get("termine", []):
        try:
            tag = dt.date.fromisoformat(t["datum"])
        except (KeyError, TypeError, ValueError):
            continue
        beginn = t.get("beginn") or t.get("treffen")
        if beginn:
            try:
                std, min_ = (int(x) for x in beginn.split(":")[:2])
                start = dt.datetime.combine(tag, dt.time(std, min_)).astimezone()
            except ValueError:
                start = dt.datetime.combine(tag, dt.time(23, 59)).astimezone()
        else:
            start = dt.datetime.combine(tag, dt.time(23, 59)).astimezone()

        schluss = start + LAEUFT_NOCH
        if t.get("ende"):
            try:
                std, min_ = (int(x) for x in t["ende"].split(":")[:2])
                schluss = dt.datetime.combine(tag, dt.time(std, min_)).astimezone()
            except ValueError:
                pass
        if schluss < jetzt:
            continue

        # "offen" steht nur fuer die naechsten Termine in der Datei — die
        # Terminliste allein kennt es nicht.
        return {
            "titel": t.get("titel") or "Termin",
            "art": t.get("art"),
            "datum": t["datum"],
            "beginn": t.get("beginn"),
            "treffen": t.get("treffen"),
            "ende": t.get("ende"),
            "laeuft": start <= jetzt <= schluss,
            "zugesagt": t.get("zugesagt"),
            "unsicher": t.get("unsicher"),
            "abgesagt": t.get("abgesagt"),
            "offen": t.get("offen"),
        }, daten.get("stand")

    return None, daten.get("stand")


# ── Homeserver ──────────────────────────────────────────────────────────────

# Ein systemd-User-Dienst erbt die Zusatzgruppen nicht, kommt also nicht an
# den Docker-Socket. Statt Rechte aufzubohren wird geprueft, ob der Dienst
# auf seinem Port antwortet — das sagt ohnehin mehr als "Container laeuft".
PORTS = [
    ("Home Assistant", 8123),
    ("Balu's Training", 8200),
    ("Handballforge", 8080),
    ("Portainer", 9000),
    ("Anytype headless", 31012),
]


def horcht(port: int, timeout: float = 1.5) -> bool:
    import socket
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def dienste() -> list[dict]:
    """Antwortet der Dienst auf seinem Port?"""
    aus: list = [None] * len(PORTS)

    def pruefen(i, name, port):
        aus[i] = {"name": name, "laeuft": horcht(port)}

    faeden = [threading.Thread(target=pruefen, args=(i, n, prt))
              for i, (n, prt) in enumerate(PORTS)]
    for f in faeden:
        f.start()
    for f in faeden:
        f.join(timeout=4)
    return [d for d in aus if d]


def last() -> float | None:
    try:
        return float(Path("/proc/loadavg").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def ram_frei_gb() -> float | None:
    try:
        werte = {}
        for zeile in Path("/proc/meminfo").read_text().splitlines():
            k, _, v = zeile.partition(":")
            werte[k] = float(v.strip().split()[0])
        return round(werte.get("MemAvailable", 0) / 1024 / 1024, 1)
    except (OSError, ValueError):
        return None


# ── Verlauf ─────────────────────────────────────────────────────────────────

# Ein Tag Historie sind je Sensor ueber tausend Punkte. Die werden hier auf
# handliche Stuetzstellen gemittelt — der iMac hat einen i3-550, dem muss man
# keine Rohdaten zum Zeichnen hinlegen.
VERLAUF = [
    ("temp", "sensor.system_monitor_prozessortemperatur"),
    ("ram", "sensor.system_monitor_arbeitsspeicherauslastung"),
]
VERLAUF_STUNDEN = 24
VERLAUF_PUNKTE = 60

# Eigener Cache: Kurven aendern sich langsam, und die Historie zu holen kostet
# spuerbar mehr als der Rest zusammen.
VERLAUF_CACHE_SEK = 600
_verlauf_cache: dict = {}
_verlauf_zeit = 0.0


def _verdichten(punkte: list[tuple[float, float]], n: int) -> list[float]:
    """Mittelt (Zeit, Wert) auf n gleich breite Faecher. Leere Faecher erben
    den Wert des vorigen — eine Luecke in der Linie waere gelogen."""
    if not punkte:
        return []
    anfang, ende = punkte[0][0], punkte[-1][0]
    spanne = ende - anfang
    if spanne <= 0:
        return [round(punkte[-1][1], 1)]
    faecher: list[list[float]] = [[] for _ in range(n)]
    for zeit, wert in punkte:
        i = min(n - 1, int((zeit - anfang) / spanne * n))
        faecher[i].append(wert)
    aus: list[float] = []
    letzter = punkte[0][1]
    for f in faecher:
        if f:
            letzter = sum(f) / len(f)
        aus.append(round(letzter, 1))
    return aus


def verlauf() -> dict:
    """Die letzten 24 Stunden je Sensor, auf VERLAUF_PUNKTE gemittelt."""
    global _verlauf_cache, _verlauf_zeit
    import time
    if _verlauf_cache and (time.time() - _verlauf_zeit) < VERLAUF_CACHE_SEK:
        return _verlauf_cache

    von = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=VERLAUF_STUNDEN)
    pfad = "/api/history/period/%s?filter_entity_id=%s&minimal_response&no_attributes" % (
        von.strftime("%Y-%m-%dT%H:%M:%SZ"),
        urllib.parse.quote(",".join(e for _, e in VERLAUF)))
    roh = ha(pfad, timeout=20.0)
    if not roh:
        return _verlauf_cache or {}

    nach_entity: dict[str, list[tuple[float, float]]] = {}
    for reihe in roh:
        if not reihe:
            continue
        entity = reihe[0].get("entity_id")
        punkte = []
        for e in reihe:
            zustand = e.get("state")
            zeit = e.get("last_changed") or e.get("last_updated")
            if not zeit or zustand in (None, "unknown", "unavailable"):
                continue
            try:
                punkte.append((dt.datetime.fromisoformat(
                    zeit.replace("Z", "+00:00")).timestamp(), float(zustand)))
            except ValueError:
                continue
        if entity and punkte:
            nach_entity[entity] = punkte

    aus = {name: _verdichten(nach_entity.get(entity, []), VERLAUF_PUNKTE)
           for name, entity in VERLAUF}
    _verlauf_cache = aus
    _verlauf_zeit = time.time()
    return aus


def vorhersage(stunden: int = 24) -> list[dict]:
    """Stuendliche Vorhersage fuer die Kurve in der Wetterkachel.

    Rueckblick gibt es fuer die Aussentemperatur nicht — es existiert kein
    Sensor dafuer, nur das Wetter-Objekt mit seinen Attributen. Nach vorn zu
    schauen ist auf einer Tafel ohnehin das Nuetzlichere.
    """
    antwort = ha("/api/services/weather/get_forecasts?return_response",
                 {"entity_id": "weather.forecast_home", "type": "hourly"})
    if not antwort:
        return []
    daten = (antwort.get("service_response") or {}).get("weather.forecast_home") or {}
    aus = []
    for e in (daten.get("forecast") or [])[:stunden]:
        try:
            wann = dt.datetime.fromisoformat(
                str(e.get("datetime")).replace("Z", "+00:00")).astimezone()
        except ValueError:
            continue
        aus.append({"stunde": wann.strftime("%H"),
                    "temperatur": e.get("temperature"),
                    "regen": e.get("precipitation"),
                    "zustand": e.get("condition")})
    return aus


# ── Aufbereitung ────────────────────────────────────────────────────────────

WETTER_TEXT = {
    "clear-night": "Klar", "cloudy": "Bewölkt", "fog": "Nebel", "hail": "Hagel",
    "lightning": "Gewitter", "lightning-rainy": "Gewitter", "partlycloudy": "Teils bewölkt",
    "pouring": "Starker Regen", "rainy": "Regen", "snowy": "Schnee",
    "snowy-rainy": "Schneeregen", "sunny": "Sonnig", "windy": "Windig",
    "windy-variant": "Windig", "exceptional": "Ungewöhnlich",
}

JOBS = [
    ("sync_auto", "Training-Sync"), ("elo_sync", "ELO-Sync"),
    ("erinnerung", "Erinnerung"), ("push_erinnerung", "Push"),
    ("ha_status", "HA-Status"), ("beteiligung_auto", "Beteiligung"),
    ("fahrtgeld", "Fahrtgeld"),
    ("termine_auto", "Termine"),
]

HAUSHALT = [
    ("staubsaugen", "Staubsaugen"), ("nass_wischen", "Nass wischen"),
    ("bad_putzen", "Bad putzen"), ("bett_beziehen", "Bett beziehen"),
    ("fenster_putzen", "Fenster putzen"), ("staub_wischen", "Staub wischen"),
    ("feuer_machen_montag", "Feuer Mo"), ("feuer_machen_dienstag", "Feuer Di"),
    ("feuer_machen_donnerstag", "Feuer Do"),
]

# Nur diese Routinen darf die Tafel quittieren — dieselbe Ueberlegung wie bei
# TODO_LISTEN.
HAUSHALT_ENTITIES = {"binary_sensor.home_maintenance_%s" % s for s, _ in HAUSHALT}

KALENDER = [
    ("calendar.lb3075_googlemail_com", "termin"),
    ("calendar.geburtstage", "geburtstag"),
    ("calendar.feiertage_in_deutschland", "feiertag"),
    ("calendar.haushalt", "haushalt"),
    ("calendar.abfallkalender", "abfuhr"),
]

KALENDER_TAGE = 7


def tag_liste(states: dict) -> tuple[list[dict], list[dict]]:
    """Agenda der naechsten Tage und die naechsten Abfuhrtermine."""
    heute = dt.date.today()
    ende = heute + dt.timedelta(days=KALENDER_TAGE + 1)
    nach_tag: dict[str, list[dict]] = {}
    abfuhr: list[dict] = []

    for entity, art in KALENDER:
        e = states.get(entity)
        if not e or e.get("state") in ("unavailable", "unknown", None):
            continue
        for ev in kalender(entity, heute, ende):
            start = (ev.get("start") or {})
            roh = start.get("dateTime") or start.get("date") or ""
            if not roh:
                continue
            try:
                wann = dt.datetime.fromisoformat(roh.replace("Z", "+00:00"))
            except ValueError:
                continue
            ganztags = "dateTime" not in start
            tag = wann.date()
            if not (heute <= tag < ende):
                continue
            titel = (ev.get("summary") or "").strip()
            zeit = None if ganztags else wann.strftime("%H:%M")
            if art == "abfuhr":
                # Der Abfallkalender nennt die Tonne im Titel, Abholung 06:30.
                kurz = titel.replace("Abfuhr:", "").strip() or titel
                zeit = "06:30"
                abfuhr.append({"was": kurz, "datum": tag.isoformat()})
                titel = kurz + " raus stellen" if tag == heute + dt.timedelta(days=1) else kurz
            nach_tag.setdefault(tag.isoformat(), []).append(
                {"art": art, "zeit": zeit, "text": titel})

    tage = []
    for i in range(KALENDER_TAGE):
        tag = heute + dt.timedelta(days=i)
        posten = sorted(nach_tag.get(tag.isoformat(), []), key=lambda p: p["zeit"] or "00:00")
        tage.append({"datum": tag.isoformat(), "tag": tag.day,
                     "wt": WOCHENTAG[tag.weekday()], "heute": i == 0, "posten": posten})

    abfuhr.sort(key=lambda a: a["datum"])
    return tage, abfuhr[:6]


def haushalt_posten(st: dict, schluessel: str, name: str) -> dict:
    """Eine Routine der Home-Maintenance-Integration.

    `next_due` und `last_performed` kommen mit, damit die Tafel "seit drei
    Tagen faellig" sagen kann statt nur "faellig" — und weil die Karte den
    Punkt quittieren koennen soll.
    """
    entity = "binary_sensor.home_maintenance_%s" % schluessel
    e = st.get(entity) or {}
    a = e.get("attributes", {})
    tage = None
    faellig_seit = a.get("next_due")
    if faellig_seit:
        try:
            tage = (dt.date.today() - dt.datetime.fromisoformat(
                faellig_seit).astimezone().date()).days
        except ValueError:
            tage = None
    return {
        "name": name,
        "entity": entity,
        "faellig": e.get("state") == "on",
        "tage": tage,
        "intervall": a.get("interval_value"),
        "zuletzt": a.get("last_performed"),
    }


def sammeln() -> dict:
    jetzt = dt.datetime.now().astimezone()
    st = zustaende()
    erreichbar = bool(st)

    wetter_state = (st.get("weather.forecast_home") or {}).get("state")
    tage, abfuhr = tag_liste(st) if erreichbar else ([], [])

    jobs = []
    for schluessel, name in JOBS:
        status = (st.get("sensor.handball_%s_status" % schluessel) or {}).get("state")
        lauf = (st.get("sensor.handball_%s_last_run" % schluessel) or {}).get("state")
        wann = None
        if lauf and lauf not in ("unknown", "unavailable"):
            try:
                wann = dt.datetime.fromisoformat(lauf).astimezone().isoformat()
            except ValueError:
                wann = None
        jobs.append({"name": name, "status": status or "unbekannt", "last_run": wann})

    kal_kaputt = [e for e, _ in KALENDER
                  if (st.get(e) or {}).get("state") in ("unavailable", "unknown")]

    elo = elo_lesen()
    termin, termin_stand = naechster_termin()
    betrieb = attr(st, "sensor.system_monitor_betriebszeit", "friendly_name")  # nur Praesenz
    seit = (st.get("sensor.system_monitor_betriebszeit") or {}).get("state")
    tage_online = None
    if seit and seit not in ("unknown", "unavailable"):
        try:
            tage_online = (jetzt - dt.datetime.fromisoformat(seit).astimezone()).days
        except ValueError:
            pass

    return {
        "stand": jetzt.isoformat(),
        "ha_erreichbar": erreichbar,
        "wetter": {
            "temperatur": attr(st, "weather.forecast_home", "temperature"),
            "text": WETTER_TEXT.get(wetter_state, wetter_state or "—"),
            "zustand": wetter_state,
            "feuchte": attr(st, "weather.forecast_home", "humidity"),
            "wind": attr(st, "weather.forecast_home", "wind_speed"),
            "druck": attr(st, "weather.forecast_home", "pressure"),
            "stunden": vorhersage() if erreichbar else [],
        },
        "jobs": jobs,
        "termin": termin,
        "termin_stand": termin_stand,
        "balu": {"version": elo["version"], "spieler": elo["spieler"],
                 "trainings": elo["trainings"]},
        "kalender": {"tage": tage, "kaputt": kal_kaputt},
        "abfuhr": abfuhr,
        "einkauf": todo_posten("todo.einkaufsliste") if erreichbar else [],
        "aufgaben": {
            "handball": todo_posten("todo.luca_handball") if erreichbar else [],
            "haushalt": todo_posten("todo.haushalt") if erreichbar else [],
        },
        "haushalt": [haushalt_posten(st, s, name) for s, name in HAUSHALT],
        "beteiligung": beteiligung(),
        "verlauf": verlauf() if erreichbar else {},
        "server": {
            "ram": zahl(st, "sensor.system_monitor_arbeitsspeicherauslastung"),
            "disk": zahl(st, "sensor.system_monitor_massenspeicher_auslastung"),
            "temperatur": zahl(st, "sensor.system_monitor_prozessortemperatur"),
            "load": last(),
            "ram_frei": ram_frei_gb(),
            "seit": seit if seit not in ("unknown", "unavailable") else None,
            "tage_online": tage_online,
            "dienste": dienste(),
        },
    }


# ── Cache ───────────────────────────────────────────────────────────────────

_sperre = threading.Lock()
_cache: dict | None = None
_cache_zeit = 0.0


def board(frisch: bool = False) -> dict:
    global _cache, _cache_zeit
    import time
    with _sperre:
        if not frisch and _cache and (time.time() - _cache_zeit) < CACHE_SEK:
            return _cache
        try:
            _cache = sammeln()
            _cache_zeit = time.time()
        except Exception as e:  # der Dienst darf an keiner Quelle sterben
            log("sammeln: %r" % e)
            if _cache:
                _cache = dict(_cache, fehler=str(e))
            else:
                _cache = {"stand": dt.datetime.now().astimezone().isoformat(),
                          "fehler": str(e), "ha_erreichbar": False}
            _cache_zeit = time.time()
        return _cache


def cache_verwerfen() -> None:
    """Nach einer Aenderung gilt der eingesammelte Stand nicht mehr."""
    global _cache_zeit
    with _sperre:
        _cache_zeit = 0.0


# ── Schreiben ───────────────────────────────────────────────────────────────

class Abgelehnt(Exception):
    """Die Anfrage taugt nicht — der Aufrufer bekommt den Grund zu lesen."""

    def __init__(self, text: str, code: int = 400):
        super().__init__(text)
        self.code = code


def aktion(auftrag: dict) -> dict:
    """Fuehrt genau eine der drei erlaubten Aenderungen in Home Assistant aus.

    Bewusst keine allgemeine Service-Bruecke: der Dienst ist im Heimnetz ohne
    Anmeldung erreichbar und haelt ein Admin-Token. Was hier nicht namentlich
    steht, geht nicht.
    """
    was = auftrag.get("aktion")

    if was in ("todo_status", "todo_neu"):
        liste = auftrag.get("liste")
        if liste not in TODO_LISTEN:
            raise Abgelehnt("Liste nicht freigegeben", 403)

        if was == "todo_status":
            uid = (auftrag.get("uid") or "").strip()
            if not uid:
                raise Abgelehnt("uid fehlt")
            erledigt = bool(auftrag.get("erledigt"))
            antwort = ha("/api/services/todo/update_item", {
                "entity_id": liste, "item": uid,
                "status": "completed" if erledigt else "needs_action"})
        else:
            text = (auftrag.get("text") or "").strip()[:TEXT_MAX]
            if not text:
                raise Abgelehnt("Text fehlt")
            antwort = ha("/api/services/todo/add_item",
                         {"entity_id": liste, "item": text})

    elif was == "haushalt_fertig":
        entity = auftrag.get("entity")
        if entity not in HAUSHALT_ENTITIES:
            raise Abgelehnt("Routine nicht freigegeben", 403)
        antwort = ha("/api/services/home_maintenance/reset_last_performed",
                     {"entity_id": entity})

    else:
        raise Abgelehnt("unbekannte Aktion")

    # `ha()` wirft nie und gibt bei jedem Fehler None zurueck. Ein Service-Aufruf
    # ohne Rueckgabe liefert im Erfolgsfall eine leere Liste — None heisst also
    # wirklich "hat nicht geklappt".
    if antwort is None:
        raise Abgelehnt("Home Assistant hat nicht geantwortet", 502)

    cache_verwerfen()

    # Nur nachlesen, was sich geaendert haben kann. Den ganzen Stand neu
    # einzusammeln dauert Sekunden (fuenf Kalender, fuenf Portabfragen) — nach
    # einem Klick auf eine Einkaufsliste waere das nicht zu rechtfertigen.
    if was in ("todo_status", "todo_neu"):
        return {"liste": auftrag["liste"], "posten": todo_posten(auftrag["liste"])}
    st = zustaende()
    return {"haushalt": [haushalt_posten(st, k, n) for k, n in HAUSHALT]}


# ── Fassung der Tafel ───────────────────────────────────────────────────────

# Der Stempel aendert sich, sobald index.html oder board.js neu hochgeladen
# wurden. Die Tafel fragt ihn im Minutentakt ab und laedt sich selbst neu,
# wenn er ein anderer ist — sonst haengt am iMac nach einem Deploy die alte
# Seite im Speicher, bis jemand Firefox abschiesst.
def bau_stempel() -> str:
    teile = []
    for name in ("index.html", "board.js"):
        try:
            st = (STATIC / name).stat()
            teile.append("%s:%d:%d" % (name, st.st_mtime_ns, st.st_size))
        except OSError:
            teile.append(name + ":?")
    return hashlib.sha1("|".join(teile).encode()).hexdigest()[:12]


def log(text: str) -> None:
    print("%s  %s" % (dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"), text), flush=True)


# ── HTTP ────────────────────────────────────────────────────────────────────

TYPEN = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "Nebenschirm"

    def log_message(self, fmt, *args):  # Zugriffe nicht mitschreiben
        pass

    def _sende(self, code: int, rumpf: bytes, typ: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", typ)
        self.send_header("Content-Length", str(len(rumpf)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(rumpf)

    def do_GET(self):
        pfad = urllib.parse.urlparse(self.path).path
        if pfad == "/api/ping":
            # Bewusst ohne HA-Abfrage: die Tafel ruft das jede Minute auf.
            rumpf = json.dumps({"ok": True, "bau": bau_stempel()}).encode()
            return self._sende(200, rumpf, "application/json")
        if pfad == "/api/board":
            frisch = "frisch" in urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            rumpf = json.dumps(board(frisch), ensure_ascii=False).encode("utf-8")
            return self._sende(200, rumpf, "application/json; charset=utf-8")
        name = "index.html" if pfad in ("/", "/index.html") else pfad.lstrip("/")
        typ = TYPEN.get(Path(name).suffix)
        if typ and "/" not in name and ".." not in name:
            datei = STATIC / name
            if datei.exists():
                return self._sende(200, datei.read_bytes(), typ)
        return self._sende(404, b"nicht gefunden", "text/plain; charset=utf-8")

    def do_POST(self):
        pfad = urllib.parse.urlparse(self.path).path
        if pfad != "/api/aktion":
            return self._sende(404, b"nicht gefunden", "text/plain; charset=utf-8")
        try:
            laenge = int(self.headers.get("Content-Length") or 0)
            if laenge <= 0 or laenge > 8192:
                raise Abgelehnt("Rumpf fehlt oder ist zu gross")
            try:
                auftrag = json.loads(self.rfile.read(laenge).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise Abgelehnt("kein gueltiges JSON")
            if not isinstance(auftrag, dict):
                raise Abgelehnt("kein Auftrag")
            geaendert = aktion(auftrag)
        except Abgelehnt as e:
            log("Aktion abgelehnt (%d): %s" % (e.code, e))
            rumpf = json.dumps({"ok": False, "fehler": str(e)},
                               ensure_ascii=False).encode("utf-8")
            return self._sende(e.code, rumpf, "application/json; charset=utf-8")
        except Exception as e:  # der Dienst darf an einer Aktion nicht sterben
            log("Aktion: %r" % e)
            rumpf = json.dumps({"ok": False, "fehler": "unerwarteter Fehler"}).encode()
            return self._sende(500, rumpf, "application/json; charset=utf-8")

        # Was sich geaendert hat, kommt gleich mit — die Tafel muss nach einem
        # Klick nicht noch einmal nachfragen.
        rumpf = json.dumps(dict(geaendert, ok=True),
                           ensure_ascii=False).encode("utf-8")
        return self._sende(200, rumpf, "application/json; charset=utf-8")

    do_HEAD = do_GET


def main() -> int:
    if not HA_TOKEN:
        log("WARNUNG: kein HA_TOKEN in .env — die Tafel bleibt leer")
    log("Nebenschirm auf Port %d, HA %s" % (PORT, HA_URL))
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
