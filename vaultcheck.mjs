#!/usr/bin/env node
/**
 * vaultmessung.mjs — misst Ein- und Auszahlungen des TaskMarket-Escrow-Vaults
 * direkt auf Base, ohne der Plattform irgendetwas zu glauben.
 *
 * Warum dieses Werkzeug existiert:
 * TaskMarket veroeffentlicht in seiner API **keinen Auszahlungs-Hash**. Der Status
 * "completed" ist eine reine Selbstauskunft. Der Vault liegt aber auf einer
 * oeffentlichen Kette — also ist die Auszahlung pruefbar, ohne dass jemand der
 * Plattform vertrauen muss (Regel 23).
 *
 * Gemessen wird der USDC-Fluss:
 *   rein  = Transfer(*, VAULT)   — Einzahlungen in den Escrow
 *   raus  = Transfer(VAULT, *)   — Auszahlungen an Worker (und Gebuehren)
 *
 * Kontrollen laufen VOR der ersten echten Abfrage:
 *   - ROT-TEST: ein erfundener Empfaenger muss 0 Logs liefern. Ein Knoten, der
 *     fuer jeden Filter etwas zurueckgibt, macht jede Bestaetigung wertlos.
 *   - POSITIVKONTROLLE: eine bekannte, von Hand geprueffte Einzahlung muss
 *     genau 1 Log liefern. Ein Filter, der nie etwas findet, meldet ebenfalls "0".
 * Faellt eine Kontrolle durch, endet der Lauf mit exit 2 und misst nichts.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUSGABE_VERZ = join(__dirname, 'data', 'vault');

const RPC = 'https://mainnet.base.org';
const USER_AGENT = 'ideenschmiede-vaultmessung/1.0 (+https://github.com/peppe1337)';

// Kanonisches USDC auf Base. Nicht raten — aus den Logs der Escrow-Transaktion
// 0x4faae2db…e296f abgelesen und gegen den Betrag im Feld `reward` geprueft.
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const VAULT_STANDARD = '0xddc6cc3e4d11c1f3527b867c7dad4ed9869c33f7';

// Der oeffentliche Base-Knoten begrenzt eth_getLogs auf 10.000 Bloecke.
// Selbst gemessen: groessere Spannen antworten mit -32614.
const FENSTER = 10000;
const ANFRAGEN_LIMIT = 460;
const PAUSE_MS = 400;

// Von Hand geprueffte Einzahlung — die Positivkontrolle. Requester 0x3c08…
// zahlt 2,00 USDC in den Vault, in derselben Transaktion, die TaskMarket als
// `escrowTxHash` der Aufgabe TSK-E7S4SFQ3 ausweist (status completed,
// netReward 1850000, Worker 0xc792…b01c).
const KONTROLLE = {
  block: 50333563,
  von: '0x3c0820e2dabd5feae1fd03b78079dee15c7f83d8',
  betrag: 2.0,
};

let anfragenVerbraucht = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (adr) => '0x' + '0'.repeat(24) + adr.toLowerCase().replace(/^0x/, '');
const adrAusTopic = (t) => '0x' + t.slice(26).toLowerCase();
const usdc = (hexDaten) => Number(BigInt(hexDaten)) / 1e6;
const hex = (n) => '0x' + n.toString(16);

async function rpc(methode, params) {
  if (anfragenVerbraucht >= ANFRAGEN_LIMIT) {
    throw new Error(`Anfragenlimit ${ANFRAGEN_LIMIT} erreicht — Messung bleibt unvollstaendig`);
  }
  anfragenVerbraucht++;
  const resp = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ jsonrpc: '2.0', id: anfragenVerbraucht, method: methode, params }),
  });
  if (resp.status === 403 || resp.status === 429) {
    console.error(`\nABBRUCH: HTTP ${resp.status} vom Knoten. Regel 12 — kein Weiterfragen.`);
    process.exit(9);
  }
  const j = await resp.json();
  // JSON-RPC meldet Fehler mit HTTP 200. Der Status allein beweist nichts.
  if (j.error) throw new Error(`RPC-Fehler ${methode}: ${JSON.stringify(j.error)}`);
  return j.result;
}

/** Holt Transfer-Logs in 10.000er-Fenstern. `von`/`nach` sind Adressen oder null. */
async function logsHolen(vonAdr, nachAdr, startBlock, endBlock) {
  const topics = [
    TRANSFER_SIG,
    vonAdr ? pad(vonAdr) : null,
    nachAdr ? pad(nachAdr) : null,
  ];
  // Nachlaufende null-Topics weglassen — manche Knoten mögen sie nicht.
  while (topics.length > 1 && topics[topics.length - 1] === null) topics.pop();

  // Teilergebnisse gehen NICHT verloren, wenn der Knoten mittendrin aussteigt.
  // Sonst meldet ein Abbruch bei Fenster 181 von 210 eine glatte 0 — und eine 0,
  // die nichts gemessen hat, ist der Fehler, den dieses Haus am haeufigsten macht.
  const alle = [];
  let bisBlock = startBlock - 1;
  try {
    for (let b = startBlock; b <= endBlock; b += FENSTER) {
      const bis = Math.min(b + FENSTER - 1, endBlock);
      const teil = await rpc('eth_getLogs', [
        { address: USDC, topics, fromBlock: hex(b), toBlock: hex(bis) },
      ]);
      alle.push(...teil);
      bisBlock = bis;
      if (bis < endBlock) await sleep(PAUSE_MS);
    }
  } catch (e) {
    alle.abbruch = { grund: e.message, gemessenBisBlock: bisBlock };
    return alle;
  }
  return alle;
}

