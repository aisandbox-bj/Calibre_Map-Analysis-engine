# Record of Change — Calibre Map Analysis Engine + Viewer

Reverse-chronological. Each entry: what changed, why, and how to roll back. `engine.js` is the validated deterministic core — every change re-runs the golden self-check (**1428 / 1428 exact**).

---

## 2026-08-31 · Viewer part detail — "Where used & likely fit" (parity with the app's fits-map)

**Why.** After the UI pass the operator flagged two losses on the **viewer** (the app was verified
intact — full drill + "What does this fit?" bar both present): (1) the where-used list had been
**collapsed** by the new accordion, and (2) the viewer never had the app's **likely-fit** view.

**Changed (`viewer.html`, `partView`).** The where-used section became **"Where used & likely fit"**:
- **Observed** units (from `where_used`, WO-confirmed) render **visible by default** (green left-border),
  each foldable to its WO cards (description-first). No longer hidden behind a click.
- **Likely-fit candidates** — every fleet unit of the **same make/model** (`vFleetGroup`) as the units
  where the part was actually issued, minus the observed ones, grouped by make/model as chips. This is
  the WO-grounded "association" the app's fits-map shows, now in the viewer.

**Verify.** Loaded the real canonical: `partView` renders the observed list visible + 28 likely-fit
candidate chips, no JS errors. The Fleet & Units drill (unit→system→sub-system→part) was re-confirmed
usable (7 systems → 8 sub-systems → 27 parts). `engine.js` untouched.

---

## 2026-08-31 · UI review pass — `viewer.html` (mirrors the field app)

**Why.** Operator UI review (deck `App/2026_08_31 UI review/`) — a consistent hierarchy across
both surfaces (human-readable **description primary/white on top**; identifiers SAP/VPN/WO#/qty
secondary grey+blue below) plus a real correctness fix to the unit-drill part counts.

**Changed (`viewer.html`; the field app `app_template.html` is the design owner, changed in lockstep):**
- **Unit-scoped counts** — new `partsForUnit(uid,cats,kw)` (+ `vRelevant`/`vFleetGroup`): a part counts
  for a unit only if it was consumed on it (`where_used`) or on a same make/model unit ("similar units").
  `unitView`/`zoneView`/`compView` use it — counts drop from whole-category totals to real per-unit numbers
  (e.g. Engine bay 461→184), and the parts list matches the count.
- **Make/model inline** with the unit number in the unit hero.
- **Part rows** lead with the description (white); SAP# (grey) · VPN (blue) below. Same for the
  consumed-parts list.
- **Part-detail hero** = description + brand (blue); SAP/VPN stay in the Identity box.
- **Where-used** — each unit row expands its WOs inline (accordion, hidden by default); WO cards lead
  with the **WO description** (white), WO no · date (grey) · qty (blue) below.

**Verify.** Loaded the real canonical in the viewer: 1428 materials, no JS errors, counts scoped
(Engine bay 461→184), make/model inline, detail hero = description, where-used accordion hidden-by-default.
`engine.js` untouched — golden unaffected. Shipped in the field app as **V4.3.6**.

---

## 2026-08-30 · Assessment overlay — upgrades persist across re-derives & flow to the app — `engine.js` **0.7.1**

**Why (operator: "will the upgrades pull through to the viewer AND the app — now and on re-audit?").**
The initial-assessment harness produces web-consensus category **upgrades** (the 47%→77% lift), but
`assembleCanonical` emitted **SAP-desc audit categories only** — so a plain re-derive dropped back to
the audit numbers and the app (which re-derived its own `act_cat`) never saw the upgrades. This closes
the "correct once, propagate everywhere" gap so the merge is a real pipeline stage, not a one-off script.

**Changed.**
- `engine.js` (additive): **`applyAssessment(materials, rows)`** folds the harness's per-material
  category upgrades onto the audit result. Precedence: analyst correction (`analyst-confirmed`, manual)
  > assessment (web consensus, by confidence rank) > SAP-desc audit. `assembleCanonical` applies
  `dataset.assessment` before building `category_review`, so the overlay is an **input re-applied every
  derive** — upgrades PERSIST across re-audits (they are never overwritten by the SAP-desc pass).
  Rows accept `{material, category, category_confidence[, category_reason]}` or the harness export shape
  `{material, identity:{category, confidence}}`. Exported `applyAssessment`. Versions → `0.7.1`.
- `build_app.py` (Type-B consumer): a new pass overlays each part's `cat` from the engine's canonical
  (`Analysis/calibre_map_dataset_P1120.json`) — the **single source of truth** (system-zone category +
  Cab & body + web upgrades). The local `ACT_CATS`/`act_cat` is now a **fallback only** for materials
  absent from the canonical. This is what makes upgrades reach the field app.

