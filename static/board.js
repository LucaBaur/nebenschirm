/* ============================================================
   Nebenschirm — holt /api/board und baut die Tafel daraus.
   Alle 5 Minuten neu; schlaegt das fehl, bleibt der letzte
   Stand stehen und der Punkt oben wird rot.

   Seit August schreibt die Tafel auch zurueck: Haken, neue
   Posten und quittierte Haushaltsroutinen gehen ueber
   POST /api/aktion nach Home Assistant. Der Klick wirkt sofort
   im Bild; kommt vom Dienst ein Fehler, springt die Zeile
   zurueck. Auf einer Tafel, die man im Vorbeigehen bedient,
   waere ein still verschluckter Haken das Schlimmste.
   ============================================================ */
(function () {
  "use strict";

  var INTERVALL = 5 * 60 * 1000;
  var FASSUNG_INTERVALL = 60 * 1000;
  var WT = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
  var WT_K = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  var MON = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
             "August", "September", "Oktober", "November", "Dezember"];
  var SVGNS = "http://www.w3.org/2000/svg";

  /* Der zuletzt geholte Stand. Nach einer Aenderung wird nur der betroffene
     Teil darin ersetzt und neu gezeichnet — die uebrigen Karten sollen beim
     Abhaken nicht flackern. */
  var daten = null;

  function $(id) { return document.getElementById(id); }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function leer(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }

  function el(tag, klasse, text) {
    var n = document.createElement(tag);
    if (klasse) n.className = klasse;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function svg(tag, attr) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attr) {
      if (Object.prototype.hasOwnProperty.call(attr, k)) n.setAttribute(k, attr[k]);
    }
    return n;
  }

  /* Zahlen deutsch: 23.5 -> "23,5" */
  function num(x, stellen) {
    if (x === null || x === undefined || isNaN(x)) return "—";
    return Number(x).toFixed(stellen === undefined ? 1 : stellen).replace(".", ",");
  }

  function kw(d) {
    var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    var start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil((((t - start) / 86400000) + 1) / 7);
  }

  /* Tage zwischen heute und einem Datum, ohne Uhrzeit-Anteil */
  function tageBis(d) {
    var jetzt = new Date();
    return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) -
                       new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate())) / 86400000);
  }

  /* ── Uhr und Datum ── */
  function uhr() {
    var d = new Date();
    $("hhmm").textContent = pad(d.getHours()) + ":" + pad(d.getMinutes());
    $("ss").textContent = pad(d.getSeconds());
    /* Der Sekundenbalken ist eine einzige scaleX-Zuweisung pro Sekunde. Ein
       Ring mit stroke-dashoffset saehe aehnlich aus und kostet den iMac
       jedesmal ein Neuzeichnen des SVG. */
    $("secbar").style.transform = "scaleX(" + (d.getSeconds() / 59) + ")";
    $("cdate").textContent = WT[d.getDay()] + ", " + d.getDate() + ". " +
                             MON[d.getMonth()] + " " + d.getFullYear();
    $("ckw").textContent = "Kalenderwoche " + kw(d);
  }

  /* ── Wetter ── */
  function wetter(w) {
    if (!w) return;
    $("wx-temp").textContent = num(w.temperatur) + "°";
    $("wx-desc").textContent = (w.text || "—") + " · Laichingen";
    $("wx-hum").textContent = w.feuchte == null ? "—" : Math.round(w.feuchte) + " %";
    $("wx-wind").textContent = w.wind == null ? "—" : num(w.wind) + " km/h";
    $("wx-press").textContent = w.druck == null ? "—" : Math.round(w.druck) + " hPa";
    wetterKurve(w.stunden || []);
  }

  /* Die naechsten 24 Stunden als Linie. Nach vorn statt zurueck: fuer die
     Aussentemperatur gibt es in Home Assistant keinen Sensor mit Historie,
     und auf einer Tafel ist der kommende Abend ohnehin das Nuetzlichere. */
  function wetterKurve(stunden) {
    var box = $("wx-kurve");
    leer(box);
    var beschriftung = $("wx-stunden");
    leer(beschriftung);
    var werte = [];
    var i;
    for (i = 0; i < stunden.length; i++) {
      if (typeof stunden[i].temperatur === "number") werte.push(stunden[i]);
    }
    if (werte.length < 2) return;

    var B = 240, H = 46, rand = 7;
    var min = Infinity, max = -Infinity;
    for (i = 0; i < werte.length; i++) {
      min = Math.min(min, werte[i].temperatur);
      max = Math.max(max, werte[i].temperatur);
    }
    if (max - min < 1) { max = min + 1; }

    var punkte = [];
    for (i = 0; i < werte.length; i++) {
      var x = (i / (werte.length - 1)) * B;
      var y = H - rand - ((werte[i].temperatur - min) / (max - min)) * (H - rand * 2);
      punkte.push(x.toFixed(1) + "," + y.toFixed(1));
    }

    box.appendChild(svg("polygon", {
      points: "0," + H + " " + punkte.join(" ") + " " + B + "," + H,
      fill: "var(--signal)", opacity: ".13"
    }));
    box.appendChild(svg("polyline", {
      points: punkte.join(" "), fill: "none",
      stroke: "var(--signal)", "stroke-width": "1.8",
      "stroke-linejoin": "round", "stroke-linecap": "round",
      "vector-effect": "non-scaling-stroke"
    }));

    /* Vier Stuetzstellen reichen als Beschriftung — die Linie soll den Verlauf
       zeigen, nicht einzelne Stundenwerte ablesbar machen. */
    var schritte = [0, Math.floor(werte.length / 3), Math.floor(werte.length * 2 / 3),
                    werte.length - 1];
    for (i = 0; i < schritte.length; i++) {
      var w = werte[schritte[i]];
      beschriftung.appendChild(el("span", null, w.stunde + " Uhr " + Math.round(w.temperatur) + "°"));
    }
  }

  /* "heute 08:00", "Mo 17:00", "01.08." — je nachdem, wie lange es her ist */
  function wann(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    var tage = -tageBis(d);
    var zeit = pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (tage === 0) return "heute " + zeit;
    if (tage === 1) return "gestern " + zeit;
    if (tage < 7) return WT_K[d.getDay()] + " " + zeit;
    return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + ".";
  }

  function jobs(liste, ziel) {
    var box = $(ziel);
    leer(box);
    (liste || []).forEach(function (j) {
      var r = el("div", "job");
      r.appendChild(el("span", j.status === "ok" ? "dot" : "dot warn"));
      r.appendChild(document.createTextNode(j.name));
      r.appendChild(el("span", "t", wann(j.last_run)));
      box.appendChild(r);
    });
  }

  /* Die fuenf Homeserver-Dienste als Punkte in der Kopfzeile — dieselbe
     Gestaltung wie die Cronjobs, nur ohne Zeitangabe: ein Dienst laeuft oder
     laeuft nicht, ein "seit wann" gibt die Portabfrage nicht her. */
  function dienste(liste) {
    var box = $("dienste");
    leer(box);
    (liste || []).forEach(function (x) {
      var r = el("div", "job");
      r.appendChild(el("span", x.laeuft ? "dot" : "dot warn"));
      r.appendChild(document.createTextNode(x.name));
      box.appendChild(r);
    });
  }

  /* ── Nächster Termin ── */
  function termin(tr, stand) {
    var box = $("tr-body");
    leer(box);
    if (!tr) {
      $("tr-note").textContent = "kein Termin";
      box.appendChild(el("p", "hinweis",
        "In SpielerPlus steht kein kommender Termin."));
      return;
    }
    var d = new Date(tr.datum + "T00:00:00");
    var tage = tageBis(d);
    $("tr-note").textContent = tr.laeuft ? "läuft" : tr.beginn || "";

    var hero = el("div", "tr-hero");
    hero.appendChild(el("div", "tr-gross",
      tr.laeuft ? "jetzt" : tage === 0 ? "heute" : tage === 1 ? "morgen" : "in " + tage + " Tagen"));
    hero.appendChild(el("div", "tr-wann",
      WT_K[d.getDay()] + " " + pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." +
      (tr.beginn ? " · " + tr.beginn + " Uhr" : "")));

    /* Der Titel sagt, was es ist: "Training", "Trainingsspiel gegen Lehr",
       ein Punktspiel oder ein Teamevent. SpielerPlus fuehrt alles in
       derselben Liste, eine eigene Typangabe gibt es nicht. */
    hero.appendChild(el("div", "tr-titel", tr.titel));

    var meta = el("div", "tr-meta");
    if (tr.treffen && tr.treffen !== tr.beginn) {
      meta.appendChild(el("span", null, "Treffen " + tr.treffen));
    }
    if (tr.ende) meta.appendChild(el("span", null, "bis " + tr.ende));
    /* Die Termine kommen nicht im Fuenf-Minuten-Takt, sondern ein paarmal am
       Tag — deshalb steht dabei, wie alt der Stand ist. */
    if (stand) {
      var s = new Date(stand);
      if (!isNaN(s.getTime())) {
        meta.appendChild(el("span", "rechts", "SpielerPlus " +
          pad(s.getHours()) + ":" + pad(s.getMinutes())));
      }
    }
    if (meta.firstChild) hero.appendChild(meta);
    box.appendChild(hero);

    box.appendChild(zusagen(tr));
  }

  /* Zusagen als Ring: die Zahl, auf die es ankommt, steht gross in der Mitte,
     die Aufteilung liegt als Segmente aussen herum. */
  function zusagen(tr) {
    var reihen = [["Zugesagt", tr.zugesagt, "yes", "var(--gruen)"],
                  ["Unsicher", tr.unsicher, "maybe", "var(--signal)"],
                  ["Abgesagt", tr.abgesagt, "no", "var(--rot)"]];
    if (tr.offen) reihen.push(["Offen", tr.offen, "open", "var(--faint)"]);

    var summe = 0;
    reihen.forEach(function (z) { summe += (z[1] || 0); });

    var box = el("div", "zus");
    var r = 48, umfang = 2 * Math.PI * r;
    var bild = svg("svg", {"class": "ring", viewBox: "0 0 120 120"});
    bild.appendChild(svg("circle", {"class": "bahn", cx: 60, cy: 60, r: r}));

    var offset = 0;
    reihen.forEach(function (z) {
      var wert = z[1] || 0;
      if (!wert || !summe) return;
      var anteil = wert / summe;
      /* Ein Haarspalt zwischen den Segmenten, damit zwei gleichfarbig
         angrenzende Werte nicht zu einem Block verschmelzen. */
      var laenge = Math.max(0, anteil * umfang - 2);
      var stueck = svg("circle", {
        "class": "stueck", cx: 60, cy: 60, r: r,
        stroke: z[3],
        "stroke-dasharray": laenge.toFixed(2) + " " + (umfang - laenge).toFixed(2),
        "stroke-dashoffset": (-offset).toFixed(2),
        transform: "rotate(-90 60 60)"
      });
      bild.appendChild(stueck);
      offset += anteil * umfang;
    });

    var mitte = svg("text", {"class": "ring-mitte", x: 60, y: 62});
    mitte.textContent = tr.zugesagt == null ? "—" : tr.zugesagt;
    bild.appendChild(mitte);
    var unten = svg("text", {"class": "ring-lab", x: 60, y: 78});
    unten.textContent = "ZUGESAGT";
    bild.appendChild(unten);
    box.appendChild(bild);

    var leg = el("div", "zleg");
    reihen.forEach(function (z) {
      var zeile = el("div", "zrow");
      zeile.appendChild(el("span", "zpunkt " + z[2]));
      zeile.appendChild(el("span", "zlab", z[0]));
      zeile.appendChild(el("span", "znum", z[1] == null ? "—" : z[1]));
      leg.appendChild(zeile);
    });
    box.appendChild(leg);
    return box;
  }

  /* ── Beteiligung ── */
  function beteiligung(liste) {
    var box = $("bet-reihe");
    leer(box);
    liste = liste || [];
    if (!liste.length) {
      $("bet-schnitt").textContent = "—";
      box.appendChild(el("span", "agempty", "keine Trainings erfasst"));
      return;
    }
    var max = 0, summe = 0, i;
    for (i = 0; i < liste.length; i++) {
      max = Math.max(max, liste[i].da);
      summe += liste[i].da;
    }
    if (!max) max = 1;
    $("bet-schnitt").textContent = "Ø " + num(summe / liste.length, 1);

    liste.forEach(function (t, nr) {
      var d = new Date(t.datum + "T00:00:00");
      var saeule = el("div", "bet-saeule" + (t.art && t.art !== "training" ? " spiel" : ""));
      saeule.title = pad(d.getDate()) + "." + pad(d.getMonth() + 1) + ". · " +
                     t.da + " von " + t.gesamt;
      var balken = el("i");
      balken.style.height = Math.max(6, (t.da / max) * 100) + "%";
      balken.style.animationDelay = (nr * 28) + "ms";
      saeule.appendChild(balken);
      saeule.appendChild(el("b", null, t.da));
      box.appendChild(saeule);
    });
  }

  /* ── Kalender ── */
  /* Wochenansicht: jeder Tag eine Spalte, heute ganz links. Leere Tage
     bleiben stehen — nebeneinander liest sich eine leere Spalte richtig,
     untereinander waere sie nur eine verschenkte Zeile gewesen. */
  function kalender(k) {
    var box = $("kal-body");
    leer(box);
    var tage = (k && k.tage) || [];
    $("kal-note").textContent = tage.length + " Tage";

    var woche = el("div", "kalwoche");
    tage.forEach(function (tag) {
      var spalte = el("div", "kaltag" + (tag.heute ? " heute" : ""));
      var kopf = el("div", "kalkopf");
      kopf.appendChild(el("b", null, tag.tag + "."));
      kopf.appendChild(document.createTextNode(tag.wt));
      spalte.appendChild(kopf);

      var items = el("div", "kalitems");
      if (!tag.posten.length) {
        items.appendChild(el("span", "agempty", "—"));
      } else {
        tag.posten.forEach(function (p) {
          var z = el("span", "agitem");
          var art = p.art === "abfuhr" ? "waste" : p.art === "geburtstag" ? "job" : "train";
          z.appendChild(el("span", "agtag " + art));
          if (p.zeit) z.appendChild(el("span", "agt", p.zeit));
          z.appendChild(document.createTextNode(p.text));
          items.appendChild(z);
        });
      }
      spalte.appendChild(items);
      woche.appendChild(spalte);
    });
    box.appendChild(woche);

    var kaputt = (k && k.kaputt) || [];
    if (kaputt.length) {
      box.appendChild(el("div", "kal-fehlt", kaputt.length +
        " Kalender ohne Verbindung — in Home Assistant neu anmelden."));
    }
  }

  function abfuhr(liste) {
    var box = $("abfuhr");
    leer(box);
    (liste || []).forEach(function (a) {
      var d = new Date(a.datum + "T00:00:00");
      var tage = tageBis(d);
      var text = tage === 0 ? "heute" : tage === 1 ? "morgen" : WT_K[d.getDay()];
      var li = el("li");
      li.appendChild(el("span", "agtag waste"));
      li.appendChild(el("span", "lt", a.was));
      li.appendChild(el("span", "qty", text + " · " + pad(d.getDate()) +
                                       "." + pad(d.getMonth() + 1) + "."));
      box.appendChild(li);
    });
  }

  /* ══════════ Schreiben ══════════ */

  /* Solange ein Eingabefeld offen ist oder eine Aenderung unterwegs, ruht das
     Abholen — sonst baut der Fuenf-Minuten-Takt das Feld unter den Fingern neu
     auf, und der Selbst-Reload nach einem Deploy raeumt es ganz weg. */
  var belegt = 0;

  function klemmt(text) {
    var alt = document.querySelector(".klemmt");
    if (alt) alt.parentNode.removeChild(alt);
    var kasten = el("div", "klemmt", text);
    document.body.appendChild(kasten);
    setTimeout(function () {
      if (kasten.parentNode) kasten.parentNode.removeChild(kasten);
    }, 4200);
  }

  function schicken(auftrag) {
    belegt++;
    return fetch("/api/aktion", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(auftrag),
      cache: "no-store"
    }).then(function (a) {
      return a.json().catch(function () { return {}; }).then(function (d) {
        if (!a.ok || !d.ok) {
          throw new Error(d.fehler || ("HTTP " + a.status));
        }
        return d;
      });
    })["finally"](function () { belegt--; });
  }

  /* Die Antwort enthaelt nur, was sich geaendert hat. Der gemerkte Stand wird
     an der passenden Stelle ersetzt und die betroffene Karte neu gezeichnet —
     die uebrigen sollen beim Abhaken nicht flackern. */
  function uebernehmen(antwort) {
    if (!daten) return;
    if (antwort.liste === "todo.einkaufsliste") {
      daten.einkauf = antwort.posten;
      liste("einkauf", daten.einkauf, "ek-note");
    } else if (antwort.liste === "todo.luca_handball" || antwort.liste === "todo.haushalt") {
      daten.aufgaben = daten.aufgaben || {};
      daten.aufgaben[antwort.liste === "todo.haushalt" ? "haushalt" : "handball"] = antwort.posten;
      aufgaben(daten.aufgaben);
    } else if (antwort.haushalt) {
      daten.haushalt = antwort.haushalt;
      haushalt(daten.haushalt);
    }
    requestAnimationFrame(ueberlauf);
  }

  /* ── Listen ── */

  var lauf = 0;

  function posten(eintrag, entity) {
    var id = "p" + (++lauf);
    var li = el("li");
    var kasten = el("input", "tick");
    kasten.type = "checkbox";
    kasten.id = id;
    var lab = el("label", "lt", eintrag.text);
    lab.setAttribute("for", id);

    kasten.addEventListener("change", function () {
      if (!kasten.checked) { kasten.checked = true; return; }  // nur in eine Richtung
      kasten.disabled = true;
      li.classList.add("weg");
      schicken({aktion: "todo_status", liste: entity,
                uid: eintrag.uid, erledigt: true})
        .then(uebernehmen)
        .catch(function (e) {
          /* Zurueck auf Anfang: der Posten steht noch offen in Home Assistant,
             also muss er auch hier wieder offen stehen. */
          li.classList.remove("weg");
          kasten.checked = false;
          kasten.disabled = false;
          klemmt("Nicht gespeichert: " + e.message);
          veraltet();
        });
    });

    li.appendChild(kasten);
    li.appendChild(lab);
    return li;
  }

  function liste(ziel, eintraege, noteId) {
    var box = $(ziel);
    var entity = ziel === "einkauf" ? "todo.einkaufsliste" : null;
    leer(box);
    (eintraege || []).forEach(function (x) { box.appendChild(posten(x, entity)); });
    if (noteId) $(noteId).textContent = (eintraege || []).length + " offen";
  }

  function aufgaben(a) {
    var box = $("aufgaben");
    leer(box);
    var gesamt = 0;
    [["Handball", (a && a.handball) || [], "todo.luca_handball"],
     ["Haushalt", (a && a.haushalt) || [], "todo.haushalt"]].forEach(function (gruppe) {
      gesamt += gruppe[1].length;
      var h = el("h4", "lgroup", gruppe[0]);
      h.appendChild(el("span", "n", gruppe[1].length));
      h.appendChild(plusKnopf(gruppe[2], null));
      box.appendChild(h);
      var ul = el("ul", "list");
      gruppe[1].forEach(function (x) { ul.appendChild(posten(x, gruppe[2])); });
      box.appendChild(ul);
      /* Das Eingabefeld haengt unter der jeweiligen Gruppe, nicht am Kartenfuss:
         sonst waere bei zwei Listen in einer Karte nicht zu sehen, wo der neue
         Posten landet. */
      h.lastChild.zielListe = ul;
    });
    $("auf-note").textContent = gesamt + " offen";
  }

  /* ── Anlegen ── */

  function plusKnopf(entity, ul) {
    var knopf = el("button", "plus", "+");
    knopf.type = "button";
    knopf.title = "Posten anlegen";
    knopf.setAttribute("aria-label", "Posten anlegen");
    knopf.addEventListener("click", function () {
      eingabe(entity, knopf.zielListe || ul);
    });
    return knopf;
  }

  /* Es ist immer hoechstens ein Feld offen. Die Schliessfunktion des laufenden
     liegt hier, weil das Feld die Abfrage sperrt: wuerde es nur aus dem DOM
     entfernt, bliebe die Sperre stehen und die Tafel aktualisierte nie wieder. */
  var offenesFeld = null;

  function eingabe(entity, ul) {
    if (offenesFeld) offenesFeld();
    if (!ul) return;

    var zeile = el("div", "eingabe");
    var feld = el("input");
    feld.type = "text";
    feld.maxLength = 200;
    feld.placeholder = "Neuer Posten, Enter legt an";
    zeile.appendChild(feld);
    ul.parentNode.insertBefore(zeile, ul.nextSibling);

    belegt++;
    var offen = true;
    /* Wer anfaengt zu tippen und weggeht, soll die Tafel nicht dauerhaft
       anhalten. Nach anderthalb Minuten schliesst das Feld von selbst. */
    var frist = setTimeout(function () { schliessen(); }, 90000);

    function schliessen() {
      if (!offen) return;
      offen = false;
      clearTimeout(frist);
      belegt--;
      if (offenesFeld === schliessen) offenesFeld = null;
      if (zeile.parentNode) zeile.parentNode.removeChild(zeile);
    }
    offenesFeld = schliessen;

    feld.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { schliessen(); return; }
      if (e.key !== "Enter") return;
      var text = feld.value.trim();
      if (!text) { schliessen(); return; }
      feld.disabled = true;
      schicken({aktion: "todo_neu", liste: entity, text: text})
        .then(function (antwort) {
          schliessen();
          uebernehmen(antwort);
          /* Der neue Posten steht unten in der Liste — kurz hervorheben,
             sonst sucht man ihn. */
          var zeilen = ul.querySelectorAll("li");
          if (zeilen.length) zeilen[zeilen.length - 1].classList.add("neu");
        })
        .catch(function (e2) {
          feld.disabled = false;
          feld.focus();
          klemmt("Nicht angelegt: " + e2.message);
        });
    });
    feld.addEventListener("blur", function () {
      if (!feld.value.trim()) schliessen();
    });
    feld.focus();
  }

  /* ── Haushalt ── */

  /* Jede Routine zeigt, wie weit sie ueber ihr Intervall hinaus ist. Der
     Balken fuellt sich zwischen zwei Terminen und laeuft danach ins Rote —
     "seit 11 Tagen" sagt mehr als "faellig". */
  function haushalt(eintraege) {
    var box = $("haushalt");
    leer(box);
    eintraege = (eintraege || []).slice();

    /* Oben steht, was am laengsten liegt. Die feste Reihenfolge aus der
       Konfiguration sagt nichts darueber, was dran ist. */
    eintraege.sort(function (a, b) {
      if (a.faellig !== b.faellig) return a.faellig ? -1 : 1;
      return (b.tage == null ? -999 : b.tage) - (a.tage == null ? -999 : a.tage);
    });

    /* Der laengste Ueberzug gibt den Massstab. Wuerde jeder Balken bei einem
       Intervall gedeckelt, waeren acht liegen gebliebene Routinen acht gleich
       lange Balken — und die Karte saehe nur noch rot aus, ohne zu sagen,
       womit man anfangen sollte. */
    var skala = 1, i;
    for (i = 0; i < eintraege.length; i++) {
      if (eintraege[i].tage > skala) skala = eintraege[i].tage;
    }

    var faellig = 0;
    eintraege.forEach(function (c) {
      if (c.faellig) faellig++;
      box.appendChild(routine(c, skala));
    });
    $("hh-note").textContent = faellig + " von " + eintraege.length + " fällig";
  }

  function routine(c, skala) {
    var intervall = c.intervall || 7;
    var ueber = c.tage;                       // > 0: so viele Tage ueberfaellig
    var anteil, lange = false;
    if (ueber == null) {
      anteil = c.faellig ? 1 : 0;
    } else if (ueber >= 0) {
      anteil = Math.max(0.06, ueber / skala);
      lange = ueber >= intervall;             // eine ganze Runde liegen geblieben
    } else {
      /* Noch nicht faellig: der Balken zeigt, wie weit das Intervall
         abgelaufen ist, und bleibt bewusst kurz. */
      anteil = Math.max(0.04, ((intervall + ueber) / intervall) * 0.3);
    }

    var knopf = el("button", "due" + (c.faellig ? " faellig" : "") + (lange ? " lange" : ""));
    knopf.type = "button";
    knopf.appendChild(el("span", "due-name", c.name));

    var bahn = el("span", "due-track");
    var fuellung = el("i");
    bahn.appendChild(fuellung);
    knopf.appendChild(bahn);
    requestAnimationFrame(function () { fuellung.style.transform = "scaleX(" + anteil + ")"; });

    knopf.appendChild(el("span", "due-tage",
      ueber == null ? "—" : ueber > 0 ? "+" + ueber + " T" : ueber === 0 ? "heute" : ueber + " T"));

    var vorgemerkt = false, ruecksetzer = null;
    knopf.addEventListener("click", function () {
      /* Zwei Klicks statt eines Dialogs: ein `confirm()` legt einen
         Kiosk-Browser lahm, bis jemand am Rechner steht. */
      if (!vorgemerkt) {
        vorgemerkt = true;
        knopf.classList.add("fragt");
        knopf.querySelector(".due-name").textContent = "Erledigt? Zum Bestätigen nochmal klicken";
        ruecksetzer = setTimeout(function () {
          vorgemerkt = false;
          knopf.classList.remove("fragt");
          knopf.querySelector(".due-name").textContent = c.name;
        }, 3200);
        return;
      }
      clearTimeout(ruecksetzer);
      knopf.disabled = true;
      knopf.classList.remove("fragt");
      knopf.classList.add("fertig");
      knopf.querySelector(".due-name").textContent = c.name;
      schicken({aktion: "haushalt_fertig", entity: c.entity})
        .then(uebernehmen)
        .catch(function (e) {
          knopf.disabled = false;
          knopf.classList.remove("fertig");
          vorgemerkt = false;
          klemmt("Nicht quittiert: " + e.message);
          veraltet();
        });
    });
    return knopf;
  }

  /* ── Homeserver ── */

  function ring(wert, text, grenzeWarn, grenzeCrit) {
    var r = 24, umfang = 2 * Math.PI * r;
    var anteil = Math.max(0, Math.min(100, wert || 0)) / 100;
    var bild = svg("svg", {"class": "mess-ring", viewBox: "0 0 60 60"});
    bild.appendChild(svg("circle", {"class": "bahn", cx: 30, cy: 30, r: r}));
    var klasse = "wert";
    if (grenzeCrit && wert > grenzeCrit) klasse += " crit";
    else if (grenzeWarn && wert > grenzeWarn) klasse += " warn";
    var bogen = svg("circle", {
      "class": klasse, cx: 30, cy: 30, r: r,
      "stroke-dasharray": "0 " + umfang.toFixed(2),
      transform: "rotate(-90 30 30)"
    });
    bild.appendChild(bogen);
    requestAnimationFrame(function () {
      bogen.setAttribute("stroke-dasharray",
        (anteil * umfang).toFixed(2) + " " + umfang.toFixed(2));
    });
    var mitte = svg("text", {x: 30, y: 35});
    mitte.textContent = text;
    bild.appendChild(mitte);
    return bild;
  }

  /* Kurve der letzten 24 Stunden. Zwei Randwerte reichen als Massstab — eine
     Achse waere bei 24 Pixeln Hoehe nicht zu lesen. */
  function sparkline(werte, warm) {
    var bild = svg("svg", {"class": "spark" + (warm ? " signal" : ""),
                           viewBox: "0 0 100 24", preserveAspectRatio: "none"});
    if (!werte || werte.length < 2) return bild;
    var min = Math.min.apply(null, werte), max = Math.max.apply(null, werte);
    if (max - min < 0.5) max = min + 0.5;
    var punkte = [], i;
    for (i = 0; i < werte.length; i++) {
      var x = (i / (werte.length - 1)) * 100;
      var y = 22 - ((werte[i] - min) / (max - min)) * 20;
      punkte.push(x.toFixed(2) + "," + y.toFixed(2));
    }
    bild.appendChild(svg("polygon", {points: "0,24 " + punkte.join(" ") + " 100,24"}));
    bild.appendChild(svg("polyline", {
      points: punkte.join(" "), "vector-effect": "non-scaling-stroke"
    }));
    return bild;
  }

  function server(s, verlauf) {
    if (!s) return;
    var box = $("srv-last");
    leer(box);
    verlauf = verlauf || {};

    function messwert(name, wert, text, kurve, warm, gWarn, gCrit) {
      var z = el("div", "mess");
      z.appendChild(ring(wert, text, gWarn, gCrit));
      var txt = el("div", "mess-txt");
      txt.appendChild(el("span", "mess-lab", name));
      txt.appendChild(sparkline(kurve, warm));
      z.appendChild(txt);
      box.appendChild(z);
    }
    function zeile(name, text, klein) {
      var z = el("div", "kv");
      z.appendChild(el("span", "k", name));
      var v = el("span", "v", text);
      if (klein) v.appendChild(el("small", null, " " + klein));
      z.appendChild(v);
      box.appendChild(z);
    }

    messwert("Arbeitsspeicher", s.ram, Math.round(s.ram || 0) + "%", verlauf.ram, false, 85, 93);
    messwert("Massenspeicher", s.disk, Math.round(s.disk || 0) + "%", null, false, 90, 96);
    /* Die Temperatur ist keine Prozentzahl. Der Ring zeigt sie auf der Spanne
       30–90 °C, weil ein Ring ohne Bezugsgroesse nichts aussagt. */
    messwert("Prozessortemperatur",
             s.temperatur == null ? 0 : ((s.temperatur - 30) / 60) * 100,
             Math.round(s.temperatur || 0) + "°", verlauf.temp, true, 65, 80);
    zeile("Load", num(s.load, 2));
    zeile("RAM frei", s.ram_frei == null ? "—" : num(s.ram_frei), "von 7,1 GiB");

    $("srv-note").textContent = "homeserver" +
      (s.tage_online == null ? "" : " · online seit " + s.tage_online + " Tagen");
  }

  /* ── Abholen ── */
  function stand(zeit, ok) {
    var d = zeit ? new Date(zeit) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    $("sync-t").textContent = hm;
    $("stand").textContent = "Stand " + hm;
    $("sync-dot").className = ok ? "dot" : "dot crit";
    $("quelle-pill").className = ok ? "pill ok" : "pill warn";
    $("quelle-pill").textContent = ok ? "live" : "veraltet";
  }

  function veraltet() {
    $("sync-dot").className = "dot crit";
    $("quelle-pill").className = "pill warn";
    $("quelle-pill").textContent = "veraltet";
  }

  function holen() {
    if (belegt) return;   // nicht mitten in einer Eingabe neu aufbauen
    fetch("/api/board", { cache: "no-store" })
      .then(function (a) {
        if (!a.ok) throw new Error("HTTP " + a.status);
        return a.json();
      })
      .then(function (d) {
        daten = d;
        wetter(d.wetter);
        jobs(d.jobs, "jobs");
        dienste(d.server && d.server.dienste);
        termin(d.termin, d.termin_stand);
        if (d.balu) {
          $("balu-ver").textContent = d.balu.version || "—";
          $("balu-sp").textContent = (d.balu.spieler || 0) + " Spielerinnen";
          $("balu-tr").textContent = (d.balu.trainings || 0) + " Trainings";
        }
        beteiligung(d.beteiligung);
        kalender(d.kalender);
        abfuhr(d.abfuhr);
        liste("einkauf", d.einkauf, "ek-note");
        aufgaben(d.aufgaben);
        haushalt(d.haushalt);
        server(d.server, d.verlauf);
        $("srv-pill").className = d.ha_erreichbar ? "pill ok" : "pill warn";
        $("srv-pill").textContent = d.ha_erreichbar ? "alles läuft" : "HA nicht erreichbar";
        stand(d.stand, d.ha_erreichbar !== false && !d.fehler);
        requestAnimationFrame(ueberlauf);
      })
      .catch(function (e) {
        /* Der letzte Stand bleibt stehen — eine leere Tafel hilft niemandem. */
        veraltet();
        if (window.console) { console.warn("[nebenschirm] " + e); }
      });
  }

  /* Am Kiosk scrollt niemand. Passt eine Liste nicht in ihre Karte, sagt
     die Karte wenigstens, wie viel fehlt. */
  function ueberlauf() {
    var koerper = document.querySelectorAll(".cbody");
    Array.prototype.forEach.call(koerper, function (b) {
      var alt = b.querySelector(".mehr");
      if (alt) alt.parentNode.removeChild(alt);
      if (b.scrollHeight - b.clientHeight < 6) return;
      var zeilen = b.querySelectorAll("li, .due");
      var versteckt = 0;
      /* offsetTop zaehlt ab dem naechsten positionierten Vorfahren, nicht ab
         dem scrollenden Kasten — deshalb echte Bildschirmkanten vergleichen. */
      var unten = b.getBoundingClientRect().bottom;
      Array.prototype.forEach.call(zeilen, function (z) {
        if (z.getBoundingClientRect().bottom > unten + 1) versteckt++;
      });
      if (!versteckt) return;
      b.appendChild(el("div", "mehr", "+ " + versteckt + " weitere"));
    });
  }

  /* ── Neue Fassung? ── */

  /* Nach einem Deploy liegt am iMac noch die alte Seite im Speicher — die
     Fuenf-Minuten-Abfrage holt nur Daten, keinen neuen Code. Der Dienst nennt
     unter /api/ping einen Stempel aus Aenderungszeit und Groesse von
     index.html und board.js; wird er ein anderer, laedt sich die Tafel selbst
     neu. /api/ping fragt keine Quelle ab, der Minutentakt kostet also nichts. */
  var bau = null;

  function fassung() {
    if (belegt) return;   // nicht neu laden, waehrend jemand tippt
    fetch("/api/ping", { cache: "no-store" })
      .then(function (a) { return a.ok ? a.json() : null; })
      .then(function (d) {
        if (!d || !d.bau) return;
        if (bau === null) {
          bau = d.bau;
          return;
        }
        if (d.bau !== bau) {
          if (window.console) { console.log("[nebenschirm] neue Fassung — lade neu"); }
          location.reload();
        }
      })
      .catch(function () {
        /* Dass der Dienst weg ist, meldet schon die Datenabfrage. */
      });
  }

  /* Der Knopf an der Einkaufsliste steht fest im Markup — die Aufgabenkarte
     baut ihre Knoepfe selbst, weil ihre Gruppen aus den Daten kommen. */
  var ekKnopf = document.querySelector(".plus[data-liste]");
  if (ekKnopf) {
    ekKnopf.addEventListener("click", function () {
      eingabe(ekKnopf.getAttribute("data-liste"), $(ekKnopf.getAttribute("data-ziel")));
    });
  }

  uhr();
  setInterval(uhr, 1000);
  holen();
  setInterval(holen, INTERVALL);
  fassung();
  setInterval(fassung, FASSUNG_INTERVALL);
})();