// ————————————————————————————————————————————————————————————————
// Aggregation — getrennt vom Netz, damit der Selbsttest sie ohne HTTP prueft
// ————————————————————————————————————————————————————————————————

export function auswerten(logsRein, logsRaus) {
  const summe = (ls) => ls.reduce((s, l) => s + usdc(l.data), 0);
  const empfaenger = new Map();
  for (const l of logsRaus) {
    const a = adrAusTopic(l.topics[2]);
    empfaenger.set(a, (empfaenger.get(a) || 0) + usdc(l.data));
  }
  const einzahler = new Map();
  for (const l of logsRein) {
    const a = adrAusTopic(l.topics[1]);
    einzahler.set(a, (einzahler.get(a) || 0) + usdc(l.data));
  }
  const betraege = {};
  for (const l of logsRaus) {
    // NICHT toFixed(2): das machte aus 0,925 USDC eine "0.93" und damit aus einem
    // Messwert eine Anzeige. Volle Praezision, nachlaufende Nullen weg.
    const k = String(Number(usdc(l.data).toFixed(6)));
    betraege[k] = (betraege[k] || 0) + 1;
  }
  const rein = summe(logsRein);
  const raus = summe(logsRaus);
  return {
    anzahlRein: logsRein.length,
    anzahlRaus: logsRaus.length,
    summeRein: Number(rein.toFixed(6)),
    summeRaus: Number(raus.toFixed(6)),
    differenz: Number((rein - raus).toFixed(6)),
    verschiedeneEmpfaenger: empfaenger.size,
    verschiedeneEinzahler: einzahler.size,
    betragsverteilung: Object.fromEntries(
      Object.entries(betraege).sort((a, b) => b[1] - a[1])
    ),
    empfaenger: Object.fromEntries(
      [...empfaenger].map(([a, v]) => [a, Number(v.toFixed(6))])
    ),
  };
}

// ————————————————————————————————————————————————————————————————
// Selbsttest — netzfrei, mit handgerechneten Sollwerten
// ————————————————————————————————————————————————————————————————

function log(vonA, nachA, betragUsdc) {
  return {
    topics: [TRANSFER_SIG, pad(vonA), pad(nachA)],
    data: '0x' + BigInt(Math.round(betragUsdc * 1e6)).toString(16),
  };
}

function selbsttest() {
  const A = '0x1111111111111111111111111111111111111111';
  const B = '0x2222222222222222222222222222222222222222';
  const V = VAULT_STANDARD;
  const rein = [log(A, V, 2.0), log(B, V, 1.0), log(A, V, 0.5)];   // 3,50 rein, 2 Einzahler
  const raus = [log(V, A, 1.85), log(V, B, 0.15), log(V, A, 1.85)]; // 3,85 raus, 2 Empfaenger

  const e = auswerten(rein, raus);
  const soll = {
    anzahlRein: 3, anzahlRaus: 3,
    summeRein: 3.5, summeRaus: 3.85,
    differenz: -0.35,
    verschiedeneEmpfaenger: 2, verschiedeneEinzahler: 2,
  };
  const fehler = [];
  for (const [k, v] of Object.entries(soll)) {
    if (e[k] !== v) fehler.push(`${k}: erwartet ${v}, bekommen ${e[k]}`);
  }
  // Adressweise Summe: A muss 3,70 bekommen haben (2 × 1,85)
  if (e.empfaenger[A.toLowerCase()] !== 3.7) {
    fehler.push(`empfaenger[A]: erwartet 3.7, bekommen ${e.empfaenger[A.toLowerCase()]}`);
  }
  if (e.betragsverteilung['1.85'] !== 2) {
    fehler.push(`betragsverteilung['1.85']: erwartet 2, bekommen ${e.betragsverteilung['1.85']}`);
  }

  if (fehler.length) {
    console.error('SELBSTTEST DURCHGEFALLEN:');
    fehler.forEach((f) => console.error('  - ' + f));
    process.exit(2);
  }
  console.log('Selbsttest bestanden (netzfrei, 0 HTTP-Anfragen).');
  console.log(`  ${anfragenVerbraucht} Anfragen verbraucht — muss 0 sein.`);
  if (anfragenVerbraucht !== 0) {
    console.error('FEHLER: Der Selbsttest hat Netzverkehr erzeugt.');
    process.exit(2);
  }
  process.exit(0);
}