**Verify.** Golden **1428/1428 EXACT**. Re-derive with the P1120 assessment overlay (650 rows) →
**high 1100 · low 30 · Unclassified 298** (the 77% picture PRESERVED, not the 778 audit number) —
proving persistence. `build_app.py` compiles; overlay maps all 1428 canonical categories (Cab & body 71).
Canonical re-filed to `Analysis/calibre_map_dataset_P1120.json` (viewer reads it directly).

**Field-app propagation DONE (2026-08-31, app V4.3.5).** "Cab & body" added to the tractor Cab zone +
trailer Deck zone (each with a "Body, glass & hardware" sub-system) in `app_template.html` (owner) +
`viewer.html` (mirror); `build_app.py` overlays category from the canonical (653 parts recategorised);
signed keyless field APK rebuilt (`Calibre Map V4.3.5 (keyless - field).apk`, CONTENT_VERSION 8).
**Open.** Harness `/api/export` is the production source for `dataset.assessment` (this run used a file
generated from the validated consensus).

---

## 2026-08-30 · 11th category "Cab & body" + harvested part-type rules — `engine.js` **0.7.0**

**Why (Type D vocabulary + additive classifier rules, via `calibre-map-change-management`).** The
P1120 dual-classification validation showed two ceilings on classification: (1) parts the web
cleanly identifies but the keyword nets miss (clutch, s-cam, rocker arm, air spring, oil fill/pump,
fuel conditioner, control module), and (2) cab/body/glass/hardware parts (windshield, mirror, hood,
seat, screws) that fit **no** vehicle system — with only 10 buckets they had no home and stayed
Unclassified. Operator approved adding an **11th category "Cab & body"** and folding the harvested
rules into the deterministic classifier.

**Changed (`engine.js`, additive).** `PRIORITY_CATS` gains harvested disambiguations (all `high`):
air/dash/emergency/height-control valves → Air; control module/CECU/ECU → Lighting; fuel
conditioner/return/splitter, rocker arm, oil fill/pump → Engine; S-cam → Brakes; CLUTCH → Driveline
(appended AFTER the existing FAN CLUTCH→Engine rule, so fan clutches are still protected). `ACT_CATS`:
`AIR BAG`/`BAG, AIR` added to Suspension, `COOLANT` added to Engine, and a new **"Cab & body"** net
placed LAST (windshield/glass/mirror/hood/fender/grille/bumper/door/latch/hinge/visor/seat/window/
crossmember/extinguisher + generic SCREW) — deliberately CONSERVATIVE: cross-system words (HOSE, BOLT,
BRACKET, FITTING, VALVE) are NOT in it, so a coolant/steering hose or spring U-bolt won't wrongly land
in body — those stay `none` and the web layer resolves them. `CAT_SET` auto-derives the 11th from
`ACT_CATS`. Versions → `0.7.0`.

**Verify / result.** Golden self-check **1428/1428 EXACT** (category is enrichment, not consumption —
classifier changes cannot regress it). Spot-checks confirm no regressions (FAN CLUTCH→Engine, SHOE
BRAKE→Brakes, SENSOR SPEED→Driveline-low all unchanged) and the SAP typo WINSHIELD→Cab & body. P1120
fleet **SAP-desc-only** distribution: high **669→778** (47%→54.5%) · Unclassified **604→487**; new
Cab & body bucket = 65 (clean — mirrors, windshields, hood latches, window regulators, seats, screws).
This is BEFORE web enrichment; the dual-classification harness adds consensus on top.

Rules were added in **3 evidence-driven harvest rounds** from the live P1120/P1130 validation runs:
r1 (clutch, s-cam, rocker arm, air spring, oil fill/pump, fuel conditioner, control module, air valves);
r2 (BULB, leaf spring/shackle/u-bolt, relay/quick-release/air-line valve, backup alarm, fuel cap/pump/line);
r3 (camshaft, water pump, pulley, cooler, crankshaft, pitman/drag link, axle seal, relief/protection/dash valve).
Cross-system words (HOSE, BOLT, BRACKET, FITTING, generic VALVE) were deliberately kept OUT of the
Cab & body net so system-specific parts (coolant hose, spring U-bolt) don't wrongly land in body.

**Full dual-classification consensus validation (web enrichment on the non-high tail, 2026-08-30):**
- **P1120 (1428):** high **669→1100 (47%→77%)** · Unclassified 604→298 · review queue 155→30. Tail web-ID 81%; low→high 83%.
- **P1130 ANC (2151):** high **816→1350 (38%→63%)** · Unclassified 1139→736. Tail web-ID 69%; low→high 74%.
Residual Unclassified is mostly correct-to-be (generic seals/fasteners; P1130 also shop tools/PPE/consumables).
Deliverables: `P1120_final_categorised.csv`, `P1130_final_categorised.csv` (scratchpad; to be filed into each project).

