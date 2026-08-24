# Agent Payout Ledger

**What AI agent marketplaces actually pay out — measured, dated, and reproducible.**

Report: <https://peppe1337.github.io/agent-payout-ledger/>

Platform landing pages advertise open tasks and total volume. Neither tells you whether an
agent that does the work gets paid. This repository measures that from public APIs, checks
the payouts against the chain, and publishes the raw data so you can check the arithmetic.

## Headline findings (2026-08-24)

**BountyBook** — full census of all 204 tasks ever posted:

| | |
|---|---|
| Total actually paid out, lifetime | **74.22 USDC** |
| Confirmed payouts | 36 — of which **22 were exactly 0.01 USDC** |
| Payout attempts recorded as **failed** | **38**, worth 229.50 USDC |
| Share of payout attempts that failed | **51 %** |
| Tasks where work was accepted (`verified`) | 53 — **25 of those payouts failed** |
| Still open | 115, median age **158 days** |
| Most recent payout of any size | 2026-08-24 00:14 UTC, **0.01 USDC** |

The three largest confirmed payouts (18, 15, 12 USDC) all settled on 2026-03-17 within 13
minutes of each other. Everything since has been sub-dollar.

**Daydreams TaskMarket** — full census of all 242 tasks. 174 completed, 881.10 USDC paid to
workers (per-task net reward). Payouts are **measured against the chain**, not against the API:
the platform publishes no payout hash, so `vaultcheck.mjs` reads USDC transfer logs directly
from the Base vault (`0xddc6cc3e4d11c1f3527b867c7dad4ed9869c33f7`). Key finding: 47 tasks
sit in `awaiting_settlement` with no award and an `expiryTime` in the past, holding 388.18 USDC
— 48.8 % of the vault balance.

## Reproduce it

```sh
node measure.mjs --selftest          # 0 HTTP requests — checks the aggregation maths
node measure.mjs                     # ~4 requests — prints the full report
node measure.mjs --summary out.json  # also writes the machine-readable summary
```

Requires Node 18+ (uses global `fetch`). No dependencies, no API key, no account.

The script paginates until the number of records it holds matches the API's own `total`
field, prints a sample size next to every derived number, waits 1500 ms between requests,
sends an honest user agent, and aborts on HTTP 403 or 429.

`--selftest` runs the aggregation functions against hand-computed expected values and makes
no network requests at all. It has been verified to fail: breaking an aggregation function on
purpose makes it exit non-zero.

## What is in here

| Path | Contents |
|---|---|
| `index.html` | The published report |
| `measure.mjs` | The measurement script (BountyBook, paginated API) |
| `vaultcheck.mjs` | TaskMarket vault measurement — reads USDC transfer logs on Base |
| `data/latest.json` | Machine-readable summary of the most recent run (**English field names**) |
| `data/*.json` | One file per measurement run, timestamped, never overwritten |
| `data/vault/*.json` | One file per `vaultcheck.mjs` run |
| `data/taskmarket-zensus-*.json` | TaskMarket task census, one file per run |

### `data/latest.json` field reference

```jsonc
{
  "measuredAt": "ISO 8601 UTC timestamp of the run",
  "platforms": {
    "<platform>": {
      "source":             "the API endpoint actually queried",
      "complete":           "true if pagination reached the API's own total",
      "totalTasksPerApi":   "the API's own total, or null if it exposes none",
      "tasksLoaded":        "records actually retrieved",
      "openTasks":          "records in an open state",
      "openBudgetSumUsdc":  "sum of advertised budgets on open tasks",
      "confirmedPayouts":   { "count": 0, "sumUsdc": 0 },  // null if not measured
      "distinctFunders":    "distinct funding addresses across open tasks",
      "largestFunderShare": "0..1, share of open tasks from the single largest funder",
      "medianOpenAgeDays":  "median age of the open task pool"
    }
  }
}
```

`null` means *not measured*. It never means zero.

**Note on the per-run files:** `measure.mjs` was written in German and its console output and
raw JSON keys are German (`anzahlOffen` = open count, `ausgezahlt` = paid out, `kennzahlen` =
metrics). `data/latest.json` is the English-keyed surface and is the one to build on. This is
a wart, not a design; it is documented rather than hidden.

## What this measures, and what it does not

- **Two platforms, not the market.** A public directory lists 46 agent-earning platforms.
  This measures 2.
- **`payout_status` is the platform's field,** reported unchanged. All 36 confirmed payouts
  carry a transaction hash; none of the 38 failed ones does. Seven of the 36 hashes were sampled
  against a public Base RPC node and all seven exist with `status = 0x1`. The same check against
  an invented hash returns `null`, which is how the check is known to work. On the two payouts
  that were dated on-chain, the block timestamp agreed with the platform's own `updated_at`
  field to within four seconds.
- **No claim is made about *why* payouts failed.** Recipient wallet, reverted transfer,
  expired claim and platform-internal causes are all consistent with the data. No wrongdoing
  by any operator is alleged or implied.
- **Not investment, legal or tax advice.**

## Requests and corrections

Open an issue:

- **A platform you want measured** — added in the order requested.
- **A number you think is wrong** — point at the record in `data/`. Corrections are made
  visibly rather than by overwriting.

## Licence

Data CC0. Code MIT.
