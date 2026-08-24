// marktmessung.mjs
// Misst wiederholbar, wie viel Geld auf Marktplaetzen fuer autonome Agenten
// tatsaechlich fliesst. Quellen: BountyBook und Daydreams TaskMarket.
//
// Aufruf:
//   node tools/marktmessung.mjs                             # normaler Lauf
//   node tools/marktmessung.mjs --selbsttest                # nur Selbstpruefung, keine HTTP-Anfragen
//   node tools/marktmessung.mjs --zusammenfassung <pfad>    # zusaetzlich maschinenlesbare Zusammenfassung schreiben
//
// Harte Regeln (aus Fehlern vorheriger Laeufe):
//   - Nur GET, kein POST, keine Wallet, keine Signatur.
//   - Hoechstens 12 HTTP-Anfragen pro Lauf.
//   - Mindestens 1500 ms Pause zwischen Anfragen.
//   - Kein gefaelschter User-Agent.
//   - Bei HTTP 403 oder 429: sofort abbrechen, Rueckgabewert 4.
//   - Unbekannte Antworten roh ausgeben, nicht stillschweigend verschlucken.
//   - Teilmenge darf NIE wie eine Gesamtmenge aussehen.

import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = __dirname;
const AUSGABE_VERZEICHNIS = resolve(WORKSPACE, 'data');

// Mindestpause zwischen Anfragen in Millisekunden
const PAUSE_MS = 1500;

// HTTP-Anfragebudget fuer diesen Lauf
const ANFRAGEN_LIMIT = 12;
let anfragenVerbraucht = 0;

// Ehrlicher User-Agent (kein Spoofing)
const USER_AGENT = 'ideenschmiede-marktmessung/1.0 (+https://github.com/peppe1337)';

// TaskMarket: reward-Einheit ist Mikro-USDC (1/1.000.000 USDC).
// Beobachtet: reward=2000000 => 2,00 USDC, fee=7,5% => netReward=1850000.
const TASKMARKET_REWARD_EINHEIT = 1_000_000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── SELF-CONTAINED AGGREGATIONSFUNKTIONEN ────────────────────────────────────
// Diese Funktionen werden sowohl beim Selbsttest als auch bei der echten Messung
// verwendet. Wer die Funktion veraendert, laeuft sofort in den Selbsttest.

/**
 * Berechnet den Median eines Arrays von Zahlen.
 * Leeres Array => null (nicht messbar).
 */
function median(werte) {
  if (werte.length === 0) return null;
  const sortiert = [...werte].sort((a, b) => a - b);
  const mitte = Math.floor(sortiert.length / 2);
  if (sortiert.length % 2 === 1) {
    return sortiert[mitte];
  }
  return (sortiert[mitte - 1] + sortiert[mitte]) / 2;
}

/**
 * Berechnet Summe, Median und Maximum eines Budget-Arrays.
 * Gibt immer ein Objekt zurueck; fehlende Werte sind null, nicht 0.
 */
function aggregiereBudgets(budgets) {
  if (budgets.length === 0) {
    return { summe: null, median: null, maximum: null, anzahl: 0 };
  }
  const summe = budgets.reduce((s, b) => s + b, 0);
  const max = Math.max(...budgets);
  const med = median(budgets);
  return { summe, median: med, maximum: max, anzahl: budgets.length };
}

/**
 * Berechnet den Anteil des groessten Auftraggebers (als Anteil 0..1).
 * Gibt { groessterAuftraggeber, anteil, anzahlVerschiedener } zurueck.
 */
function aggregiereAuftraggeber(adressen) {
  if (adressen.length === 0) {
    return { groessterAuftraggeber: null, anteil: null, anzahlVerschiedener: 0 };
  }
  const zaehler = new Map();
  for (const adresse of adressen) {
    zaehler.set(adresse, (zaehler.get(adresse) || 0) + 1);
  }
  let maxAdresse = null;
  let maxAnzahl = 0;
  for (const [adresse, anzahl] of zaehler) {
    if (anzahl > maxAnzahl) {
      maxAnzahl = anzahl;
      maxAdresse = adresse;
    }
  }
  return {
    groessterAuftraggeber: maxAdresse,
    anteil: maxAnzahl / adressen.length,
    anzahlVerschiedener: zaehler.size,
  };
}

/**
 * Berechnet Median- und Hoechstalter in Tagen relativ zu jetzt.
 * Erwartet Unix-Zeitstempel in Sekunden.
 */