**Propagation (Type D — 5 copies) — ALL DONE:** `engine.js`, viewer `CAT_ORDER` + Cab/Deck zones,
engine `index.html` `CATS`, harness `app/vocab.py` `CATEGORIES`, and the field app (`app_template.html`
Cab/Deck zones + `build_app.py` reads category from the canonical) shipped in **app V4.3.5** (2026-08-31).

---

## 2026-08-30 · Unclassified bucket + low-only queue + browse-by-system — `engine.js` **0.6.3**

**Why (operator model).** high → buckets; **low → web-upgrade queue** (only these hit the inbox); **none → an "Unclassified" bucket** (NOT queued — queuing all no-keyword parts floods the inbox). This is the AUDIT / data-management layer (post-assessment), distinct from the initial-assessment harness.

**Changed.** `enrich()` maps a no-keyword result to `category = 'Unclassified'` (a real, findable bucket) with `confidence:'none'`. `assembleCanonical()` `category_review[]` now filters **LOW only** (was low+none). Engine Query Inbox queue renders low-only with the reason shown; note points Unclassified to the viewer bucket. Viewer Parts Mapping gains a third tab **"Browse by system"** — buckets for the 10 systems + Unclassified (with counts) → bucket part list; `CATINDEX` built on load.

**Result (fleet-scoped only — NOT the full plant master).** P1120 fleet (1428 consumed): high 669 · **low-queue 155** · Unclassified 604; golden **1428/1428 EXACT**. P1130 ANC fleet (2151): high 816 · low-queue 196 · Unclassified 1139. Classification reads the **SAP `Material Description`** only; web is the upgrade step, not the classifier.

**NEXT (initial-assessment harness — NOT this engine):** enrich/web-identify BEFORE classify (a web-enriched description classifies far better); then run the **Unclassified** bucket back through classification on its **web-searched description** (stored in the harness DB) to upgrade it into a real bucket.

---

## 2026-08-30 · Category confidence flag + auto-queue — `engine.js` **0.6.2**

**Why.** The keyword categoriser is a fast first pass; the ambiguous tail must be routed to the web-cross-reference step. Rather than web-verify everything (cost) or trust everything (risk), the categoriser now says *how sure it is* so only the culprits queue.

**Changed.** `classifyCategory(desc)` returns `{category, confidence, reason}` — `high` (specific priority rule or a clean keyword), `low` (best-guess priority rule like speed-sensor, a cross-cutting keyword `SWITCH/SENSOR/STUD/VALVE/PLUG/…`, a multi-category match, or a ≤4-char description), or `none` (no keyword). `enrich()` sets `category_confidence`/`category_reason`; `assembleCanonical()` emits **`category_review[]`** — the low+none tail, impact-sorted by net consumption then on-hand — plus `counts.categoryReview`. Engine `index.html` Query Inbox surfaces it as an actionable, impact-sorted queue (dropdown + Save → written once to the canonical, drops off on confirm). Exported `classifyCategory`/`categoryFor`. `AMBIGUOUS_TOKENS` kept tight so broad usually-right words don't over-queue.

**Verify / result.** Golden self-check still **1428/1428 EXACT**. P1120 fleet: of 824 categorised, **81% high-confidence** (669 high · 155 low · 604 uncategorised → queue 759). Consistent across scopes (P1130 ANC fleet 80.6% high-of-categorised; full plant masters 74–75%). Full-plant coverage is ~30% — the classifier is fleet-vocabulary-tuned, so most of a 53k-row whole-plant inventory is non-fleet and correctly falls to `none`.

**Both plants re-run (2026-08-30):** P1120 (53,040) and P1130 (55,181) full masters + the P1130 ANC fleet list (2,151) categorised through 0.6.2; outputs `<plant>_categorised.csv` + `<plant>_review_queue.csv`.

---

## 2026-08-30 · Category-classifier accuracy fixes — `engine.js` **0.6.1**

**Why.** A web-verified audit of a stratified 90-part sample put the keyword categoriser at **86.7%** — below the 95% a central feature needs. Failures were systematic: cross-cutting words (`SWITCH`, `SENSOR`, `HUB`, `BEARING`, `SLACK`) caught by the wrong greedy net (air/pressure/diff switches → Lighting; fan hubs / driveshaft bearings / blower wheels → Wheel end; "No Slack" tensioner → Brakes).

**Changed.** Added a `PRIORITY_CATS` pre-pass in `categoryFor()` (checked before the general `ACT_CATS` nets, first-match-wins): TENSIONER/"No Slack"→Engine, DIFFERENTIAL→Driveline, speed-sensor→Driveline, centre-support/carrier bearing→Driveline, fan clutch/hub→Engine, BLOWER→Winter, air/pressure switch→Air, complete-axle→Wheel end. Engine-only — the Viewer/App **read** `category` from the dataset, so no propagation needed (Type-C change).

