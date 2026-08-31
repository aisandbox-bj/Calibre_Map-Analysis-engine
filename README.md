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

## Phase 5 — one canonical dataset (the shared contract)
`engine.assembleCanonical()` formalizes everything into ONE versioned JSON (`schemaVersion 1.0.0`) the engine emits, `build_app.py` packages, and the desktop viewer reads:
`meta` · `counts` · `materials[]` (incl. where-used detail + disposition status + **category/fits**) · `families[]` (field verdicts + members) · **`fleet[]`** (unit → type/make/model/year/engine) · `verification[]` · `duplicate_disposition[]` · `scoreboard{}` · `needs_identification[]` (consumed materials absent from the master — candidates for the assessment tool). Export = `calibre_map_dataset_<date>.json`.

## v0.7 — 11th category, harvested rules, assessment overlay (`engine.js` 0.7.1)
- **11th system category "Cab & body"** — a home for cab/body glass, hood & body panels, and
  cab/safety equipment that fit no vehicle system. `classifyCategory` gained 3 evidence-driven
  harvest rounds (clutch, s-cam, rocker arm, air spring, oil/fuel, control module, bulb, leaf
  spring/u-bolt, camshaft, water pump, cooler, pitman/drag link, air valves, …). Golden **1428/1428**.
- **Confidence + auto-queue** — `classifyCategory` returns `{category, confidence, reason}`;
  `high`→bucket, `low`→impact-sorted review queue (`category_review[]`), `none`→"Unclassified" bucket.
- **Assessment overlay** — `applyAssessment(materials, rows)` folds the initial-assessment harness's
  web-consensus category **upgrades** onto the SAP-desc audit result. `assembleCanonical` applies
  `dataset.assessment` as an input re-applied every derive, so **upgrades persist across re-audits**.
  Precedence: analyst correction > web assessment > SAP-desc audit.
- **One classifier, two callers** — the rules live only here; the harness calls the same
  `classifyCategory` through a Node bridge (`classify_bridge.js`), so a rule fix has zero drift.

## v0.6 — fleet allocation + corrections (`engine.js` 0.6.0)
- **`fleet[]`** — an optional **Fleet register** input (`fleet_register_enriched.csv` shape) is read into per-unit attributes (`buildFleet()`), so the viewer and app can drill unit → system → parts.
- **Category & fits on every part** — `enrich()` also sets `category` (the system-zone key) and `fits`. Category comes from a master column **only if it names a real system category**, otherwise it is keyword-classified from the description (`categoryFor()` — the same rules as the field app's `act_cat`), so coverage matches the app.
- All additive: the Phase-1/2 golden self-check still passes **1428 / 1428 exactly**.

## The tools — one app shell
Both HTML tools now share the **Calibre Map field-app design language** (green brand chrome, per-mode accents, `goHome`/`goBack` screen nav) so the engine, viewer, and on-device app feel like one environment.
- **`index.html` — Analysis Engine.** Five-tile home: **Load & Derive · Consumption · Duplicates & Scoreboard · Dataset & Export · Query Inbox**. *Query Inbox* — field flags on wrong allocations arrive here with the capture bundles; the analyst **corrects an allocation once** in the canonical dataset (logged in `corrections[]`) and it flows to every surface.
- **`viewer.html` — Viewer.** Read-only, self-contained single file; remembers the last dataset in the browser. Four tiles: **Parts Mapping · Duplicate Families · Fleet & Units · Data & Settings**. *Fleet & Units* ports the app's drill verbatim — **unit → system zone → sub-system → make-matched parts**, plus "parts actually consumed here".

## Files
| File | Role |
|---|---|
| `index.html` | The **engine** — load SAP files, derive, export the canonical JSON |
| `viewer.html` | The **desktop/tablet viewer** — load a `calibre_map_dataset_*.json` → Parts Mapping (find a part / start from a unit + fleet drill), Duplicate Families, Fleet & Units, Data & Settings. Read-only, self-contained, remembers the dataset in the browser. Same file serves laptop and tablet. |
| `engine.js` | Framework-free core derivations (runs in Node and browser) — the single source of truth for the math |
| `numacore_lib.js` | Shared NumaCore helpers (dates, category vocabulary, formatting) |
| `vendor/xlsx.full.min.js` | SheetJS (vendored — offline, no CDN) |

## Roadmap (see the design doc in the Calibre Map repo)
**Done:** Phases 1–5 (consumption · enrichment · verification merge · removal scoreboard · canonical dataset) · **the Viewer** · **app-shell transposition** of engine + viewer · **fleet-allocation drill** (fleet[] + category) · **Query Inbox / edit-allocation** · **11-category classifier + confidence/auto-queue** (0.7.0) · **assessment overlay** so harness web-upgrades persist across re-audits and reach the viewer + app (0.7.1). **Next:** field-app "Cab & body" zone + APK rebuild · app-side allocation *flag* control (feeds the inbox) · PR→PO history input · captures→traced-register feedback. See `Record of Change.md` for the full log.

## Data governance
This repo is **tool code only**. `.gitignore` blocks every data format (`*.xlsx`, `*.csv`, `*.json`, `*.pdf`). Client data is loaded client-side and the derived JSON is downloaded to your machine — it never touches the repo. Same model as the public Calibre Trend / Trace tools.