function aggregiereAlter(erstelltAm, jetzt = Date.now()) {
  if (erstelltAm.length === 0) {
    return { medianAlterTage: null, maxAlterTage: null, anzahl: 0 };
  }
  const alterTage = erstelltAm.map(ts => (jetzt - ts * 1000) / (1000 * 60 * 60 * 24));
  return {
    medianAlterTage: median(alterTage),
    maxAlterTage: Math.max(...alterTage),
    anzahl: alterTage.length,
  };
}

// ── SELBSTTEST ────────────────────────────────────────────────────────────────
// Eingebauter Beispieldatensatz mit von Hand ausgerechneten Sollwerten.
// Jede Abweichung bricht mit Rueckgabewert 2 ab — die Messung waere sonst wertlos.

function selbsttest() {
  console.log('=== Selbsttest der Aggregationsfunktionen ===');
  console.log('');

  // Beispieldatensatz: 5 offene Jobs
  // Budgets: [1.00, 2.50, 2.50, 5.00, 10.00] USDC
  // Summe: 21.00
  // Median (ungerade Anzahl, Index 2): 2.50
  // Maximum: 10.00
  // Auftraggeber: [A, A, B, C, A] => A:3, B:1, C:1 => 3 verschiedene, groesster A mit 3/5=0.60
  const beispielBudgets = [1.00, 2.50, 2.50, 5.00, 10.00];
  const beispielAuftraggeber = ['0xAAAA', '0xAAAA', '0xBBBB', '0xCCCC', '0xAAAA'];
  // Unix-Zeitstempel: 1 Tag, 3 Tage, 5 Tage, 10 Tage, 20 Tage vor jetzt
  const jetzt = 1_700_000_000_000; // fixer Zeitpunkt fuer Reproduzierbarkeit
  const beispielErstelltAm = [
    Math.floor((jetzt -  1 * 24 * 3600 * 1000) / 1000),
    Math.floor((jetzt -  3 * 24 * 3600 * 1000) / 1000),
    Math.floor((jetzt -  5 * 24 * 3600 * 1000) / 1000),
    Math.floor((jetzt - 10 * 24 * 3600 * 1000) / 1000),
    Math.floor((jetzt - 20 * 24 * 3600 * 1000) / 1000),
  ];

  // Sollwerte (von Hand ausgerechnet)
  const SOLL = {
    summe:              21.00,
    median:              2.50,
    maximum:            10.00,
    anzahlVerschiedener: 3,
    groessterAnteil:     0.60,        // 3 von 5
    medianAlterTage:     5.00,        // [1,3,5,10,20] => Median = 5
    maxAlterTage:       20.00,
  };

  let fehler = 0;

  function pruefe(name, ist, soll, toleranz = 1e-9) {
    const ok = Math.abs(ist - soll) <= toleranz;
    const markierung = ok ? 'OK  ' : 'FEHLER';
    console.log(`  ${markierung} ${name}: ist=${ist}, soll=${soll}`);
    if (!ok) fehler++;
  }

  const budgetErg = aggregiereBudgets(beispielBudgets);
  pruefe('Summe',   budgetErg.summe,   SOLL.summe);
  pruefe('Median',  budgetErg.median,  SOLL.median);
  pruefe('Maximum', budgetErg.maximum, SOLL.maximum);

  const auftraggeber = aggregiereAuftraggeber(beispielAuftraggeber);
  pruefe('AuftraggeberAnzahl', auftraggeber.anzahlVerschiedener, SOLL.anzahlVerschiedener);
  pruefe('GroessterAnteil',    auftraggeber.anteil,              SOLL.groessterAnteil);

  const alter = aggregiereAlter(beispielErstelltAm, jetzt);
  pruefe('MedianAlterTage', alter.medianAlterTage, SOLL.medianAlterTage);
  pruefe('MaxAlterTage',    alter.maxAlterTage,    SOLL.maxAlterTage);

  console.log('');

  if (fehler > 0) {
    console.error(`SELBSTTEST FEHLGESCHLAGEN: ${fehler} Abweichung(en). Aggregation ist fehlerhaft.`);
    console.error('Die Messung waere wertlos — Abbruch.');
    process.exit(2);
  }

  console.log('Selbsttest bestanden. Alle Aggregationsfunktionen korrekt.');
  console.log('HTTP-Anfragen fuer diesen Lauf: 0');
  process.exit(0);
}

// ── HTTP-ABRUF ────────────────────────────────────────────────────────────────

/**
 * Fuehrt eine GET-Anfrage aus. Haelt das Budget ein, wartet nicht selbst —
 * der Aufrufer ist verantwortlich fuer Pausen.
 *
 * Bei 403/429: sofortiger Abbruch mit exit(4).
 * Bei sonstigen Fehlern: Exception mit Rohantwort im Message-Feld.
 */
