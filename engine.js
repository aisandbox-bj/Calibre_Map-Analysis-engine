/*
 * Calibre Map — Analysis Engine · core deterministic derivations
 *
 * Framework-free, parser-agnostic. Runs in Node (module.exports) and the
 * browser (window.CalibreEngine). Callers pass ALREADY-PARSED row objects
 * (arrays of {Column: value}) — SheetJS reading is the caller's job, so this
 * file has no I/O and is trivially testable.
 *
 * Phase 1 — transactional recompute: where-used + net consumed, from
 * MB51 (261/262 WO consumption) joined to IW39 (Order -> Sort Field = unit).
 * Ported from build_app.py's where-used join; validated by diffing net
 * consumed against the committed Analysis/consumption_by_unit.csv.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CalibreEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function s(v) { return v == null ? '' : String(v).trim(); }
  function round1(x) { return Math.round(x * 10) / 10; }

  // Posting Date -> "YYYY-MM". Expects a JS Date (SheetJS {cellDates:true}) or
  // an ISO-ish string; degrades to first 7 chars.
  function postingMonth(v) {
    if (v == null) return '';
    if (v instanceof Date && !isNaN(v)) {
      var mm = String(v.getMonth() + 1).padStart(2, '0');
      return v.getFullYear() + '-' + mm;
    }
    return String(v).slice(0, 7);
  }

  // IW39 rows -> { woUnit[order]=unit, woDesc[order]=cleaned description }.
  // The WO description often repeats the unit as a prefix ("TT3103-..."); strip it.
  function indexIW39(rows) {
    var woUnit = {}, woDesc = {};
    (rows || []).forEach(function (d) {
      var o = s(d['Order']); if (!o) return;
      var u = s(d['Sort Field']);
      woUnit[o] = u;
      var desc = s(d['Description']);
      if (u && desc.toUpperCase().indexOf(u.toUpperCase()) === 0) {
        desc = desc.slice(u.length).replace(/^[-–\s]+/, '').trim();
      }
      woDesc[o] = desc.slice(0, 46);
    });
    return { woUnit: woUnit, woDesc: woDesc };
  }

  // MB51 rows + IW39 index -> per-material aggregates.
  // Returns materials[mn] = {
  //   whereUsed: [ {unit, qty, wos:[[order,qty,"YYYY-MM",desc],...]} ] (units with net>0, desc-sorted),
  //   issPositive: sum of positive-unit qty (build_app.py's `iss` — drops fully-reversed units),
  //   netAll:      material-level net of all 261/262 (may be < issPositive when a unit net-reverses)
  // }
  function derive(mb51Rows, iw39Index) {
    var woUnit = (iw39Index && iw39Index.woUnit) || {};
    var woDesc = (iw39Index && iw39Index.woDesc) || {};
    var use = {};     // mn -> unit -> {qty, wos:{order:{qty,ds}}}
    var netAll = {};  // mn -> running net

    (mb51Rows || []).forEach(function (d) {
      var mt = s(d['Movement Type']);
      if (mt !== '261' && mt !== '262') return;   // WO consumption + reversals only
      var mn = s(d['Material']); var o = s(d['Order']);
      if (!mn || !o) return;
      var q = parseFloat(d['Quantity']); if (isNaN(q)) return;
      q = -q;                                      // 261 posts negative; flip so consumption is positive
      netAll[mn] = (netAll[mn] || 0) + q;
      var ds = postingMonth(d['Posting Date']);
      var unit = woUnit[o] || '(unit unknown)';
      var um = use[mn] || (use[mn] = {});
      var rec = um[unit] || (um[unit] = { qty: 0, wos: {} });
      rec.qty += q;
      var w = rec.wos[o] || (rec.wos[o] = { qty: 0, ds: ds });
      w.qty += q; if (ds > w.ds) w.ds = ds;
    });

    var materials = {};
    Object.keys(use).forEach(function (mn) {
      var units = use[mn], out = [], issPos = 0;
      Object.keys(units).forEach(function (unit) {
        var rec = units[unit];
        if (rec.qty <= 0) return;                  // unit fully reversed — drop
        issPos += rec.qty;
        var wl = Object.keys(rec.wos).map(function (o) {
          return [o, round1(rec.wos[o].qty), rec.wos[o].ds, woDesc[o] || ''];
        }).filter(function (x) { return x[1] > 0; });
        wl.sort(function (a, b) { return a[2] < b[2] ? 1 : a[2] > b[2] ? -1 : 0; });
        out.push({ unit: unit, qty: round1(rec.qty), wos: wl });
      });
      out.sort(function (a, b) { return b.qty - a.qty; });
      materials[mn] = { whereUsed: out, issPositive: round1(issPos), netAll: round1(netAll[mn] || 0) };
    });
    // materials whose movements fully net out still deserve a (zero) record
    Object.keys(netAll).forEach(function (mn) {
      if (!materials[mn]) materials[mn] = { whereUsed: [], issPositive: 0, netAll: round1(netAll[mn]) };
    });
    return materials;
  }

  // Roll where-used up to a "unit family" label via a unit -> family map.
  // Returns "Fam A: 79; Fam B: 38; ..." sorted desc — the shape of the golden
  // "Consumed by (unit family: qty)" column. Units with no mapping fall back to `unit`.
  function consumedByFamily(material, unitFamilyMap) {
    unitFamilyMap = unitFamilyMap || {};
    var byFam = {};
    (material.whereUsed || []).forEach(function (r) {
      var fam = unitFamilyMap[r.unit] || r.unit;
      byFam[fam] = (byFam[fam] || 0) + r.qty;
    });
    return Object.keys(byFam)
      .map(function (f) { return [f, round1(byFam[f])]; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .map(function (x) { return x[0] + ': ' + x[1]; })
      .join('; ');
  }

  // ── Phase 2: master/inventory enrichment ─────────────────────────
  // Deterministic category classification by description keyword — ported from
  // build_app.py's act_cat(), so the Fleet & Units drill has the SAME system-zone
  // coverage as the field app. Used as a fallback when the master carries no Category.
  var ACT_CATS = [
    [/SHOE|DRUM|CHAMBER|SLACK|LINING|BRAKE|ROTOR|PAD/, 'Brakes'],
    [/DRYER|COMPRESSOR|GLADHAND|EVAPORATOR|ALCOHOL|VALVE, DRAIN|AIR TANK/, 'Air system'],
    [/BATTERY|ALTERNATOR|STARTER/, 'Charging & starting'],
    [/LAMP|LIGHT|LED|BULB|WIPER|HARNESS|RECEPTACLE|PLUG|SWITCH|SENSOR|DISCONNECT|SOCKET/, 'Lighting & electrical'],
    [/SEAL, WHEEL|SCOTSEAL|HUB|BEARING|STUD|WHEEL|TIRE|SPINDLE/, 'Wheel end'],
    [/U-JOINT|YOKE|DRIVESHAFT|PTO|TRANSMISSION|DIFF|PINION|AXLE SHAFT|STRAP KIT/, 'Driveline'],
    [/SHOCK|AIR SPRING|SPRING, AIR|AIR ?BAG|BAG, ?AIR|LEAF SPRING|SPRING, LEAF|SHACKLE|U-?BOLT|TORQUE ROD|BUSHING|STEERING|TIE ROD|KING ?PIN|PITMAN|DRAG LINK/, 'Suspension & steering'],
    [/HEATER|WEBASTO|ESPAR|BLOWER|FUEL TREATMENT|WINTER|BLOCK HEATER/, 'Winter package'],
    [/KINGPIN|LANDING|FIFTH|MUDFLAP|TRAILER/, 'Coupling & trailer'],
    [/FILTER|GASKET|INJECTOR|TURBO|EXHAUST|CLAMP|BELT|TENSIONER|THERMOSTAT|RADIATOR|MANIFOLD|SLEEVE|ENGINE|COOLANT|WATER PUMP|CAMSHAFT|CRANKSHAFT|PULLEY|COOLER/, 'Engine & emissions'],
    // 11th category (added 2026-08-30) — a home for cab/body glass, hood & body panels,
    // and cab/safety equipment that fit no vehicle SYSTEM. Placed LAST so any system
    // keyword above wins first. Deliberately CONSERVATIVE: only confident body/cab/glass
    // terms (+ SCREW = generic hardware). Cross-system words (HOSE, BOLT, BRACKET,
    // FITTING, VALVE) are NOT here — a coolant/air/steering hose or a spring U-bolt would
    // wrongly land in body — those stay 'none' and the web layer resolves them.
    [/WINDSHIELD|WINSHIELD|SIGHT GLASS|\bGLASS\b|MIRROR|\bHOOD\b|FENDER|GRILLE|\bGRILL\b|BUMPER|\bDOOR\b|\bLATCH\b|HINGE|EXTINGUISHER|VISOR|SUNVISOR|\bSEAT\b|WINDOW|CROSSMEMBER|\bSCREW\b/, 'Cab & body']
  ];
  // Specific disambiguations checked BEFORE the general ACT_CATS nets — cross-cutting
  // words (SWITCH, SENSOR, HUB, BEARING, SLACK) otherwise get caught by the wrong
  // greedy rule. Order matters (first match wins). Audit-driven (web-verified sample).
  // [regex, category, confidence]. Most priority rules are confident disambiguations;
  // speed-sensor is a best-guess (trans vs engine cam/crank can't be told from the
  // description alone) so it is emitted LOW to auto-queue for the web tail.
  var PRIORITY_CATS = [
    [/NO ?SLACK|\bTENSIONER\b/, 'Engine & emissions', 'high'],          // "No Slack" = Dayco belt tensioner, not a brake slack adjuster
    [/DIFFERENTIAL|DIFF[ -]?LOCK/, 'Driveline', 'high'],                // incl. differential air/lock switches
    [/SPEED.*SENSOR|SENSOR.*SPEED/, 'Driveline', 'low'],               // trans/ABS/wheel vs engine cam/crank — best guess, verify
    [/CENTER SUPPORT|CENTRE SUPPORT|CARRIER BEARING/, 'Driveline', 'high'], // driveshaft carrier bearing, not a wheel-end bearing
    [/FAN CLUTCH|FAN HUB|HUB, ?FAN|VISCOUS FAN/, 'Engine & emissions', 'high'], // engine cooling fan hub/clutch, not a wheel hub
    [/\bBLOWER\b/, 'Winter package', 'high'],                           // HVAC/cab blower fan, not a wheel
    [/PRESSURE SWITCH|SWITCH, ?PRESSURE|LOW AIR|AIR,? (TOGGLE )?SWITCH|SWITCH, ?AIR/, 'Air system', 'high'], // pneumatic/air-brake switches
    [/AXLE,? ?(COMPLETE|ASSY|ASSEMBLY)/, 'Wheel end', 'high'],          // a complete axle assembly is running gear, not coupling
    // ── harvested from the P1120 dual-classification validation (web-identified part-types
    //    the greedy nets missed). Specific → checked here so they resolve confidently. ──
    [/HEIGHT CONTROL VALVE|AIR ?BAG,? ?(CONTROL )?VALVE|DASH VALVE|VALVE,? ?3 DASH|AIR EMERGENCY|EMERGENCY VALVE/, 'Air system', 'high'], // pneumatic control/dash/emergency valves — BEFORE AIR BAG→Suspension
    [/CONTROL MODULE|MODULE, ?CONTROL|\bCECU\b|\bECU\b|CONTROL UNIT/, 'Lighting & electrical', 'high'], // cab/chassis electronic control modules
    [/FUEL (CONDITIONER|RETURN|SPLITTER)|CONDITIONER, ?DIESEL|DIESEL.*CONDITIONER/, 'Engine & emissions', 'high'], // fuel conditioner/return-flow splitter
    [/ROCKER ARM|ARM, ?ROCKER/, 'Engine & emissions', 'high'],          // valvetrain rocker arm
    [/OIL FILL|FILL, ?OIL|OIL PUMP|PUMP, ?OIL/, 'Engine & emissions', 'high'], // oil filler cap / oil pump
    [/\bS-?CAM\b/, 'Brakes', 'high'],                                    // S-cam brake actuator
    [/\bCLUTCH\b/, 'Driveline', 'high'],                                 // clutch (fan clutch already caught above → Engine)
    // ── round-2 harvest (full in-session enrichment) ──
    [/BACK-?UP ALARM|ALARM, ?BACK-?UP/, 'Lighting & electrical', 'high'], // reversing alarm (both SAP word orders)
    [/RELAY VALVE|VALVE, ?RELAY|QUICK[ -]?RELEASE|VALVE, ?QUICK|PURGE VALVE|VALVE, ?PURGE|\bAIR LINE\b/, 'Air system', 'high'], // pneumatic air-brake valves/lines (Air, per air-switch convention)
    [/FUEL (CAP|PUMP|LINE|SUPPLY|PRIMING)|CAP, ?FUEL|PUMP, ?FUEL/, 'Engine & emissions', 'high'], // fuel system (NOT "FUEL TREATMENT"→Winter, left to ACT)
    // ── round-3 harvest (full in-session enrichment, 650 parts) ──
    [/AXLE SEAL|SEAL, ?AXLE/, 'Wheel end', 'high'],                     // axle/wheel-end seal (before Driveline AXLE SHAFT)
    [/RELIEF VALVE|VALVE, ?RELIEF|PROTECTION VALVE|CHECK VALVE|VALVE, ?CHECK|DASH.{0,14}VALVE|LEVELING VALVE|\bGOVERNOR\b/, 'Air system', 'high'] // pneumatic relief/protection/check/dash/leveling valves + compressor governor
  ];
  // Cross-cutting words that on their own don't pin a system — a match driven only by
  // one of these is emitted LOW so it auto-queues for web verification. Kept TIGHT to
  // the words that actually caused audit misfires (span electrical/air/brake/driveline);
  // the priority pass above already resolves the common cases (fan hub, carrier bearing,
  // air switch…), so broad, usually-right words (SEAL, HOSE, NUT, KIT, HUB, BEARING,
  // WHEEL) are NOT treated as ambiguous — that would over-queue and defeat the point.
  var AMBIGUOUS_TOKENS = /\b(SWITCH|SENSOR|STUD|VALVE|PLUG|MODULE|ACTUATOR|SOLENOID)\b/;

  // Classify a description into a system-zone category WITH a confidence + reason,
  // so the low-confidence tail can be auto-queued for the web-cross-reference step.
  // confidence: 'high' | 'low' | 'none'.
  function classifyCategory(desc) {
    var d = String(desc || '').toUpperCase().trim();
    if (!d) return { category: '', confidence: 'none', reason: 'blank description' };
    for (var p = 0; p < PRIORITY_CATS.length; p++) {
      if (PRIORITY_CATS[p][0].test(d)) {
        var pc = PRIORITY_CATS[p][2] || 'high';
        return { category: PRIORITY_CATS[p][1], confidence: pc,
                 reason: pc === 'low' ? 'best-guess disambiguation — verify' : 'specific rule' };
      }
    }
    var hits = [];
    for (var i = 0; i < ACT_CATS.length; i++) { if (ACT_CATS[i][0].test(d)) hits.push(ACT_CATS[i][1]); }
    if (!hits.length) return { category: '', confidence: 'none', reason: 'no keyword match' };
    var distinct = hits.filter(function (v, ix) { return hits.indexOf(v) === ix; });
    var reasons = [];
    if (distinct.length > 1) reasons.push('matches ' + distinct.length + ' categories (' + distinct.join(' / ') + ')');
    if (AMBIGUOUS_TOKENS.test(d)) reasons.push('cross-cutting keyword');
    if (d.replace(/[^A-Z0-9]/g, '').length <= 4) reasons.push('thin description');
    return { category: hits[0], confidence: reasons.length ? 'low' : 'high',
             reason: reasons.length ? reasons.join('; ') : 'keyword match' };
  }
  function categoryFor(desc) { return classifyCategory(desc).category; }   // back-compat
  // The valid system-zone categories (what the Fleet & Units drill filters on).
  // A master "Category" column is only trusted if it names one of these — the
  // traced register's own Category is a fleet-bucket taxonomy, not this one.
  var CAT_SET = {}; ACT_CATS.forEach(function (a) { CAT_SET[a[1]] = 1; });
  function numOrBlank(v) {
    if (v == null || v === '') return '';
    var n = Number(v); return isNaN(n) ? '' : n;
  }
  // Index an array of row objects by a key column -> { key: row } (first wins).
  function indexBy(rows, keyCol) {
    var m = {};
    (rows || []).forEach(function (r) { var k = s(r[keyCol]); if (k && !(k in m)) m[k] = r; });
    return m;
  }
  // Attach the golden consumption_by_unit columns from INV MSTR + traced register.
  // opts.invByMat  = indexBy(INV MSTR rows, 'Material')
  // opts.tracedByMat = indexBy(traced_register rows, 'Material')
  // Mutates and returns `materials`.
  function enrich(materials, opts) {
    opts = opts || {};
    var inv = opts.invByMat || {}, tr = opts.tracedByMat || {};
    var hasInv = inv && Object.keys(inv).length > 0;
    Object.keys(materials).forEach(function (mn) {
      var m = materials[mn], i = inv[mn] || {}, t = tr[mn] || {};
      // "identified" = present in the material master (INV MSTR). A consumed
      // material absent from the master is genuinely unknown → needs identification.
      if (hasInv) m.identified = !!inv[mn];
      m.description  = s(i['Material Description']) || s(t['Description']) || '';
      m.pn           = s(i['Manufacturer Part No.']) || s(t['PN']) || '';
      m.onHand       = numOrBlank(i['OnHand']);
      m.mrpType      = s(i['MRP Type']);
      m.rop          = numOrBlank(i['Reorder Point']);
      m.max          = numOrBlank(i['Maximum Stock Level']);
      m.tracedBrand  = s(t['Trace brand']);
      m.dupGroupId   = s(t['Duplicate group']);
      m.dupGroup     = s(t['Group label']);   // golden shows the human label, not the id
      // ── allocation fields (Fleet & Units drill) — additive ──
      // Category = the system-zone key: a master column ONLY if it names a real
      // system category, else keyword-classified from the description (app rules).
      var mcat       = s(t['Category']) || s(i['Material Group']);
      if (CAT_SET[mcat]) { m.category = mcat; m.categoryConfidence = 'high'; m.categoryReason = 'master category'; }
      else { var cc = classifyCategory(m.description);
        // no keyword → a real "Unclassified" bucket (findable in Parts Mapping), NOT the review queue
        m.category = cc.category || 'Unclassified'; m.categoryConfidence = cc.confidence; m.categoryReason = cc.reason; }
      m.fits         = s(t['Trace fits']) || s(t['Trace identity']) || '';
    });
    return materials;
  }

  // ── Fleet register → fleet[] (unit allocation attributes) ─────────
  // Reads an equipment register (fleet_register_enriched.csv shape) into the
  // canonical fleet[] the viewer/app drill on: unit → type/make/model/year/engine.
  // Additive; the deterministic consumption/enrichment outputs are unaffected.
  function buildFleet(rows) {
    var out = [], seen = {};
    (rows || []).forEach(function (r) {
      var u = s(r['Unit'] || r['Sort Field']); if (!u || seen[u]) return; seen[u] = 1;
      out.push({
        unit: u,
        type: s(r['Type'] || r['Unit Type']),
        make: s(r['Make'] || r['Manufacturer']),
        model: s(r['Model']),
        year: s(r['Year']),
        engine: s(r['Engine (site data)'] || r['Engine']),
        floc: s(r['FunctLoc'] || r['Functional Location'])
      });
    });
    return out;
  }

  // ── Phase 3: verification merge (fold app capture bundles) ───────
  // A field capture sorts a duplicate family's members into piles (g: mn->pile).
  // Verdict is derived: one pile = SAME (merge), one pile per member = ALL_DIFFERENT,
  // anything between = SPLIT (partial merge).
  function verdictFromPiles(g) {
    var mns = Object.keys(g || {}), piles = {};
    mns.forEach(function (mn) { var p = String(g[mn]); (piles[p] = piles[p] || []).push(mn); });
    var np = Object.keys(piles).length;
    var verdict = np <= 1 ? 'SAME' : (np === mns.length ? 'ALL_DIFFERENT' : 'SPLIT');
    return { verdict: verdict, piles: piles, members: mns.length };
  }

  // Fold one or more exported capture bundles into dataset.verification[] and
  // annotate dataset.families (when present). Deterministic; returns a summary.
  // A bundle is the app's exported JSON: { tech, exported, captures:{ key: cap } }.
  function mergeVerification(dataset, bundles) {
    dataset = dataset || {};
    dataset.verification = dataset.verification || [];
    var list = Array.isArray(bundles) ? bundles : [bundles];
    var sum = { bundles: 0, captures: 0, families: 0, verdicts: { SAME: 0, SPLIT: 0, ALL_DIFFERENT: 0 }, provisional: 0, stages: {} };
    list.forEach(function (b) {
      if (!b || !b.captures) return;
      sum.bundles++;
      Object.keys(b.captures).forEach(function (key) {
        var c = b.captures[key]; sum.captures++;
        var mtc = key.match(/^s(\d+)([a-z]*):(.+)$/i);   // e.g. "s1f:F011", "s2:1008199"
        var stage = mtc ? mtc[1] : '?', id = mtc ? mtc[3] : key;
        sum.stages[stage] = (sum.stages[stage] || 0) + 1;
        var rec = {
          stage: stage, family_id: id, key: key,
          tech: b.tech || c.tech || '', ts: c.ts || b.exported || '',
          finding: c.finding || '', site_answer: c.sqA || '',
          notes: c.mnotes || {}, qoh: c.qoh || {}
        };
        if (c.g) {
          var v = verdictFromPiles(c.g);
          rec.verdict = v.verdict; rec.piles = v.piles; rec.members = v.members;
          rec.keep = c.keep || {}; rec.provisional = !!c.keepProvisional;
          rec.retire = [];   // in-stock members not chosen as keep within their pile
          Object.keys(v.piles).forEach(function (p) {
            var kept = rec.keep[p];
            v.piles[p].forEach(function (mn) { if (kept && mn !== kept) rec.retire.push(mn); });
          });
          if (sum.verdicts[v.verdict] != null) sum.verdicts[v.verdict]++;
          if (rec.provisional) sum.provisional++;
          sum.families++;
          if (dataset.families && dataset.families.find) {
            var fam = dataset.families.find(function (f) { return f.family_id === id; });
            if (fam) { fam.field_verdict = v.verdict; fam.field_keep = rec.keep; fam.field_retire = rec.retire; fam.field_provisional = rec.provisional; fam.field_tech = rec.tech; }
          }
        }
        dataset.verification.push(rec);
      });
    });
    return sum;
  }

  // ── Phase 4: removal scoreboard (duplicate_disposition) ──────────
  // From merged field verdicts (keep/retire) + consumption + on-hand, classify
  // each RETIRED sku and roll up the elimination KPI:
  //   eliminated    — on-hand 0: already gone from stock
  //   running_down  — on-hand > 0, no consumption in period: depletes cleanly (🟢)
  //   reorder_risk  — still consumed: only retire once demand moves to the keep sku (🔴)
  function buildScoreboard(dataset) {
    dataset = dataset || {};
    var byMn = {};
    (dataset.materials || []).forEach(function (m) { byMn[String(m.material)] = m; });
    function n(v) { var x = Number(v); return isNaN(x) ? 0 : x; }
    var rows = [], k = { families: 0, retireSkus: 0, eliminated: 0, runningDown: 0, reorderRisk: 0, onHandInRetire: 0, provisionalFamilies: 0 };
    (dataset.verification || []).forEach(function (v) {
      if (!v.retire || !v.retire.length) return;
      k.families++; if (v.provisional) k.provisionalFamilies++;
      var keep = v.keep ? Object.keys(v.keep).map(function (p) { return v.keep[p]; }) : [];
      v.retire.forEach(function (mn) {
        var m = byMn[mn] || {}, oh = n(m.on_hand), net = n(m.net_consumed), status;
        if (oh <= 0) { status = 'eliminated'; k.eliminated++; }
        else if (net > 0) { status = 'reorder_risk'; k.reorderRisk++; k.onHandInRetire += oh; }
        else { status = 'running_down'; k.runningDown++; k.onHandInRetire += oh; }
        k.retireSkus++;
        rows.push({ family_id: v.family_id, retire: mn, keep: keep, description: (m.description || ''), on_hand: oh, net_consumed: net, status: status, provisional: !!v.provisional });
      });
    });
    k.pctEliminated = k.retireSkus ? Math.round(100 * k.eliminated / k.retireSkus) : 0;
    dataset.duplicate_disposition = rows;
    dataset.scoreboard = k;
    return { rows: rows, kpi: k };
  }

  // ── Assessment overlay — fold the initial-assessment harness's per-material
  // categories (web dual-classification consensus) onto the SAP-desc audit result,
  // so upgrades PERSIST across every re-derive and flow to the viewer + app.
  // Precedence: analyst correction ('analyst-confirmed', manual) > assessment (web)
  // > SAP-desc audit. Rows: [{material, category, category_confidence[, category_reason]}]
  // or the harness export shape [{material, identity:{category, confidence}}].
  var CONF_RANK = { high: 3, med: 2, medium: 2, low: 1, none: 0, '': 0 };
  function applyAssessment(materials, rows) {
    if (!rows || !rows.length) return materials;
    var byMat = {};
    rows.forEach(function (r) { var mn = s(r.material || r.Material); if (mn) byMat[mn] = r; });
    (materials || []).forEach(function (m) {
      var a = byMat[s(m.material)]; if (!a) return;
      if (m.category_reason === 'analyst-confirmed') return;          // manual correction wins
      var acat = a.category != null && a.category !== '' ? a.category : (a.identity && a.identity.category);
      if (!acat) return;
      var aconf = String(a.category_confidence || (a.identity && a.identity.confidence) || '').toLowerCase();
      if (aconf === 'medium') aconf = 'med';
      var base = String(m.category_confidence || 'none').toLowerCase();
      if ((CONF_RANK[aconf] || 0) >= (CONF_RANK[base] || 0) || base === 'none' || base === 'low') {
        m.category = acat;
        m.category_confidence = aconf || m.category_confidence;
        m.category_reason = a.category_reason || 'assessment overlay';
      }
    });
    return materials;
  }

  // ── Phase 5: assemble the one canonical dataset (the shared contract) ──
  // Formalizes the computed pieces into a single versioned object the engine
  // emits, build_app.py packages, and the desktop viewer reads. Pure assembly.
  var SCHEMA_VERSION = '1.0.0';
  function assembleCanonical(dataset, meta) {
    dataset = dataset || {}; meta = meta || {};
    var mats = dataset.materials || [];
    // families ← field-verified verdicts (Phase 3)
    var families = (dataset.verification || []).filter(function (v) { return v.verdict; }).map(function (v) {
      var members = [];
      Object.keys(v.piles || {}).forEach(function (p) {
        (v.piles[p] || []).forEach(function (mn) {
          members.push({ material: mn, pile: p, keep: !!(v.keep && v.keep[p] === mn) });
        });
      });
      return {
        family_id: v.family_id, verdict: v.verdict, keep: v.keep || {}, retire: v.retire || [],
        provisional: !!v.provisional, tech: v.tech || '', ts: v.ts || '', site_answer: v.site_answer || '',
        members: members
      };
    });
    // disposition status back onto each material
    var dispBy = {};
    (dataset.duplicate_disposition || []).forEach(function (d) { dispBy[d.retire] = d.status; });
    var materials = mats.map(function (m) {
      var out = {}; Object.keys(m).forEach(function (k) { if (k.charAt(0) !== '_') out[k] = m[k]; });
      if (dispBy[m.material]) out.disposition = dispBy[m.material];
      return out;
    });
    // fold the initial-assessment harness's category upgrades onto the audit result,
    // so a re-derive PRESERVES them (they are an input, re-applied every run).
    if (dataset.assessment) applyAssessment(materials, dataset.assessment);
    var needs = materials.filter(function (m) { return m.identified === false; }).map(function (m) { return m.material; });
    // Auto-queue = LOW-confidence only, impact-sorted (net consumption then on-hand) —
    // the tail worth web-upgrading. 'none' items are NOT queued (they land in the
    // "Unclassified" bucket instead) so the inbox never floods with a whole-plant backlog.
    var categoryReview = materials
      .filter(function (m) { return m.category_confidence === 'low'; })
      .sort(function (a, b) { return (Number(b.net_consumed) || 0) - (Number(a.net_consumed) || 0) || (Number(b.on_hand) || 0) - (Number(a.on_hand) || 0); })
      .map(function (m) { return { material: m.material, description: m.description || '', category: m.category || '', confidence: m.category_confidence, reason: m.category_reason || '', net_consumed: m.net_consumed || 0, on_hand: (m.on_hand == null ? null : m.on_hand) }; });
    return {
      schemaVersion: SCHEMA_VERSION,
      meta: {
        tool: 'calibre-analysis-engine', generatedAt: meta.generatedAt || '',
        clientCode: meta.clientCode || '', site: meta.site || '',
        sourceFiles: meta.sourceFiles || {}, phase: meta.phase || 5, engineVersion: '0.7.1'
      },
      counts: {
        materials: materials.length, families: families.length,
        dispositions: (dataset.duplicate_disposition || []).length,
        verifications: (dataset.verification || []).length, needsIdentification: needs.length,
        units: (dataset.fleet || []).length, categoryReview: categoryReview.length
      },
      materials: materials,
      families: families,
      fleet: dataset.fleet || [],
      verification: dataset.verification || [],
      duplicate_disposition: dataset.duplicate_disposition || [],
      scoreboard: dataset.scoreboard || null,
      needs_identification: needs,
      category_review: categoryReview
    };
  }

  return {
    version: '0.7.1',
    s: s, round1: round1, postingMonth: postingMonth, numOrBlank: numOrBlank,
    indexIW39: indexIW39, derive: derive, consumedByFamily: consumedByFamily,
    indexBy: indexBy, enrich: enrich, buildFleet: buildFleet,
    classifyCategory: classifyCategory, categoryFor: categoryFor, applyAssessment: applyAssessment,
    verdictFromPiles: verdictFromPiles, mergeVerification: mergeVerification,
    buildScoreboard: buildScoreboard, assembleCanonical: assembleCanonical, SCHEMA_VERSION: SCHEMA_VERSION
  };
});
