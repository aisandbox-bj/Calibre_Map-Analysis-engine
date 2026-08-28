# Calibre Map — Analysis Engine

A **public, client-side, deterministic** browser tool that keeps the Calibre Map dataset current: it folds fresh transactional/master data (and, later, field-verification input) into the canonical JSON and re-derives everything that can be computed. It does **data management**, not part **identity** — identity/research lives in the separate private assessment tool.

**Runs entirely in your browser. Nothing is uploaded.** Load client extracts locally, derive, and download the JSON. No server, no keys, no client data ever committed here.

## Use it
Open `index.html` (double-click, or serve the folder / GitHub Pages), then:
1. Load **MB51** (WO consumption extract) and **IW39** (work-order list) — required.
2. Optionally load **INV MSTR** (on-hand, MRP type, ROP, Max) and the **traced/master register** (description, brand, duplicate group) to enrich; a **fleet register** for the consuming-group roll-up; exported **field capture bundles** (`.json`, multiple) to fold in technician verdicts; and the committed **`consumption_by_unit.csv`** to self-check.
3. **Run derivation** → review the table → **Export JSON**.

Move the exported JSON to the device by USB.

## Phase 1 — what it derives (validated)
- **Where-used**: MB51 `261/262` WO consumption joined to IW39 (`Order → Sort Field` = unit).
- **Net consumed** per material = the **material-level net of MB51 261/262 flipped quantities** (`261` posts negative → flipped positive; `262` reversals subtract). Materials with **net > 0** are included.
- Self-check: diffs against the committed `consumption_by_unit.csv` — **1428 / 1428 golden materials match exactly** (validated in Node against the campaign's golden output; the browser uses the same `engine.js`).

## Phase 2 — enrichment (validated)
Joins **INV MSTR** (`OnHand`, `MRP Type`, `Reorder Point`→ROP, `Maximum Stock Level`→Max) and the **traced register** (`Trace brand`, `Group label`→duplicate group) onto each material — reproducing the full `consumption_by_unit.csv` columns. Self-check: all eight enriched columns (Description, PN, OnHand, MRP Type, ROP, Max, Traced brand, Duplicate group) match the golden **1428 / 1428 exactly**.

## Phase 3 — verification merge (field → dataset)
Folds the app's exported **capture bundles** back in. Each duplicate-family capture sorts members into piles, from which the **verdict is derived** (one pile = SAME · one pile per member = all-different · otherwise SPLIT), along with the **keep/retire** per pile, the "no technical preference" flag, site-question answers, notes and QoH corrections. Emits `verification[]` and annotates families with the field verdict. Verified on a real exported bundle (2 families → SAME + SPLIT, keep/retire correct).

## Phase 4 — removal scoreboard (`duplicate_disposition`)
Turns the field keep/retire decisions into the elimination KPI. Each **retired** SKU is classified from consumption + on-hand:
- **eliminated** — on-hand 0: already gone from stock
- **running-down** 🟢 — on-hand > 0, no consumption in period: depletes cleanly
- **reorder-on-retire** 🔴 — still consumed: only retire once demand moves to the keep SKU

Rolls up **% eliminated**, counts per state, and the on-hand units tied in retired numbers. Emits `duplicate_disposition[]` + `scoreboard{}`. (Needs INV MSTR loaded for on-hand.)

## Files
| File | Role |
|---|---|
| `index.html` | The tool — UI, file loading, rendering, export |
| `engine.js` | Framework-free core derivations (runs in Node and browser) — the single source of truth for the math |
| `numacore_lib.js` | Shared NumaCore helpers (dates, category vocabulary, formatting) |
| `vendor/xlsx.full.min.js` | SheetJS (vendored — offline, no CDN) |

## Roadmap (see the design doc in the Calibre Map repo)
**Done:** Phase 1 consumption · Phase 2 enrichment · Phase 3 verification merge · Phase 4 removal scoreboard. **Next:** canonical JSON out (one dataset the app + viewer read) · quick-identify triage for new parts.

## Data governance
This repo is **tool code only**. `.gitignore` blocks every data format (`*.xlsx`, `*.csv`, `*.json`, `*.pdf`). Client data is loaded client-side and the derived JSON is downloaded to your machine — it never touches the repo. Same model as the public Calibre Trend / Trace tools.