async function get(url) {
  if (anfragenVerbraucht >= ANFRAGEN_LIMIT) {
    // Wird vom Aufrufer abgefangen und als "unvollstaendig" markiert
    throw new BudgetErschoepftFehler(
      `Anfragebudget erschoepft: ${ANFRAGEN_LIMIT} Anfragen verbraucht.`
    );
  }

  anfragenVerbraucht++;
  process.stderr.write(`  [${anfragenVerbraucht}/${ANFRAGEN_LIMIT}] GET ${url}\n`);

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
    },
    redirect: 'follow',
  });

  // Bei Sperrung: sofort abbrechen, nicht wiederholen
  if (resp.status === 403 || resp.status === 429) {
    console.error(`\nHTTP ${resp.status} von ${url}`);
    console.error('Zugang gesperrt oder Anfragelimit erreicht. Sofortiger Abbruch.');
    console.error('Nicht erneut versuchen, nicht umgehen.');
    process.exit(4);
  }

  const text = await resp.text();

  if (!resp.ok) {
    throw new Error(
      `HTTP ${resp.status} fuer ${url}\nRohantwort (erste 500 Zeichen): ${text.slice(0, 500)}`
    );
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Unbekannte Antwort roh ausgeben, nicht stillschweigend verschlucken
    console.error(`\nUnerwartete Nicht-JSON-Antwort von ${url}:`);
    console.error(text.slice(0, 1000));
    throw new Error(`Antwort von ${url} ist kein JSON (HTTP ${resp.status})`);
  }

  return json;
}

// Eigene Fehlerklasse, damit der Aufrufer Budget-Erschoepfung von echten Fehlern trennen kann
class BudgetErschoepftFehler extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetErschoepftFehler';
  }
}

// ── BOUNTYBOOK-MESSUNG ────────────────────────────────────────────────────────

const BOUNTYBOOK_URL = 'https://api.bountybook.ai/jobs';

/**
 * Laedt alle BountyBook-Jobs durch Seitenblaettern.
 * Gibt { jobs, vollstaendig, total, geladenSeiten } zurueck.
 * vollstaendig=false wenn das Budget die Vollstaendigkeit verhinderte.
 */
async function ladeBountyBookJobs() {
  const alleJobs = [];
  let seite = 1;
  let totalLautApi = null;
  let totalPages = null;
  let vollstaendig = true;
  const rohantworten = [];

  while (true) {
    const url = `${BOUNTYBOOK_URL}?limit=100&page=${seite}`;

    let daten;
    try {
      daten = await get(url);
    } catch (err) {
      if (err.name === 'BudgetErschoepftFehler') {
        vollstaendig = false;
        break;
      }
      throw err;
    }

    // Pflichtfelder pruefen — fehlende Felder sind messbar, nicht ratbar
    const fehlendeFelderOben = ['jobs', 'total', 'page', 'totalPages'].filter(
      f => !(f in daten)
    );
    if (fehlendeFelderOben.length > 0) {
      console.error(
        `\nBountyBook-Antwort fehlen erwartete Felder: ${fehlendeFelderOben.join(', ')}`
      );
      console.error('Rohantwort:', JSON.stringify(daten).slice(0, 500));
      throw new Error('BountyBook-Antwortstruktur unbekannt — nicht messbar');
    }

    if (!Array.isArray(daten.jobs)) {
      console.error('\nBountyBook: Feld "jobs" ist kein Array. Rohantwort:');
      console.error(JSON.stringify(daten).slice(0, 500));
      throw new Error('BountyBook: "jobs" ist kein Array');
    }

    rohantworten.push(daten);
    alleJobs.push(...daten.jobs);

    if (totalLautApi === null) {
      totalLautApi = daten.total;
      totalPages = daten.totalPages;
    }

    // Plausibilitaet: leere Seite obwohl noch Daten erwartet
    if (daten.jobs.length === 0 && alleJobs.length < totalLautApi) {
      console.error(
        `\nWARNUNG: BountyBook liefert leere Seite ${seite}, aber erst ${alleJobs.length} von ${totalLautApi} geladen.`
      );
      vollstaendig = false;
      break;
    }

    // Fertig wenn alle geladen oder letzte Seite erreicht
    if (seite >= totalPages || alleJobs.length >= totalLautApi) {
      break;
    }

    seite++;

    // Pause vor naechster Anfrage (Pflicht)
    await sleep(PAUSE_MS);
  }

  return { jobs: alleJobs, vollstaendig, total: totalLautApi, rohantworten };
}

// ── TASKMARKET-MESSUNG ────────────────────────────────────────────────────────

const TASKMARKET_URL = 'https://api.taskmarket.dev/api/tasks';

