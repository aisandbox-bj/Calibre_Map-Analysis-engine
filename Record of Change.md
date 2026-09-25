# Record of Change — Calibre Map Analysis Engine + Viewer

Reverse-chronological. Each entry: what changed, why, and how to roll back. `engine.js` is the validated deterministic core — every change re-runs the golden self-check (**1428 / 1428 exact**).

---

## 2026-09-24 · engine.js **0.9.0** (schema **1.2.0**) — chain audit: assessment + field capture actually reach the dataset

A full audit of Assessment → Engine → App → Viewer found the hand-offs broken. Engine changes (additive schema;
derivation unchanged — GOLDEN EXACT 2062 on P1120):
- **Verification de-duplicated** (`dedupeVerification`, latest ts per capture key; called by mergeVerification
  and on every refresh). refresh carried `verification[]` forward AND re-merged bundles → live P1120 had 4 records
  for 2 families and the removal scoreboard double-counted (8 dispositions / 6 reorder-risk → true 4 / 3).
- **Verdict = the app's rule:** `verdictFromPiles(g, moved)` ignores 'nf' (not found) and reclassified-out members
  (engine counted 'nf' as its own pile → could say SPLIT where the tech certified SAME).
- **Field capture folded** (`mergeFieldCapture`): equipment comp serial/notes, accessories, spec answers and
  confirmed build items → `field_equipment{}`; SAP flags → `sap_flags[]`; bundle provenance → `field_sources[]`.
  Latest wins; idempotent. (Previously only family verdicts were read — equip/sapFlags/operators/photos ignored.)
- **Assessment overlay guarded** (`applyAssessment` returns a change summary → `meta.assessment`): only High/Med,
  never "Unclassified" (the harness holds 1,512 Low/Unclassified rows that would have overwritten SAP-desc
  classifications); High identities fill a BLANK brand / OEM PN (`identity_source:'assessment'`).
- `fleetFromWhereUsed()` — first build without a fleet register still gets a unit list.
- `meta.drop`, `counts.unitsWithFieldCapture / sapFlags / fieldSources`.
**viewer.html:** "Recorded in the field" card (unit), SAP-flag card + fleet row + identity source (part), family
photo strips, Home chips for field records / SAP flags, Data page lists every source file (labelled) + a table of
folded capture files; export named `CalibreMap_viewer_<client>_<date>.json`.
**index.html:** marked an inspection/what-if tool (it drifted from refresh.js: no register seeding, identity,
bins, cost, specs, assessment or field records); its export is now `CalibreMap_workingcopy_<date>.json`.
Rollback: revert engine.js/viewer.html/index.html to the prior commit; re-run refresh (0.8.8 re-introduces the
double-count).

## 2026-09-24 · viewer.html — field-photo galleries + dataset-identity + capture-bundle detection (Phase 2)