// ————————————————————————————————————————————————————————————————
// Kontrollen gegen die echte Kette — laufen VOR jeder Messung
// ————————————————————————————————————————————————————————————————

async function kontrollen(vault) {
  // ROT-TEST: erfundener Empfaenger, echtes Fenster. Muss 0 liefern.
  const erfunden = '0xdeadbeef00000000000000000000000000000001';
  const rot = await logsHolen(vault, erfunden, KONTROLLE.block, KONTROLLE.block + FENSTER - 1);
  if (rot.length !== 0) {
    console.error(`ROT-TEST DURCHGEFALLEN: erfundener Empfaenger lieferte ${rot.length} Logs.`);
    console.error('Ein Knoten, der fuer jeden Filter etwas zurueckgibt, macht jede Bestaetigung wertlos.');
    process.exit(2);
  }
  await sleep(PAUSE_MS);

  // POSITIVKONTROLLE: bekannte Einzahlung muss genau 1 Log mit genau 2,00 USDC liefern.
  const pos = await logsHolen(KONTROLLE.von, vault, KONTROLLE.block, KONTROLLE.block + 1);
  if (pos.length !== 1) {
    console.error(`POSITIVKONTROLLE DURCHGEFALLEN: erwartet 1 Log, bekommen ${pos.length}.`);
    console.error('Ein Filter, der nie etwas findet, meldet ebenfalls "0" — und das waere keine Messung.');
    process.exit(2);
  }
  const betrag = usdc(pos[0].data);
  if (Math.abs(betrag - KONTROLLE.betrag) > 1e-9) {
    console.error(`POSITIVKONTROLLE DURCHGEFALLEN: erwartet ${KONTROLLE.betrag} USDC, bekommen ${betrag}.`);
    process.exit(2);
  }
  console.log(`Kontrollen bestanden: Rot-Test 0 Logs, Positivkontrolle 1 Log ueber ${betrag.toFixed(2)} USDC.`);
  await sleep(PAUSE_MS);
}

// ————————————————————————————————————————————————————————————————

function argumentePruefen(argv) {
  const bekannt = new Set(['--selbsttest', '--selftest', '--bloecke', '--vault', '--nur-raus']);
  const opt = { bloecke: 60000, vault: VAULT_STANDARD, selbsttest: false, nurRaus: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!bekannt.has(a)) {
      console.error(`Unbekanntes Argument: ${a}`);
      console.error('Erlaubt: --selbsttest | --bloecke <n> | --vault <0x…> | --nur-raus');
      process.exit(3);
    }
    if (a === '--selbsttest' || a === '--selftest') opt.selbsttest = true;
    if (a === '--nur-raus') opt.nurRaus = true;
    if (a === '--bloecke') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1 || v > 2500000) {
        console.error('--bloecke braucht eine ganze Zahl zwischen 1 und 2500000.');
        process.exit(3);
      }
      opt.bloecke = v;
    }
    if (a === '--vault') {
      const v = argv[++i];
      if (!/^0x[0-9a-fA-F]{40}$/.test(v || '')) {
        console.error('--vault braucht eine 20-Byte-Adresse in Hex.');
        process.exit(3);
      }
      opt.vault = v.toLowerCase();
    }
  }
  return opt;
}