/**
 * Laedt TaskMarket-Aufgaben eines bestimmten Status durch Cursor-Paginierung.
 * Gibt { tasks, vollstaendig, rohantworten } zurueck.
 */
async function ladeTaskMarketAufgaben(status) {
  const alleAufgaben = [];
  let cursor = null;
  let vollstaendig = true;
  const rohantworten = [];

  while (true) {
    let url = `${TASKMARKET_URL}?status=${encodeURIComponent(status)}&limit=100`;
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }

    let daten;
    try {
      daten = await get(url);
    } catch (err) {
      if (err.name === 'BudgetErschoepftFehler') {
        vollstaendig = false;
        break;
      }
      throw err;
    }

    // TaskMarket liefert keine Gesamtzahl — nur tasks-Array und hasMore.
    // Fehlende Felder werden als "nicht messbar" gemeldet, nicht auf 0 defaulted.
    if (!('tasks' in daten)) {
      console.error('\nTaskMarket-Antwort fehlt Feld "tasks". Rohantwort:');
      console.error(JSON.stringify(daten).slice(0, 500));
      throw new Error('TaskMarket: Feld "tasks" fehlt — nicht messbar');
    }

    if (!Array.isArray(daten.tasks)) {
      console.error('\nTaskMarket: Feld "tasks" ist kein Array. Rohantwort:');
      console.error(JSON.stringify(daten).slice(0, 500));
      throw new Error('TaskMarket: "tasks" ist kein Array');
    }

    if (!('hasMore' in daten)) {
      // hasMore fehlt — wir koennen nicht wissen ob vollstaendig
      console.error(
        '\nWARNUNG: TaskMarket-Antwort fehlt Feld "hasMore". Vollstaendigkeit unbekannt.'
      );
      console.error('Rohantwort-Kopf:', JSON.stringify(daten).slice(0, 200));
      vollstaendig = false;
    }

    rohantworten.push(daten);
    alleAufgaben.push(...daten.tasks);

    const hatMehr = daten.hasMore === true;

    if (!hatMehr) {
      break;
    }

    // Cursor fuer naechste Seite
    if (!daten.nextCursor) {
      console.error(
        '\nWARNUNG: TaskMarket meldet hasMore=true aber nextCursor fehlt. Abbruch der Paginierung.'
      );
      vollstaendig = false;
      break;
    }

    cursor = daten.nextCursor;
    await sleep(PAUSE_MS);
  }

  return { tasks: alleAufgaben, vollstaendig, rohantworten };
}

// ── AUSWERTUNG: BOUNTYBOOK ────────────────────────────────────────────────────

function werteBountyBookAus(jobs, vollstaendig, total) {
  const vollstaendigkeitsPraefix = vollstaendig
    ? ''
    : `unvollstaendig: ${jobs.length} von ${total ?? '?'} — `;

  // Jobs nach Status aufteilen
  const offen = jobs.filter(j => j.status === 'open');
  const bestaetigtAusgezahlt = jobs.filter(j => j.payout_status === 'confirmed');

  // Budgets der offenen Jobs (als Zahlen)
  const offeneBudgets = [];
  const fehlerhafteBudgets = [];
  for (const job of offen) {
    const wert = parseFloat(job.budget_usdc);
    if (isNaN(wert)) {
      fehlerhafteBudgets.push(job.id);
    } else {
      offeneBudgets.push(wert);
    }
  }

  // Auftraggeber der offenen Jobs
  const offeneAuftraggeber = offen
    .map(j => j.poster_address)
    .filter(a => a != null && a !== '');

  // Alter der offenen Jobs (created_at ist Unix-Sekunden)
  const offeneErstelltAm = offen
    .map(j => j.created_at)
    .filter(ts => typeof ts === 'number' && !isNaN(ts));

  // Ausgezahlte Budgets
  const ausgezahlteBudgets = [];
  for (const job of bestaetigtAusgezahlt) {
    const wert = parseFloat(job.budget_usdc);
    if (!isNaN(wert)) ausgezahlteBudgets.push(wert);
  }
  const summAusgezahlt = ausgezahlteBudgets.reduce((s, b) => s + b, 0);

  const budgetErg = aggregiereBudgets(offeneBudgets);
  const auftraggeberErg = aggregiereAuftraggeber(offeneAuftraggeber);
  const alterErg = aggregiereAlter(offeneErstelltAm);

  return {
    vollstaendigkeitsPraefix,
    gesamtLautApi: total,
    geladenGesamt: jobs.length,
    anzahlOffen: offen.length,
    budgets: budgetErg,
    fehlerhafteBudgets,
    auftraggeber: auftraggeberErg,
    alter: alterErg,
    ausgezahlt: {
      anzahl: bestaetigtAusgezahlt.length,
      summe: summAusgezahlt,
    },
  };
}