Photos-first pipeline. The viewer can now run as a **OneDrive-folder pack** (`data.js` + a `photos/` folder,
opened locally — no server, no fetch). Additions, all graceful when the globals are absent (the classic single-file
bundle is unchanged):
- **Field-photo galleries.** `photoGallery()` + `lightbox()` read `window.__CALIBRE_PHOTOS__` (byMat / byUnit,
  filenames under `photos/`) and render `<img>` thumbnails on `partView` (this part's field photos) and `unitView`
  (unit dataplate / component / accessory photos). Absent global → helpers return [] → nothing renders.
- **Dataset-identity strip** on Home (`datasetInfo()`): TYPE · CLIENT · DATE · PARTS · FAMILIES · UNITS · FIELD
  PHOTOS, from `window.__CALIBRE_META__` / `DATA.meta`.
- **Capture-bundle detection.** `ingest()` routes any `type:"capture"` JSON to `captureInfoView()` — a details
  card (client / device / operator / exported / counts) instead of trying to render app-output as a dataset.
- New build scripts (in the app repo): `Deliverables/build/build_viewer_pack.py` (emits the `CalibreMap_pack_*`
  folder + externalises bundle photos to `photos/<sha1>.jpg`) and `bundle_viewer.py` renamed output to
  `CalibreMap_viewer_<client>_<date>.html`, both injecting `__CALIBRE_META__`.
Rollback: remove `photoGallery`/`lightbox`/`datasetInfo`/`captureInfoView` + their two call sites + the `.pgal`/
`.dschip` CSS; the viewer reverts to the classic single-file behaviour. No engine.js change.

## 2026-09-24 · viewer.html — unit cost on the part card

`partView` Stock & MRP card gains a **Unit cost** row (`m.unit_cost` → `$X · SAP moving avg`, else "not
available"), mirroring the field app. Read-only; no engine change. Rollback: drop the one `<div class="k">Unit
cost</div>` row.

## 2026-09-24 · engine.js **0.8.8** — `materials[].unit_cost` (INV_MSTR moving/standard price)

**What:** `enrich` reads the SAP unit price from the INV MSTR row — **Moving price**, else **Standard price** —
onto `m.unitCost`, and `toCanonicalMaterials` emits `unit_cost` (0 = not available). Populated on **3,172** of
3,861 materials. Feeds the app's Duplicate-Families "sort by unit cost" (V4.5.3). **GOLDEN EXACT + VERIFY OK**
(additive). **Rollback:** drop the `m.unitCost` line in `enrich` and `unit_cost` in `toCanonicalMaterials`.
`ENGINE_VERSION` 0.8.7 → **0.8.8**.

## 2026-09-24 · engine.js **0.8.7** — provisional fleet tag refined with served/category context

**What:** `fleetOf` now refines the **`scope-provisional` TT&TL** branch (parts tagged tractor-trailer from the
register scope, no where-used) using deterministic context — **no LLM.** A part is downgraded **TT&TL → TT**
(basis **`served-config`**) when it has engine/transmission **served** evidence OR sits in a **power-unit-only
category** (`Engine & emissions`, `Charging & starting`, `Cab & body`) — because engines and cabs don't exist on
trailers. `servedBy` was moved above the fleet-tag block so `fleetOf` can read it. **Effect on the 09-21 drop:**
**TT 1,280 → 1,451 (+171), TT&TL 880 → 709 (−171)**; 171 parts move to basis `served-config`. Directly resolves
the audit's systematic TT&TL-over-breadth flags (turbos, alternators, engine mounts, harnesses, cab parts).
**GOLDEN EXACT + VERIFY OK held.** **Why:** implements the scoping note's "step 1" — re-scope with served
context, deterministically. **Rollback:** revert the `sc === 'tractor-trailer'` branch of `fleetOf` to
`return ['TT&TL','scope-provisional']`. `ENGINE_VERSION` 0.8.6 → **0.8.7**.

## 2026-09-24 · engine.js **0.8.6** — per-part `served` config sets (Parts-Mapping fit ladder)

**What:** in `assembleCanonical`, each material gains `served = {eng:[], trans:[], axle:[], ratio:[]}` — the
engine/transmission/axle-model + diff-ratio values it has been **consumed against**, rolled up from its
where-used units' build specs (`buildBy` from `fleet[].build`, normalised uppercase/space-collapsed). Emitted on
**1,327** materials on the 09-21 drop. This is the deterministic basis for the Viewer/app **fit ladder** —
High = used on this unit · Medium = `served` matches this unit's config on the dimension relevant to the part's
category (i.e. used on sibling-config units) · Low = catalogue/category only · N/A = unit has no build spec.
**Why:** turns the unit drill-down from a category dump into a confidence-ranked list (the planner search-time
value driver). **GOLDEN EXACT + VERIFY OK held** (additive; movers/consumption untouched). **Rollback:** remove
the `served` precompute + `out.served` line in `assembleCanonical`. `ENGINE_VERSION` 0.8.5 → **0.8.6**.
Viewer/app apply the same tiny tiering rule (`fitStage`/`fitStageV`, `FIT_DIM` by category).

## 2026-09-23 · engine.js **0.8.5** — planner unit build-specs → `fleet[].build` (viewer + app)

**What:** new `buildUnitSpecs(fleet, specRows)` attaches a per-unit **build** block to each matching fleet unit —
`engine{make,model,esn}`, `transmission{make,model,sn}`, `diffs[{pos,make,model,ratio,sn}]`, `cab`, `chassis`,
`serial`, `source`, `asOf`. Source = the planner's "Semi-Truck Subcomponent & Unit Specs" drop, normalised by
`build_unit_specs.py` → `Analysis/unit_build_specs.csv`, read by `refresh.js` and passed to the engine. When the
register had no engine string, the planner engine make/model backfills `u.engine` (strengthens the fleet lens).
`fleet[]` is emitted wholesale so `build` flows to the canonical; **114 units** carry it on the 09-21 drop.
**Provenance scheme** (rendered by app + viewer): value present = planner (blue), absent = unknown (orange),
device-confirmed = field-verified (green). **GOLDEN EXACT + VERIFY OK held** (additive to fleet units only).
**Why:** build-spec identity is the evidence layer for accurate part cross-referencing (scoping note in the
Material ID project). **Rollback:** revert `buildUnitSpecs` + its call in refresh.js; remove `unit_build_specs.csv`.
Viewer: `renderUnitBuild(u)` (read-only panel). `ENGINE_VERSION` 0.8.4 → **0.8.5**.

## 2026-09-23 · engine.js **0.8.4** — `materials[].fleet` tag emitted (mat_fleet.json retired)

**What:** materials carry `fleet` (TT/TL/TT&TL/Other) + `fleet_basis` (where-used / scope-provisional / scope /
unknown), derived from where-used unit types (authoritative) else the register `scope`. Family fleet = union of
members. Retires the hand-kept `mat_fleet.json` (build_app reads `m.fleet`). GOLDEN EXACT held. Rollback: revert
the fleet block in `assembleCanonical`. `ENGINE_VERSION` 0.8.3 → 0.8.4.

## 2026-09-23 · engine.js **0.8.3** — full duplicate-family set into the canonical + app single-source (viewer ↔ app parity)

**Why.** The app rendered **61** duplicate families (from `Analysis/duplicate_families.csv` +
`App/data/fam_verified.json` + `fam_extra.json`), but the viewer reads `canonical.families`, which the
engine only populated from field-verified capture verdicts — **and those doubled** (a bundle folded
twice), so the viewer showed "4" (really 2 families ×2). App and viewer disagreed on the same client's
duplicates. Operator: reconcile the families **via the engine** (never a hand-edit — sole-author rule).

**What (additive).** `assembleCanonical` now (1) **dedupes** field families by `family_id`, and (2) folds
a new input `dataset.catalogue_families` in **UNDER** field + research families — skipped if the
`family_id` is already present or any member sits in a higher-precedence family. Catalogue families carry
`verdict` + `part` + `cert` + `fleet` + `note`/`site_q`/`unsure` but **no per-member survivor** (desk
level), so members are emitted `{material, keep:false}` and the family is tagged `source:'catalogue'`.
`refresh.js` parses the three sources into `catalogue_families` (I/O in the harness; authoring in the
engine). **0.8.3** then attaches the catalogue display metadata (`part`/`skus`/`combined_oh`/`cert`/
`fleet`/`unsure`/`site_q`) to the **field** families too (matched by `family_id`), so `canonical.families`
is the COMPLETE family record for BOTH tools. `SCHEMA_VERSION` stays **1.1.0** (additive);
`engineVersion` → **0.8.3**.

**Viewer (Type A propagation).** `dupHome` and `dupPanel` branch on `source`: field families keep the
KEEP/retire·pile rendering; catalogue families render as candidates (verdict + part + members + cert +
Site Q, no fabricated survivor). Header now "Verified families — N · X bench-verified · Y desk-verified".

**Result / verify.** Canonical `families` = **61 distinct** (2 field + 59 catalogue) on the 2026-09-21
drop; **VERIFY OK**, derive **GOLDEN EXACT (2062 movers)** — consumption math untouched. Viewer
render-checked (list + part-lookup box). **App migrated (single source):** `build_app.py` now reads the
family set from `canonical.families` (was re-parsing `duplicate_families.csv` + `fam_verified.json` +
`fam_extra.json`); rebuild parity verified — **61/61**, F001 and the field families identical field-for-field
(`n/part/skus/oh/vd/vnote/cert/flt/uns/sq`). APK V4.4.0 rebuilt, integrity gate passed. Both tools now read
ONE family record. (The three source files remain the human-edited inputs the engine folds; only the
readers changed.)

**Roll back.** Revert engine.js `assembleCanonical` (drop the dedupe + catMeta attach + `catalogue_families`
block, restore `ENGINE_VERSION` 0.8.1), the `refresh.js` `buildCatalogueFamilies` block, the two
`viewer.html` branches, and `build_app.py`'s family reader (back to the `duplicate_families.csv` loop +
`fam_verified`/`fam_extra` overlay); re-run `refresh.js --drop 2026_09_21 --build-app`.

---

## 2026-09-22 · engine.js **0.8.1** — bin locations into the canonical (app + viewer, one source)

**Why.** Bins were app-only (build_app.py globbed `Bin Locations*.xlsx`), so the viewer showed
none, and a fresh extract named `SAP BIN LOC*` in a dated subfolder wasn't even discovered.
Operator dropped a fresh bin extract and asked for it in the JSON, then app + viewer.

**What (additive).** `buildBins(rows)` → `{mn: ["<section> · <bin>", …]}` (label logic ported from
build_app.py: section·bin, storage-type prefix only when not the main WHM1). `enrich()` accepts
`opts.binsByMat` → sets `m.bins`; `toCanonicalMaterials` emits `material.bin` (array; empty = zero
stock / no bin); `assembleCanonical` meta gains `binsAsOf`. `SCHEMA_VERSION` stays 1.1.0 (additive);
`engineVersion` → 0.8.1. `viewer.html` Stock & MRP card now shows the bin(s) + "dynamic slot · as of
<binsAsOf> · check SAP if empty", or "— no bin (zero stock)".

**Blast radius.** Consumption math untouched — **golden EXACT** on the 2026-09-21 drop. The refresh
harness discovers the newest bin file across ALL drop folders and threads it through; build_app.py now
reads bins from the canonical (single source, no more glob). Live: 2,920 fleet materials carry bins
(as of 2026-09-22), rendered in both viewer and app (console clean). Rollback:
`engine.js.bak-0.7.2-2026-09-21` (pre-0.8.x) or git.

---

## 2026-09-21 · engine.js **0.8.0** / schema **1.1.0** — engine becomes the SOLE canonical author (review repair P1)

**Why.** The code review found the canonical had grown a second producer (a Python assembler in the
Material ID project) because the engine could not do three things: carry register parts that never
moved (derive() only yields movers, and the UI filtered `netAll<=0`), map its own internal shape to the
canonical shape (that lived in index.html, so every harness re-implemented it), and carry identity /
unit-configuration fields. This release closes all three so `assembleCanonical` is again the only writer.

**What (all additive; consumption math untouched).**
- `seedRegister(materials, rows, keyCol)` — unions the fleet register into the materials map as
  zero-consumption entries (`_seeded`), so dead stock is visible.
- `toCanonicalMaterials(materials, {includeNonMovers})` — the internal→canonical mapping, now owned
  here. Emits `moved` (true/false) and, when a register was supplied, `brand · oem_pn · crosses ·
  duplicate_family · scope`.
- `enrich()` gains `opts.identityByMat` (consolidated-register rows): sets those identity fields, uses
  the register description/category as fallbacks (so seeded parts classify), maps `duplicate_family`
  onto `dupGroup` (the field the viewer reads), and accepts INV MSTR's real column name
  **`Unrestricted`** alongside the legacy `OnHand`.
- `buildEquipSpec()` + `buildEquipEvidence(fleet, brakeRows)` — unit-configuration template and
  work-order/engine evidence; owner moved here from `build_app.py`. Attaches `fleet[].spec{v,h}`.
- `assembleCanonical` emits top-level `equipSpec` and new counts `movers · zeroStock ·
  unitsWithSpecEvidence`. `SCHEMA_VERSION` 1.0.0 → **1.1.0**; `engineVersion` → 0.8.0.
- Removed the unreferenced back-compat export `categoryFor()`.

**Validated.** Golden regression on the real 2026-09-21 MB51+IW39: `derive()` output of 0.7.2 vs 0.8.0 —
**5,522 materials, 0 records differ (EXACT)**. Synthetic unit test of seeding / identity / evidence /
assembly. Live: the Material ID refresh harness (`Deliverables/build/refresh.js`) now builds the whole
canonical through this engine — 3,861 parts, 1,511 movers, 941 zero-stock, 122 units with evidence,
schema 1.1.0 — and the viewer renders identity + configuration from it. Rollback:
`engine.js.bak-0.7.2-2026-09-21`. **index.html still uses its own inline mapping** (behaviour unchanged);
switching it to `toCanonicalMaterials` is the follow-up that removes the last duplicate.

---

## 2026-09-21 · viewer.html — Identity card reads the 1.1.0 identity fields

`partView` Identity card now shows **OEM / vendor PN** (`oem_pn` → `pn`), **True brand** (`brand` →
`traced_brand`), **Cross-refs** (`crosses`) and **Identity / fits** when present, and a **Status** line
that distinguishes "in material master" from "known part · never issued on a fleet work order"
(`moved === false`). Backward-compatible with 1.0.0 datasets (falls back to the old fields). Fixes the
"Vendor PN —" symptom at its root.

---

## 2026-09-21 · viewer.html — work-order **roll-out cards** in Where-used (Type A, mirror of app FEAT-40)

**Why.** Operator: a clicked work order "ugly-ly just shows some text" — wanted a card that draws
attention (WO no · header text · qty · etc.). Design settled in the field app first (owner), mirrored here.

**What.** `vWoCard(w, unit)` replaces the inline `.wos` text rows under "Where used & likely fit". Compact
one-liner (**WO no · header text · × qty · ▼**) that **rolls out on click** into an accent card: header text
large, then fact cells Work order · Qty issued · Posted · Unit (make/model). Same CSS block as the app
(`.wocard/.woh/.wob/.wogrid`, accent cell `woacc` — deliberately not `acc`, which is the app's accordion class).
Click is `stopPropagation`'d so the enclosing unit toggle is unaffected.

**Blast radius.** Viewer display only; reads the existing `where_used[].wos` shape. Rollback:
`viewer.html.bak-prebuild-2026-09-21`. **Validated** live on 1035908 → WO 44262 "REPLACE AXLE 2
DIFFERENTIAL" · qty 1 · 2026-09 · TT3092 Peterbilt 388, pixel-parity with the app; console clean.

---

## 2026-09-21 · viewer.html — read-only unit **Configuration** panel (Type A + B)

**Why.** The field app has Equipment Verification (unit spec: driveline/trans/axles/brakes/engine/cab
/trailer); the viewer showed nothing of it. Operator asked the viewer to show each unit's config —
**the confirmed value, or "Unconfirmed"**.

**What.** `unitView` now renders a Configuration card above "Pick a system", driven by two new
canonical fields (additive, produced by the 2026-09-21 consolidated build): top-level `equipSpec`
(the section/field template) and per-unit `fleet[].spec` = `{v:{field:{o,n}}, h:{field:note}}`
(consumption-evidence-confirmed values + hints). Each field shows its confirmed value in green with
the evidence note, or "Unconfirmed" in amber. `specKeysFor(u)` mirrors the app (tractor vs trailer
sections). New CSS: `.cfgcard/.cfgsec/.cfgrow/.cfgk/.cfgv`.

**Blast radius.** Viewer only + two additive canonical fields. **Backward-compatible**:
`renderUnitConfig` returns '' when `equipSpec`/`spec` are absent, so datasets built before today
render unchanged (verified). Field app already owns this data model (`build_app.py` `equip_spec` +
`equip_ev`) — the canonical now carries the same, single-sourced. Rollback: `viewer.html.bak-prebuild-2026-09-21`.

**Validated.** Served + loaded the 2026-09-21 canonical; TT3002 (engine-only evidence) and TT3004
(brakes S-cam drum / Meritor Q/Q+ + ISX engine) render values in green with notes, remaining fields
"Unconfirmed"; console clean.

---

## 2026-09-14 · engine.js 0.7.2 — research families fold in UNDER field-verified verdicts (contract)

**Why.** The Assessment Tool's new duplicate-family **adjudicator** produces research candidate
families. They must never contradict the bench: field-verified verdicts govern.

**What.** `assembleCanonical` now reads `dataset.research_families` (the assessment tool's
`/api/export` section) and appends each in the same families[] shape **only if none of its
members already appears in a field-verified family** (member-based precedence). Every family
carries `source: 'field' | 'research'`. Verdict strings stay the `verdictFromPiles` enums
(SAME / SPLIT / ALL_DIFFERENT) so engine/viewer/app agree.

**Blast radius.** Additive to `families[]` only — `materials`, consumption, scoreboard and the
no-research path are untouched (golden **1428/1428** unaffected; the input is empty by default).
Viewer/app render research families with the existing family shape; a `source` badge is an
optional later display tweak.

**Validated.** Node unit test: a research family overlapping a field family is suppressed, a
disjoint one is kept + tagged `research`, the field family tagged `field`, materials unchanged;
no-research path returns verification families intact.

**Rollback.** Revert the `research_families` block in `assembleCanonical` + the version bump; no migration.

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