async function main() {
  // Argumentpruefung VOR der ersten HTTP-Anfrage (Regel 29).
  const opt = argumentePruefen(process.argv.slice(2));
  if (opt.selbsttest) selbsttest();

  const vault = opt.vault;
  console.log(`Vault: ${vault}`);
  console.log(`Token: USDC ${USDC} auf Base\n`);

  await kontrollen(vault);

  // Guthaben mitschreiben: ohne diesen Wert ist die Bilanz spaeter offline
  // nicht nachrechenbar, und eine Zahl, die nur im Protokolltext steht, ist keine Messung.
  const guthabenRoh = await rpc('eth_call', [
    { to: USDC, data: '0x70a08231' + '0'.repeat(24) + vault.replace(/^0x/, '') }, 'latest',
  ]);
  const guthaben = Number(BigInt(guthabenRoh)) / 1e6;
  console.log(`Vault-Guthaben (balanceOf): ${guthaben.toFixed(6)} USDC\n`);
  await sleep(PAUSE_MS);

  const letzterBlock = parseInt(await rpc('eth_blockNumber', []), 16);
  const startBlock = letzterBlock - opt.bloecke + 1;
  console.log(`Fenster: Block ${startBlock} bis ${letzterBlock} (${opt.bloecke} Bloecke)\n`);

  let vollstaendig = true;
  let abbruch = null;
  let logsRaus = [], logsRein = [];
  logsRaus = await logsHolen(vault, null, startBlock, letzterBlock);
  if (logsRaus.abbruch) { vollstaendig = false; abbruch = logsRaus.abbruch; }
  if (!opt.nurRaus && vollstaendig) {
    await sleep(PAUSE_MS);
    logsRein = await logsHolen(null, vault, startBlock, letzterBlock);
    if (logsRein.abbruch) { vollstaendig = false; abbruch = logsRein.abbruch; }
  }
  if (abbruch) {
    // Eine 0 muss von einem Fehlschlag unterscheidbar sein.
    console.error(`\nMESSUNG UNVOLLSTAENDIG — ${abbruch.grund}`);
    console.error(`Vollstaendig gemessen nur bis Block ${abbruch.gemessenBisBlock}. `
      + `Teilergebnisse bleiben erhalten und sind als Untergrenze gekennzeichnet.`);
  }

  const e = auswerten(logsRein, logsRaus);
  const p = vollstaendig ? '' : 'mindestens ';

  console.log('════════════════════════════════════════════════════════════');
  console.log('  TaskMarket-Escrow-Vault auf Base — gemessen, nicht geglaubt');
  console.log('────────────────────────────────────────────────────────────');
  if (!vollstaendig) console.log('  ⚠ UNVOLLSTAENDIG — jede Zahl ist eine Untergrenze\n');
  console.log(`  Einzahlungen (Escrow):   ${opt.nurRaus ? 'NICHT GEMESSEN (--nur-raus)' : `${p}${e.anzahlRein} über ${p}${e.summeRein.toFixed(2)} USDC`}`);
  console.log(`  Auszahlungen:            ${p}${e.anzahlRaus} über ${p}${e.summeRaus.toFixed(2)} USDC`);
  console.log(`  Differenz (rein − raus): ${opt.nurRaus ? 'NICHT BERECHENBAR (--nur-raus)' : e.differenz.toFixed(2) + ' USDC — im Vault gebunden'}`);
  console.log(`  verschiedene Einzahler:  ${opt.nurRaus ? 'NICHT GEMESSEN' : e.verschiedeneEinzahler}`);
  console.log(`  verschiedene Empfaenger: ${e.verschiedeneEmpfaenger}`);
  console.log('\n  Betragsverteilung der Auszahlungen (USDC → Anzahl):');
  for (const [b, n] of Object.entries(e.betragsverteilung)) {
    console.log(`    ${b.padStart(8)} × ${n}`);
  }
  console.log(`\n  Anfragen verbraucht: ${anfragenVerbraucht}/${ANFRAGEN_LIMIT}`);
  console.log('════════════════════════════════════════════════════════════');

  mkdirSync(AUSGABE_VERZ, { recursive: true });
  // Auf die Sekunde benennen — nach Datum benannt loescht der zweite Lauf den ersten (Regel 31).
  const stempel = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const pfad = join(AUSGABE_VERZ, `${stempel}.json`);
  writeFileSync(pfad, JSON.stringify({
    metadaten: {
      abgerufenAm: new Date().toISOString(),
      vault, token: USDC, kette: 'base-mainnet', guthabenUsdc: guthaben,
      startBlock, endBlock: letzterBlock, bloecke: opt.bloecke,
      anfragenVerbraucht, vollstaendig, abbruch,
      kontrollen: 'rot-test 0 logs, positivkontrolle 1 log / 2.00 USDC — beide bestanden',
    },
    kennzahlen: opt.nurRaus
      ? { ...e, anzahlRein: null, summeRein: null, differenz: null, verschiedeneEinzahler: null,
          hinweis: 'Nur die Auszahlungsrichtung gemessen (--nur-raus). Einzahlungswerte sind NICHT 0, sondern nicht erhoben.' }
      : e,
    logsRaus, logsRein,
  }, null, 2));
  console.log(`\nJSON-Ausgabe: ${pfad}`);
  if (!vollstaendig) process.exit(1);
}

main().catch((e) => { console.error('\nFEHLER:', e.message); process.exit(1); });