// ── AUSWERTUNG: TASKMARKET ────────────────────────────────────────────────────

/**
 * reward ist in Mikro-USDC (1/1.000.000 USDC).
 * Wenn das Feld fehlt oder nicht parsbar ist, wird die Aufgabe als "nicht messbar" markiert.
 */
function taskMarketRewardZuUsdc(aufgabe) {
  if (!('reward' in aufgabe)) return null;
  const wert = Number(aufgabe.reward);
  if (isNaN(wert) || wert < 0) return null;
  return wert / TASKMARKET_REWARD_EINHEIT;
}

function werteTaskMarketAus(aufgaben, vollstaendig) {
  const vollstaendigkeitsPraefix = vollstaendig
    ? ''
    : `unvollstaendig: ${aufgaben.length} geladen — `;

  const offen = aufgaben.filter(t => t.status === 'open');

  // Budgets
  const offeneBudgets = [];
  let nichtMessbareBudgets = 0;
  for (const t of offen) {
    const usdc = taskMarketRewardZuUsdc(t);
    if (usdc === null) {
      nichtMessbareBudgets++;
    } else {
      offeneBudgets.push(usdc);
    }
  }

  // Auftraggeber: TaskMarket nennt sie "requester"
  const offeneAuftraggeber = offen
    .map(t => t.requester)
    .filter(a => a != null && a !== '');

  // Alter: createdAt ist ISO-8601-String
  const offeneErstelltAm = offen
    .map(t => {
      if (!t.createdAt) return null;
      const ts = Date.parse(t.createdAt);
      return isNaN(ts) ? null : Math.floor(ts / 1000);
    })
    .filter(ts => ts !== null);

  const budgetErg = aggregiereBudgets(offeneBudgets);
  const auftraggeberErg = aggregiereAuftraggeber(offeneAuftraggeber);
  const alterErg = aggregiereAlter(offeneErstelltAm);

  return {
    vollstaendigkeitsPraefix,
    geladenGesamt: aufgaben.length,
    anzahlOffen: offen.length,
    nichtMessbareBudgets,
    budgets: budgetErg,
    auftraggeber: auftraggeberErg,
    alter: alterErg,
  };
}

// ── BERICHTAUSGABE ────────────────────────────────────────────────────────────

function formatZahl(wert, nachkommastellen = 2) {
  if (wert === null || wert === undefined) return 'nicht messbar';
  return wert.toFixed(nachkommastellen);
}

function formatAnteil(anteil) {
  if (anteil === null || anteil === undefined) return 'nicht messbar';
  return `${(anteil * 100).toFixed(1)} %`;
}

function druckeAbschnitt(titel, zeilen) {
  const breite = 60;
  console.log('');
  console.log('═'.repeat(breite));
  console.log(`  ${titel}`);
  console.log('─'.repeat(breite));
  for (const zeile of zeilen) {
    const pad = 32;
    if (zeile.length === 0 || (zeile.length === 1 && zeile[0] === '')) {
      // Leerzeile als Abstand
      console.log('');
    } else if (zeile.length === 1) {
      // Ueberschrift ohne Wert (kursiv durch Einzug kenntlich)
      console.log(`  ${zeile[0]}`);
    } else {
      // Schluessel-Wert-Paar
      console.log(`  ${zeile[0].padEnd(pad)} ${zeile[1]}`);
    }
  }
}

function druckeBountyBookBericht(erg) {
  const p = erg.vollstaendigkeitsPraefix;

  druckeAbschnitt('BountyBook (bountybook.ai)', [
    ['Aufgaben gesamt (laut API)',   `${p}${erg.gesamtLautApi ?? 'unbekannt'} (n=${erg.geladenGesamt})`],
    ['Davon offen',                  `${p}${erg.anzahlOffen} (n=${erg.geladenGesamt})`],
    [''],
    ['Offene Budgets (USDC)'],
    ['  Summe',   `${p}${formatZahl(erg.budgets.summe)} USDC (n=${erg.budgets.anzahl})`],
    ['  Median',  `${p}${formatZahl(erg.budgets.median)} USDC (n=${erg.budgets.anzahl})`],
    ['  Maximum', `${p}${formatZahl(erg.budgets.maximum)} USDC (n=${erg.budgets.anzahl})`],
    [''],
    ['Auftraggeber (offene Jobs)'],
    ['  Verschiedene Adressen',  `${p}${erg.auftraggeber.anzahlVerschiedener} (n=${erg.anzahlOffen})`],
    ['  Anteil des groessten',   `${p}${formatAnteil(erg.auftraggeber.anteil)} (${erg.auftraggeber.groessterAuftraggeber ?? 'unbekannt'})`],
    [''],
    ['Tatsaechliche Auszahlungen'],
    ['  Bestaetigt (payout=confirmed)', `${p}${erg.ausgezahlt.anzahl} (n=${erg.geladenGesamt})`],
    ['  Summe bestaetigter Auszahlung',  `${p}${formatZahl(erg.ausgezahlt.summe)} USDC`],
    [''],
    ['Alter offener Aufgaben'],
    ['  Median',  `${p}${formatZahl(erg.alter.medianAlterTage, 1)} Tage (n=${erg.alter.anzahl})`],
    ['  Maximum', `${p}${formatZahl(erg.alter.maxAlterTage, 1)} Tage (n=${erg.alter.anzahl})`],
  ]);

  if (erg.fehlerhafteBudgets.length > 0) {
    console.log(`  WARNUNG: ${erg.fehlerhafteBudgets.length} Jobs mit nicht parsebarem budget_usdc ausgeschlossen.`);
  }
}