**Verify.** Re-audit of the same sample vs the web-established ground truth: **87/90 = 96.7%**, **zero regressions**; golden self-check still **1428/1428 EXACT**. Remaining 3 residuals are genuinely ambiguous (bare "STUD", engine-vs-trans speed sensor, borderline mudflap) — the web-cross-reference tail's job, not keyword-fixable. Sample estimate (±~4%); run a larger census for a hard number.

---

## 2026-08-28 · Fleet-allocation build + Query Inbox — `engine.js` **0.6.0**

**Why.** The viewer's *Fleet & Units* tile must flow exactly like the field app: a tech starts from a unit and drills unit → system → sub-system → the parts. Allocation (part → system category, unit → make/model) is *created* by the assessment work and must be *carried* by the engine into the canonical JSON so the viewer can render it. Plus: field corrections ("rear axle, not front") need a home — the engine, once, at the single source.

**Changed.**
- `engine.js` (additive only):
  - `enrich()` now also sets `category` (system-zone key) and `fits`. Category is taken from a master column **only if it names a real system category** (guarded by `CAT_SET`), otherwise keyword-classified from the description via `categoryFor()` — the same `ACT_CATS` rules as the app's `act_cat`, so coverage matches the app (822 / 1428 categorised on the campaign data).
  - `buildFleet(rows)` — reads a fleet register (`fleet_register_enriched.csv` shape) into `fleet[]` = `{unit, type, make, model, year, engine, floc}` (308 units).
  - `assembleCanonical()` output gains `fleet[]` and `counts.units`; `materials[]` carry `category`/`fits`.
  - version → `0.6.0`; `meta.engineVersion` → `0.6.0`.
- `index.html` (engine): carries `category`/`fits` into `derived.materials`, builds `derived.fleet` from the Fleet Master input; **Query Inbox** 5th tile — lists field allocation-flags (from capture bundles) and lets the analyst **correct a part's category once**, written into the canonical dataset and logged in `corrections[]` (single source of truth → flows to every surface on next export).
- `viewer.html`: **Fleet & Units** drill ported verbatim from the app — `TRACTOR_ZONES` / `TRAILER_ZONES` / `SUBSYS` (category + keyword hotspots), `zonesFor()`; unit → *Pick a system* → *Pick a sub-system* → make-matched part list, plus a "parts actually consumed here" tile (from where-used). `FLEETBYUNIT` index from `fleet[]`.

**Verify / rollback.** Node harness re-run: **1428 / 1428 EXACT**, phase 4, 308 units, scoreboard 50 %. All changes additive — reverting `engine.js` to 0.5.0 and dropping the `category`/`fits`/`fleet` wiring restores prior behaviour with no data loss (the golden columns are untouched).

**Open (roadmap).** App-side allocation **flag** control (feeds the inbox — techs flag, never edit); PR→PO history input; captures→traced-register feedback delta.

---

## 2026-08-28 · Transpose engine + viewer to the field-app shell

**Why.** Operator: the engine and viewer looked like raw form controls ("Delphi"). They must feel like the **same familiar environment** as the Calibre Map field app — one design language across app, viewer, and engine.

**Changed.** Both `index.html` and `viewer.html` rebuilt on the field app's v2.00 design system — green `CALIBRE MAP` brand chrome, per-mode accent colours, Barlow Condensed / Rajdhani / Barlow / JetBrains Mono, tile home + `goHome`/`goBack`/`crumb` screen navigation.
- **Viewer** tiles: Parts Mapping · Duplicate Families · Fleet & Units · Data & Settings. Parts Mapping mirrors the app ("Find a part" / "Start from a unit" → app-style part record). Now **self-contained** (inlined `esc`, dropped the `numacore_lib.js` dependency) and **persists the last dataset** in the browser (IndexedDB + localStorage fallback, auto-restore).
- **Engine** tiles: Load & Derive · Consumption · Duplicates & Scoreboard · Dataset & Export (Steps 2–4 gated until a run). SAP-downloads / Campaign-inputs upload split; PR→PO slot reserved.
- Canonical icon reasserted (the green network glyph from `App/v4.00/design-canvas/Main.dc.html`).

**Verify / rollback.** UI-only; `engine.js` untouched — golden self-check unaffected (1428 / 1428). Each file is self-contained, so reverting either HTML is independent.

---

## Earlier

Phases 1–5 built and validated on the campaign's golden/real data (see `README.md` for the per-phase detail): consumption recompute (MB51 × IW39, 1428/1428), enrichment (INV MSTR + traced register, 1428/1428), verification merge (field capture bundles → verdicts), removal scoreboard (`duplicate_disposition` + `scoreboard`), and the one canonical dataset (`schemaVersion 1.0.0`) with the first Viewer.