function druckeTaskMarketBericht(erg) {
  const p = erg.vollstaendigkeitsPraefix;

  druckeAbschnitt('Daydreams TaskMarket (taskmarket.dev)', [
    ['Aufgaben geladen',     `${p}${erg.geladenGesamt} (n=${erg.geladenGesamt})`],
    ['Davon offen',          `${p}${erg.anzahlOffen} (n=${erg.geladenGesamt})`],
    ['HINWEIS: TaskMarket liefert keine Gesamtzahl — nur offen abgefragt'],
    [''],
    ['Offene Budgets (USDC, reward / 1.000.000)'],
    ['  Summe',   `${p}${formatZahl(erg.budgets.summe)} USDC (n=${erg.budgets.anzahl})`],
    ['  Median',  `${p}${formatZahl(erg.budgets.median)} USDC (n=${erg.budgets.anzahl})`],
    ['  Maximum', `${p}${formatZahl(erg.budgets.maximum)} USDC (n=${erg.budgets.anzahl})`],
    ...(erg.nichtMessbareBudgets > 0
      ? [['  Nicht messbar (Feld fehlt/ungueltig)', `${erg.nichtMessbareBudgets}`]]
      : []),
    [''],
    ['Auftraggeber (offene Jobs)'],
    ['  Verschiedene Adressen',  `${p}${erg.auftraggeber.anzahlVerschiedener} (n=${erg.anzahlOffen})`],
    ['  Anteil des groessten',   `${p}${formatAnteil(erg.auftraggeber.anteil)}`],
    [''],
    ['Alter offener Aufgaben (aus createdAt)'],
    ['  Median',  `${p}${formatZahl(erg.alter.medianAlterTage, 1)} Tage (n=${erg.alter.anzahl})`],
    ['  Maximum', `${p}${formatZahl(erg.alter.maxAlterTage, 1)} Tage (n=${erg.alter.anzahl})`],
    [''],
    // Ehrliche Fassung: Der Endpunkt EXISTIERT (`status=completed`), er wurde nur nicht
    // abgefragt — aus Anfragebudget, und weil TaskMarket die Auszahlung ueber
    // `primaryAward.workerAddress` ausweist statt ueber einen Transaktions-Hash wie
    // BountyBook. Die beiden Zahlen waeren also nicht ohne Weiteres vergleichbar.
    // "Kein Endpunkt gefunden" waere eine Falschaussage gewesen und stand hier zuerst.
    ['HINWEIS: Auszahlungen nicht gemessen', '(Endpunkt status=completed existiert,'],
    ['', ' bewusst nicht abgefragt — siehe Kommentar im Code)'],
  ]);
}

// ── HAUPTPROGRAMM ─────────────────────────────────────────────────────────────

async function main() {
  const argumente = process.argv.slice(2);

  // Selbsttest laeuft OHNE HTTP-Anfragen, daher als allererstes pruefen.
  // Englische Aliasse, weil das Werkzeug mit dem veroeffentlichten Repo ausgeliefert wird.
  if (argumente.includes('--selbsttest') || argumente.includes('--selftest')) {
    selbsttest();
    // selbsttest() beendet den Prozess selbst
  }

  // Argumentpruefung VOR jeder HTTP-Anfrage. Ein fehlerhafter Aufruf darf keine
  // Fremdserver-Anfragen verbrauchen (Lehre aus Lauf 18, suchnachfrage.mjs).
  const zusammenfassungIndex = argumente.findIndex(
    (a) => a === '--zusammenfassung' || a === '--summary',
  );
  let zusammenfassungPfad = null;
  if (zusammenfassungIndex !== -1) {
    zusammenfassungPfad = argumente[zusammenfassungIndex + 1];
    if (!zusammenfassungPfad || zusammenfassungPfad.startsWith('--')) {
      console.error('FEHLER: --zusammenfassung / --summary erwartet einen Dateipfad.');
      console.error('Keine HTTP-Anfrage verbraucht.');
      process.exit(3);
    }
  }

  // Vor dem echten Lauf: Selbsttest als Sanity-Check ausfuehren
  // (nur die Aggregationsfunktionen, ohne HTTP)
  console.log('=== Marktmessung Agentenmarktplaetze ===');
  console.log(`Datum: ${new Date().toISOString()}`);
  console.log('');
  console.log('Aggregations-Selbstpruefung ...');

  // Kleiner eingebetteter Smoke-Test — exakt wie --selbsttest, aber ohne exit()
  {
    const testBudgets = [1.00, 2.50, 2.50, 5.00, 10.00];
    const testAuftraggeber = ['0xAAAA', '0xAAAA', '0xBBBB', '0xCCCC', '0xAAAA'];
    const jetzt = 1_700_000_000_000;
    const testErstelltAm = [
      Math.floor((jetzt -  1 * 24 * 3600 * 1000) / 1000),
      Math.floor((jetzt -  3 * 24 * 3600 * 1000) / 1000),
      Math.floor((jetzt -  5 * 24 * 3600 * 1000) / 1000),
      Math.floor((jetzt - 10 * 24 * 3600 * 1000) / 1000),
      Math.floor((jetzt - 20 * 24 * 3600 * 1000) / 1000),
    ];
    const SOLL = {
      summe: 21.00, median: 2.50, maximum: 10.00,
      anzahlVerschiedener: 3, groessterAnteil: 0.60,
      medianAlterTage: 5.00, maxAlterTage: 20.00,
    };
    const b = aggregiereBudgets(testBudgets);
    const a = aggregiereAuftraggeber(testAuftraggeber);
    const al = aggregiereAlter(testErstelltAm, jetzt);
    const abweichungen = [
      ['Summe',               b.summe,               SOLL.summe],
      ['Median',              b.median,               SOLL.median],
      ['Maximum',             b.maximum,              SOLL.maximum],
      ['AuftraggeberAnzahl',  a.anzahlVerschiedener,  SOLL.anzahlVerschiedener],
      ['GroessterAnteil',     a.anteil,               SOLL.groessterAnteil],
      ['MedianAlterTage',     al.medianAlterTage,     SOLL.medianAlterTage],
      ['MaxAlterTage',        al.maxAlterTage,        SOLL.maxAlterTage],
    ].filter(([, ist, soll]) => Math.abs(ist - soll) > 1e-9);

    if (abweichungen.length > 0) {
      console.error('SELBSTPRUEFUNG FEHLGESCHLAGEN:');
      for (const [name, ist, soll] of abweichungen) {
        console.error(`  ${name}: ist=${ist}, soll=${soll}`);
      }
      console.error('Die Messung waere wertlos — Abbruch.');
      process.exit(2);
    }
    console.log('  Selbstpruefung bestanden.');
  }

  console.log('');
  console.log('Starte HTTP-Anfragen ...');
  console.log('');

  // ── BOUNTYBOOK LADEN ────────────────────────────────────────────────────────
  console.log('Quelle 1: BountyBook');
  let bbJobs, bbVollstaendig, bbTotal, bbRohantworten;
  try {
    const bb = await ladeBountyBookJobs();
    bbJobs = bb.jobs;
    bbVollstaendig = bb.vollstaendig;
    bbTotal = bb.total;
    bbRohantworten = bb.rohantworten;
  } catch (err) {
    console.error(`\nFEHLER beim Laden der BountyBook-Daten: ${err.message}`);
    process.exit(1);
  }

  console.log(
    `  BountyBook: ${bbJobs.length}${bbVollstaendig ? '' : ` (von ${bbTotal ?? '?'}, UNVOLLSTAENDIG)`} Jobs geladen.`
  );

  // Pause vor naechster Quelle
  await sleep(PAUSE_MS);

  // ── TASKMARKET LADEN ────────────────────────────────────────────────────────
  console.log('Quelle 2: TaskMarket (status=open)');
  let tmAufgaben, tmVollstaendig, tmRohantworten;
  try {
    const tm = await ladeTaskMarketAufgaben('open');
    tmAufgaben = tm.tasks;
    tmVollstaendig = tm.vollstaendig;
    tmRohantworten = tm.rohantworten;
  } catch (err) {
    console.error(`\nFEHLER beim Laden der TaskMarket-Daten: ${err.message}`);
    process.exit(1);
  }

  console.log(
    `  TaskMarket: ${tmAufgaben.length}${tmVollstaendig ? '' : ' (UNVOLLSTAENDIG)'} offene Aufgaben geladen.`
  );

  // ── AUSWERTUNG ──────────────────────────────────────────────────────────────
  const bbErg = werteBountyBookAus(bbJobs, bbVollstaendig, bbTotal);
  const tmErg = werteTaskMarketAus(tmAufgaben, tmVollstaendig);

  // ── BERICHT AUF STDOUT ──────────────────────────────────────────────────────
  druckeBountyBookBericht(bbErg);
  druckeTaskMarketBericht(tmErg);

  console.log('');
  console.log('═'.repeat(60));
  console.log(`  Verbrauchte HTTP-Anfragen: ${anfragenVerbraucht} / ${ANFRAGEN_LIMIT}`);
  if (!bbVollstaendig || !tmVollstaendig) {
    console.log('  HINWEIS: Mindestens eine Quelle ist UNVOLLSTAENDIG (Budget erschoepft).');
  }
  console.log('═'.repeat(60));

  // ── JSON-DATEI SCHREIBEN ────────────────────────────────────────────────────
  mkdirSync(AUSGABE_VERZEICHNIS, { recursive: true });

  // Zeitstempel einmalig festhalten — wird fuer Dateiname und metadaten.abgerufenAm verwendet
  const jetzt = new Date();
  const abgerufenAm = jetzt.toISOString();

  // Dateiname: YYYY-MM-DDTHH-MM-SSZ (Doppelpunkte durch Bindestriche, dateisystemtauglich)
  // Entspricht abgerufenAm mit ersetzten Doppelpunkten (Sekunden-Praezision, kein Millisekunden-Suffix)
  const dateiZeitstempel = abgerufenAm.slice(0, 19).replace(/:/g, '-') + 'Z';
  const ausgabePfad = resolve(AUSGABE_VERZEICHNIS, `${dateiZeitstempel}.json`);

  const ausgabe = {
    metadaten: {
      abgerufenAm,
      anfragenVerbraucht,
      anfragenLimit: ANFRAGEN_LIMIT,
      vollstaendig: bbVollstaendig && tmVollstaendig,
    },
    bountyBook: {
      vollstaendig: bbVollstaendig,
      gesamtLautApi: bbTotal,
      geladenGesamt: bbJobs.length,
      kennzahlen: bbErg,
      rohantworten: bbRohantworten,
    },
    taskMarket: {
      vollstaendig: tmVollstaendig,
      geladenGesamt: tmAufgaben.length,
      kennzahlen: tmErg,
      rohantworten: tmRohantworten,
    },
  };

  writeFileSync(ausgabePfad, JSON.stringify(ausgabe, null, 2), 'utf8');
  console.log('');
  console.log(`JSON-Ausgabe: ${ausgabePfad}`);

  // ── ZUSAMMENFASSUNG SCHREIBEN (optional) ────────────────────────────────────
  if (zusammenfassungPfad) {
    const bbK = bbErg;
    const tmK = tmErg;

    const zusammenfassung = {
      measuredAt: abgerufenAm,
      platforms: {
        bountybook: {
          source: BOUNTYBOOK_URL,
          complete: bbVollstaendig,
          totalTasksPerApi: bbTotal,
          tasksLoaded: bbJobs.length,
          openTasks: bbK.anzahlOffen,
          openBudgetSumUsdc: bbK.budgets.summe,
          confirmedPayouts: {
            count: bbK.ausgezahlt.anzahl,
            sumUsdc: bbK.ausgezahlt.summe,
          },
          distinctFunders: bbK.auftraggeber.anzahlVerschiedener,
          largestFunderShare: bbK.auftraggeber.anteil,
          medianOpenAgeDays: bbK.alter.medianAlterTage,
        },
        taskmarket: {
          source: TASKMARKET_URL,
          complete: tmVollstaendig,
          totalTasksPerApi: null,
          tasksLoaded: tmAufgaben.length,
          openTasks: tmK.anzahlOffen,
          openBudgetSumUsdc: tmK.budgets.summe,
          confirmedPayouts: null,
          distinctFunders: tmK.auftraggeber.anzahlVerschiedener,
          largestFunderShare: tmK.auftraggeber.anteil,
          medianOpenAgeDays: tmK.alter.medianAlterTage,
        },
      },
    };

    writeFileSync(zusammenfassungPfad, JSON.stringify(zusammenfassung, null, 2), 'utf8');
    console.log(`Zusammenfassung: ${zusammenfassungPfad}`);
  }
}

main().catch(err => {
  console.error('Fataler Fehler:', err);
  process.exit(1);
});
