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

  // ── Column contract (0.8.0) ─────────────────────────────────────────
  // SAP exports are matched by exact header text. A renamed column used to
  // yield an EMPTY-but-successful result; now it fails loudly, naming the gap.
  var COLS = {
    IW39: ['Order', 'Sort Field', 'Description'],
    MB51: ['Material', 'Movement Type', 'Order', 'Quantity', 'Posting Date'],
    INV:  ['Material', 'Material Description']          // stock col is OnHand OR Unrestricted (checked separately)
  };
  function assertColumns(rows, cols, label) {
    if (!rows || !rows.length) throw new Error(label + ': no rows');
    var have = Object.keys(rows[0] || {}), miss = cols.filter(function (c) { return have.indexOf(c) < 0; });
    if (miss.length) throw new Error(label + ': missing required column(s): ' + miss.join(', ') + ' — have: ' + have.slice(0, 10).join(' | '));
    return true;
  }

  // IW39 rows -> { woUnit[order]=unit, woDesc[order]=cleaned description }.
  // The WO description often repeats the unit as a prefix ("TT3103-..."); strip it.
  function indexIW39(rows) {
    assertColumns(rows, COLS.IW39, 'IW39');
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
    assertColumns(mb51Rows, COLS.MB51, 'MB51');
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
    if (hasInv) {   // one representative INV row must carry the expected headers + a stock column
      var sample = inv[Object.keys(inv)[0]];
      assertColumns([sample], COLS.INV, 'INV MSTR');
      if (!('OnHand' in sample) && !('Unrestricted' in sample)) throw new Error('INV MSTR: missing stock column (OnHand or Unrestricted)');
    }
    Object.keys(materials).forEach(function (mn) {
      var m = materials[mn], i = inv[mn] || {}, t = tr[mn] || {};
      var r = (opts.identityByMat || {})[mn];   // consolidated-register row (0.8.0), may be undefined
      // "identified" = present in the material master (INV MSTR). A consumed
      // material absent from the master is genuinely unknown → needs identification.
      if (hasInv) m.identified = !!inv[mn];
      // description: INV MSTR → traced register → consolidated register (so the
      // classifier below sees a description for seeded dead-stock parts too)
      m.description  = s(i['Material Description']) || s(t['Description']) || (r ? s(r['description']) : '') || '';
      m.pn           = s(i['Manufacturer Part No.']) || s(t['PN']) || '';
      // SAP INV MSTR exports name the stock column "Unrestricted"; older derived
      // CSVs used "OnHand". Accept both (0.8.0).
      m.onHand       = numOrBlank(i['OnHand'] !== undefined ? i['OnHand'] : i['Unrestricted']);
      m.mrpType      = s(i['MRP Type']);
      m.rop          = numOrBlank(i['Reorder Point']);
      m.max          = numOrBlank(i['Maximum Stock Level']);
      // unit cost (SAP moving average price, else standard price); 0 = not available
      m.unitCost     = (function () { var mp = numOrBlank(i['Moving price']), sp = numOrBlank(i['Standard price']); mp = (typeof mp === 'number') ? mp : 0; sp = (typeof sp === 'number') ? sp : 0; return mp > 0 ? mp : (sp > 0 ? sp : 0); })();
      m.tracedBrand  = s(t['Trace brand']);
      m.dupGroupId   = s(t['Duplicate group']);
      m.dupGroup     = s(t['Group label']);   // golden shows the human label, not the id
      // ── allocation fields (Fleet & Units drill) — additive ──
      // Category = the system-zone key: a master column ONLY if it names a real
      // system category, else keyword-classified from the description (app rules).
      // traced register → consolidated register (analyst/trace-confirmed) → INV Material Group
      var mcat       = s(t['Category']) || (r ? s(r['category']) : '') || s(i['Material Group']);
      if (CAT_SET[mcat]) { m.category = mcat; m.categoryConfidence = 'high'; m.categoryReason = 'master category'; }
      else { var cc = classifyCategory(m.description);
        // no keyword → a real "Unclassified" bucket (findable in Parts Mapping), NOT the review queue
        m.category = cc.category || 'Unclassified'; m.categoryConfidence = cc.confidence; m.categoryReason = cc.reason; }
      m.fits         = s(t['Trace fits']) || s(t['Trace identity']) || '';
      // ── identity fields from the consolidated register (additive, 0.8.0) ──
      // The register is SAP-MN keyed; columns: brand, oem_pn, crosses, fits,
      // duplicate_family, scope. Absent register → these stay undefined.
      if (r) {
        m.brand      = s(r['brand']);
        m.oemPn      = s(r['oem_pn']);
        m.crosses    = s(r['crosses']);
        m.dupFamily  = s(r['duplicate_family']);
        m.scope      = s(r['scope']);
        if (!m.fits) m.fits = s(r['fits']);
        if (!m.pn) m.pn = m.oemPn;
        if (!m.tracedBrand) m.tracedBrand = m.brand;
        if (!m.dupGroup) m.dupGroup = m.dupFamily;   // viewer reads duplicate_group
        // a register-listed part is a known part even if INV MSTR lacks a row
        if (m.identified !== true && (m.brand || m.oemPn)) m.identified = true;
      }
      // bin locations (0.8.1) — dynamic slot(s) the part sits in; only in-stock parts
      // appear in the bin extract, so a missing entry correctly means "no bin".
      var bn = (opts.binsByMat || {})[mn];
      if (bn && bn.length) m.bins = bn;
    });
    return materials;
  }

  // ── Bin locations (0.8.1) ───────────────────────────────────────────
  // SAP bin extract rows → { mn: ["MAIN · MW02C02", ...] }. Label = section · bin,
  // with the storage-type prefix only when it is not the main WHM1 warehouse
  // (ported from build_app.py so the canonical carries bins for app AND viewer).
  function buildBins(rows) {
    var out = {};
    (rows || []).forEach(function (r) {
      var mn = s(r['Product']); var b = s(r['Storage Bin']);
      if (!mn || !b) return;
      var st = s(r['Storage Type']); var sec = s(r['Storage Section']);
      var label = ((st === '' || st === 'WHM1') ? '' : st + ' ') + (sec ? sec + ' · ' : '') + b;
      label = label.trim();
      if (!out[mn]) out[mn] = [];
      if (out[mn].indexOf(label) < 0) out[mn].push(label);
    });
    return out;
  }

  // ── Register seeding (0.8.0) ────────────────────────────────────────
  // derive() only yields materials that MOVED. The fleet register also holds
  // parts that never moved (dead stock) — they must be visible too. Union the
  // register into the materials map as zero-consumption entries. Additive:
  // existing mover records are untouched.
  function seedRegister(materials, rows, keyCol) {
    materials = materials || {}; keyCol = keyCol || 'material';
    (rows || []).forEach(function (r) {
      var mn = s(r[keyCol]); if (!mn || materials[mn]) return;
      materials[mn] = { whereUsed: [], issPositive: 0, netAll: 0, _seeded: true };
    });
    return materials;   // callers count seeded parts via canonical `moved === false`
  }

  // ── Internal → canonical material mapping (0.8.0) ───────────────────
  // Previously lived in index.html (so every harness re-implemented it).
  // Owned by the engine now. includeNonMovers=true keeps zero-net (seeded /
  // fully-reversed) parts so dead stock stays visible; the engine UI's
  // historical behaviour is includeNonMovers=false.
  function toCanonicalMaterials(materials, opts) {
    opts = opts || {}; var inc = opts.includeNonMovers !== false;
    var out = [];
    Object.keys(materials).forEach(function (mn) {
      if (mn.charAt(0) === '_') return;
      var m = materials[mn]; if (!m || typeof m !== 'object') return;
      var net = round1(m.netAll || 0);
      if (!inc && net <= 0) return;
      var wu = (m.whereUsed || []);
      var o = {
        material: mn, description: m.description || '', pn: m.pn || '',
        net_consumed: net > 0 ? net : 0,
        on_hand: (m.onHand === '' || m.onHand == null) ? null : m.onHand,
        unit_cost: m.unitCost || 0,
        mrp_type: m.mrpType || '', rop: (m.rop === '' ? null : m.rop), max: (m.max === '' ? null : m.max),
        traced_brand: m.tracedBrand || '', duplicate_group: m.dupGroup || '',
        identified: m.identified === true,
        category: m.category || 'Unclassified', category_confidence: m.categoryConfidence || 'none',
        category_reason: m.categoryReason || '', fits: m.fits || '',
        where_used: net > 0 ? wu : [], consuming_units: net > 0 ? wu.length : 0,
        consumed_by_unit: net > 0 ? wu.map(function (w) { return w.unit + ': ' + w.qty; }).join('; ') : ''
      };
      // identity block (present only when a register was supplied)
      o.bin = m.bins || [];   // dynamic bin label(s), "as of" meta.binsAsOf; empty = zero-stock/no bin
      if (m.brand !== undefined) { o.brand = m.brand; o.oem_pn = m.oemPn; o.crosses = m.crosses;
        o.duplicate_family = m.dupFamily; o.scope = m.scope; }
      if (m._seeded) o.moved = false; else o.moved = net > 0;
      out.push(o);
    });
    out.sort(function (a, b) { return a.material < b.material ? -1 : a.material > b.material ? 1 : 0; });
    return out;
  }

  // ── Unit configuration: spec template + evidence (0.8.0) ────────────
  // Owner moved here from build_app.py so the canonical carries it and the
  // viewer/app read one source. Field keys are "<section>.<k>".
  function buildEquipSpec() {
    return {
      driveline: { label: 'Driveline', fields: [
        { k: 'tandem', label: 'Tandem axle series', opts: ['Meritor RT46-160', 'Spicer D46-170', 'Eaton-Spicer DS461', 'Single axle', 'Other'] },
        { k: 'ratio', label: 'Diff ratio (off diff tag)', opts: ['4.10', '4.30', '7.17', 'Other'] },
        { k: 'pto', label: 'PTO make', opts: ['Chelsea 270/271', 'Chelsea 272', 'Muncie', 'None', 'Other'] } ] },
      transmission: { label: 'Transmission', fields: [
        { k: 'trans', label: 'Make/model (dataplate)', opts: ['Fuller RTLO-18918B', 'Fuller RTLO-20918B', 'Allison 4500 RDS', 'Other'] } ] },
      axles: { label: 'Axle setup', fields: [
        { k: 'steer', label: 'Steer axle class', opts: ['Standard (Meritor MFS)', 'Marmon-Herrington AWD MT-22', 'Light 6-8K Intl double-drawkey', 'Other'] },
        { k: 'kingpin', label: 'King pin class', opts: ['Meritor MFS Type-B (1.999")', 'Light 1.359"', 'Unknown'] } ] },
      brakes: { label: 'Brake setup', fields: [
        { k: 'found', label: 'Foundation', opts: ['S-cam drum', 'ADB22X air disc'] },
        { k: 'shoes', label: 'Shoe system', opts: ['Meritor Q/Q+', 'Eaton ES/ES-II', 'Hendrickson HXS', 'n/a (disc)'] },
        { k: 'chambers', label: 'Chamber stroke', opts: ['Std 2.5"', 'Long 3.0"', 'Mixed'] },
        { k: 'slack', label: 'Slack arm length', opts: ['5.5"', '6"', '6.5"', 'Other'] },
        { k: 'dryer', label: 'Air dryer model', opts: ['Bendix AD-9', 'AD-IP/AD-IS', 'AD-9si', 'WABCO System Saver', 'SKF Brakemaster', 'Haldex PURest', 'Midland Aerofiner II', 'Other'] } ] },
      engine: { label: 'Engine', fields: [
        { k: 'serial', label: 'Serial prefix (dataplate)', opts: ['6NZ/9NZ (C15 single-turbo)', 'MXS (C15 ACERT)', 'BXS (C15 ACERT)', 'ISX', 'MX-13', 'DD15/16/S60', 'Other'] } ] },
      cab: { label: 'Cab / winter', fields: [
        { k: 'fired', label: 'Fired heater', opts: ['Webasto Thermo Top EVO', 'Webasto Air Top 2000ST', 'Espar Airtronic', 'None', 'Other'] },
        { k: 'block', label: 'Block heater fitted', opts: ['Yes', 'No', 'Unknown'] } ] },
      trailer: { label: 'Trailer systems', fields: [
        { k: 'abs', label: 'WABCO ABS config', opts: ['Basic 2S/1M (4005001010)', 'Enhanced 2S/2M (4005001020)', 'Other/Non-WABCO'] },
        { k: 'susp', label: 'Suspension family', opts: ['Neway AD-series', 'Hendrickson RS650', 'Hendrickson INTRAAX', 'Ridewell', 'Spring', 'Other'] },
        { k: 'gear', label: 'Landing gear', opts: ['Holland Mark V XA-S9-3A115', 'Holland Mark V XA-S9-4F115', 'Other'] },
        { k: 'spindle', label: 'Spindle family', opts: ['TN 6.000"', 'TP 6.008"', 'Unknown'] } ] }
    };
  }
  // Attach spec evidence to each fleet unit: spec = { v:{field:{o,n}}, h:{field:note} }
  // brakeRows = unit_brake_evidence.csv rows (Unit, Foundation brake inference,
  // Evidence (qty), Mixed-system flag). Engine evidence from the fleet engine string.
  function buildEquipEvidence(fleet, brakeRows) {
    var BRAKE = { 'Meritor': 'Meritor Q/Q+', 'Eaton': 'Eaton ES/ES-II', 'Hendrickson': 'Hendrickson HXS' };
    var ENG = [['ISX', 'ISX'], ['MX-13', 'MX-13'], ['MX13', 'MX-13'], ['DD15', 'DD15/16/S60'], ['DD16', 'DD15/16/S60'],
               ['DETROIT 60', 'DD15/16/S60'], ['S60', 'DD15/16/S60'], ['C15', '6NZ/9NZ (C15 single-turbo)'], ['6NZ', '6NZ/9NZ (C15 single-turbo)']];
    var ev = {};
    function V(u, f, o, n) { (ev[u] = ev[u] || { v: {}, h: {} }).v[f] = { o: o, n: n }; }
    function H(u, f, n) { (ev[u] = ev[u] || { v: {}, h: {} }).h[f] = n; }
    (brakeRows || []).forEach(function (r) {
      var u = s(r['Unit']); if (!u) return;
      var inf = s(r['Foundation brake inference']), q = s(r['Evidence (qty)']);
      if (s(r['Mixed-system flag'])) H(u, 'brakes.shoes', 'MIXED consumption evidence (' + q + ') — verify axle by axle');
      else if (BRAKE[inf]) { V(u, 'brakes.shoes', BRAKE[inf], 'work-order consumption: ' + q); V(u, 'brakes.found', 'S-cam drum', 'work-order consumption: ' + q); }
      else if (q) H(u, 'brakes.found', 'consumption evidence: ' + q);
    });
    (fleet || []).forEach(function (u) {
      var e = String(u.engine || '').toUpperCase();
      for (var i = 0; i < ENG.length; i++) { if (e.indexOf(ENG[i][0]) >= 0) { V(u.unit, 'engine.serial', ENG[i][1], 'fleet register engine: ' + u.engine); break; } }
      u.spec = ev[u.unit] || { v: {}, h: {} };
    });
    return ev;
  }

  // ── Planner build-specs → fleet[].build (0.8.5) ───────────────────
  // Attaches the planner's per-unit build spec (engine/transmission/diffs/cab/
  // chassis) to each matching fleet unit. Provenance scheme: a present value is
  // PLANNER input; an absent one stays unknown; field-verified overlays later
  // from device captures. Rows = unit_build_specs.csv (build_unit_specs.py).
  function buildUnitSpecs(fleet, specRows) {
    var by = {};
    (specRows || []).forEach(function (r) { var u = s(r.unit || r.Unit); if (u) by[u] = r; });
    var matched = 0;
    (fleet || []).forEach(function (u) {
      var r = by[u.unit]; if (!r) return;
      matched++;
      var diffs = [];
      [1, 2, 3].forEach(function (i) {
        var mk = s(r['diff' + i + '_make']), md = s(r['diff' + i + '_model']),
            rt = s(r['diff' + i + '_ratio']), sn = s(r['diff' + i + '_sn']);
        if (mk || md || rt || sn) diffs.push({ pos: i, make: mk, model: md, ratio: rt, sn: sn });
      });
      var b = {
        engine: { make: s(r.engine_make), model: s(r.engine_model), esn: s(r.esn) },
        transmission: { make: s(r.trans_make), model: s(r.trans_model), sn: s(r.trans_sn) },
        diffs: diffs,
        cab: s(r.cab), chassis: s(r.chassis), serial: s(r.serial), site: s(r.site),
        source: s(r.source) || 'planner', asOf: s(r.as_of)
      };
      // only attach when there is real content
      if (b.engine.make || b.engine.model || b.transmission.make || diffs.length || b.cab || b.chassis) {
        u.build = b;
        // strengthen the engine string used downstream (fleet lens + evidence) when the
        // register had none — planner engine make/model is authoritative build data.
        if (!s(u.engine) && (b.engine.make || b.engine.model)) u.engine = (b.engine.make + ' ' + b.engine.model).trim();
      }
    });
    return matched;
  }

  // ── Fleet register → fleet[] (unit allocation attributes) ─────────
  // Reads an equipment register (fleet_register_enriched.csv shape) into the
  // canonical fleet[] the viewer/app drill on: unit → type/make/model/year/engine.
  // Additive; the deterministic consumption/enrichment outputs are unaffected.
  // 0.9.0: FIRST BUILD with no fleet register yet — the units still exist in the work-order history.
  // Emit one bare record per consuming unit (type/make/model blank = unknown) so Equipment
  // Verification has a unit list and field capture can start; the analyst's fleet register
  // replaces these on a later refresh. Only used when no register rows were supplied.
  function fleetFromWhereUsed(materials) {
    var seen = {};
    (materials || []).forEach(function (m) { (m.where_used || []).forEach(function (w) { if (w && w.unit) seen[w.unit] = 1; }); });
    return Object.keys(seen).sort().map(function (u) {
      return { unit: u, type: '', make: '', model: '', year: '', engine: '', floc: '', source: 'where-used' };
    });
  }
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
  // 0.9.0: matches the field app exactly (app_template famPiles) — a member marked 'nf'
  // (not found on the shelf) or reclassified out of the family (cap.moved) is NOT a pile
  // and does not count toward the verdict. Previously 'nf' counted as its own pile, so the
  // engine could report SPLIT where the technician certified SAME.
  function verdictFromPiles(g, moved) {
    var mns = Object.keys(g || {}).filter(function (mn) { return String(g[mn]) !== 'nf' && !(moved && moved[mn]); });
    var piles = {};
    mns.forEach(function (mn) { var p = String(g[mn]); if (!p) return; (piles[p] = piles[p] || []).push(mn); });
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
          var v = verdictFromPiles(c.g, c.moved);
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
    dedupeVerification(dataset);
    return sum;
  }

  // 0.9.0: one record per capture key — the LATEST (by ts) wins. refresh carries the previous
  // verification[] forward and re-merges bundles, so without this every refresh duplicated rows
  // and the removal scoreboard double-counted. Idempotent; safe to call on already-clean data.
  function dedupeVerification(dataset) {
    var best = {}, order = [];
    (dataset.verification || []).forEach(function (r) {
      var k = r.key || (r.stage + ':' + r.family_id);
      if (!best[k]) { order.push(k); best[k] = r; return; }
      if (String(r.ts || '') >= String(best[k].ts || '')) best[k] = r;
    });
    var before = (dataset.verification || []).length;
    dataset.verification = order.map(function (k) { return best[k]; });
    return before - dataset.verification.length;
  }

  // 0.9.0: fold the NON-verdict field capture into the canonical, so what a technician records
  // at the machine reaches the planner (viewer) and the other tablets (app):
  //   field_equipment[uid] — component serial/note (comp), non-listed accessories (acc), the
  //                          equipment-verification answers (fields) and confirmed build items (bok)
  //   sap_flags[]          — per-material SAP data-issue flags (tags + note)
  //   field_sources[]      — provenance: which bundle (client/device/operator/time) contributed what
  // Latest write wins per unit-component / accessory id / flag id. Photos stay OUT of the canonical
  // (binary) — the viewer pack externalises them; photo ids are keyed the same way.
  function mergeFieldCapture(dataset, bundles) {
    var eq = {}, flags = {}, srcs = (dataset.field_sources || []).slice();
    Object.keys(dataset.field_equipment || {}).forEach(function (uid) {   // carried-forward shape: acc[] → map by id
      var p = dataset.field_equipment[uid] || {}, am = {};
      (Array.isArray(p.acc) ? p.acc : Object.keys(p.acc || {}).map(function (k) { return p.acc[k]; })).forEach(function (a) { if (a && a.id) am[a.id] = a; });
      eq[uid] = { comp: Object.assign({}, p.comp || {}), acc: am, fields: Object.assign({}, p.fields || {}), bok: Object.assign({}, p.bok || {}) };
    });
    (dataset.sap_flags || []).forEach(function (f) { flags[f.material + '|' + f.id] = f; });
    var list = Array.isArray(bundles) ? bundles : [bundles];
    list.forEach(function (b) {
      if (!b) return;
      var who = { tech: b.tech || '', device: b.device || '', client: b.client || '', ts: b.exported || '' };
      var nEq = 0, nFlag = 0;
      Object.keys(b.equip || {}).forEach(function (uid) {
        var r = b.equip[uid] || {}, u = eq[uid] || (eq[uid] = { comp: {}, acc: {}, fields: {}, bok: {} });
        var ts = r._ts || who.ts;
        Object.keys(r.comp || {}).forEach(function (k) {
          var c = r.comp[k] || {}; if (!((c.sn || '').trim() || (c.note || '').trim())) return;
          var cur = u.comp[k]; if (cur && String(cur.ts || '') > String(ts || '')) return;
          u.comp[k] = { sn: c.sn || '', note: c.note || '', tech: who.tech, device: who.device, ts: ts }; nEq++;
        });
        (r.acc || []).forEach(function (a) {
          if (!a || !a.id || !((a.name || '').trim() || (a.desc || '').trim())) return;
          var cur = u.acc[a.id]; if (cur && String(cur.ts || '') > String(ts || '')) return;
          u.acc[a.id] = { id: a.id, name: a.name || '', desc: a.desc || '', sn: a.sn || '', note: a.note || '', tech: who.tech, device: who.device, ts: ts }; nEq++;
        });
        Object.keys(r).forEach(function (k) {
          if (k.indexOf('.') > 0 && typeof r[k] === 'string' && r[k]) { u.fields[k] = { v: r[k], tech: who.tech, device: who.device, ts: ts }; nEq++; }
        });
        Object.keys(r.bok || {}).forEach(function (k) { if (r.bok[k]) { u.bok[k] = { tech: who.tech, device: who.device, ts: ts }; nEq++; } });
      });
      Object.keys(b.sapFlags || {}).forEach(function (mnk) {
        (b.sapFlags[mnk] || []).forEach(function (f) {
          if (!f) return; var id = f.id || f.ts || '';
          flags[mnk + '|' + id] = { material: String(mnk), id: id, tags: f.tags || [], note: f.note || '', photos: f.nph || 0, tech: f.tech || who.tech, device: who.device, ts: f.ts || who.ts };
          nFlag++;
        });
      });
      srcs.push({ file: b._file || '', client: who.client, device: who.device, tech: who.tech, exported: who.ts,
        captures: Object.keys(b.captures || {}).length, equipItems: nEq, sapFlags: nFlag, photos: (b.photos || []).length });
    });
    // flatten accessories to arrays; drop empty units
    var out = {};
    Object.keys(eq).forEach(function (uid) {
      var u = eq[uid], acc = Object.keys(u.acc || {}).map(function (k) { return u.acc[k]; });
      if (!Object.keys(u.comp || {}).length && !acc.length && !Object.keys(u.fields || {}).length && !Object.keys(u.bok || {}).length) return;
      out[uid] = { comp: u.comp || {}, acc: acc, fields: u.fields || {}, bok: u.bok || {} };
    });
    // de-dupe sources by file+exported (a bundle folded twice is still one source)
    var seen = {}; srcs = srcs.filter(function (s) { var k = s.file + '|' + s.exported + '|' + s.device; return seen[k] ? false : (seen[k] = 1, true); });
    dataset.field_equipment = out;
    dataset.sap_flags = Object.keys(flags).map(function (k) { return flags[k]; });
    dataset.field_sources = srcs;
    return { units: Object.keys(out).length, sapFlags: dataset.sap_flags.length, sources: srcs.length };
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
  // 0.9.0 guards: an assessment only upgrades — it never downgrades. Rows with no real category
  // ('Unclassified'/blank) or LOW/none confidence are ignored (the harness emits ~1.5k such rows;
  // applied naively they would overwrite the engine's own SAP-desc classification with
  // "Unclassified"). A HIGH-confidence identity also fills a BLANK brand / OEM part number
  // (never overwrites a register/trace value), tagged identity_source:'assessment'.
  // Accepts [{material, category, category_confidence}] or the harness export rows
  // [{material, identity:{category, confidence, oem, part_no}}]. Returns a change summary.
  function applyAssessment(materials, rows) {
    var sum = { rows: (rows || []).length, eligible: 0, category: 0, brand: 0, oem_pn: 0 };
    if (!rows || !rows.length) return sum;
    var byMat = {};
    rows.forEach(function (r) { var mn = s(r.material || r.Material); if (mn) byMat[mn] = r; });
    (materials || []).forEach(function (m) {
      var a = byMat[s(m.material)]; if (!a) return;
      var id = a.identity || {};
      var acat = a.category != null && a.category !== '' ? a.category : id.category;
      var aconf = String(a.category_confidence || id.confidence || '').toLowerCase();
      if (aconf === 'medium') aconf = 'med';
      if ((CONF_RANK[aconf] || 0) < 2) return;                                  // High/Med only
      sum.eligible++;
      if (acat && !/^unclassified$/i.test(acat) && m.category_reason !== 'analyst-confirmed') {   // manual correction wins
        var base = String(m.category_confidence || 'none').toLowerCase();
        if ((CONF_RANK[aconf] || 0) >= (CONF_RANK[base] || 0) || base === 'none' || base === 'low') {
          if (m.category !== acat) sum.category++;
          m.category = acat;
          m.category_confidence = aconf;
          m.category_reason = a.category_reason || 'assessment overlay';
        }
      }
      if (aconf === 'high') {
        if (!m.brand && id.oem) { m.brand = id.oem; m.identity_source = 'assessment'; sum.brand++; }
        if (!m.oem_pn && id.part_no) { m.oem_pn = id.part_no; m.identity_source = 'assessment'; sum.oem_pn++; }
      }
    });
    return sum;
  }

  // ── Phase 5: assemble the one canonical dataset (the shared contract) ──
  // Formalizes the computed pieces into a single versioned object the engine
  // emits, build_app.py packages, and the desktop viewer reads. Pure assembly.
  // 1.1.0 (2026-09-21, additive): materials may carry brand/oem_pn/crosses/
  // duplicate_family/scope/moved; fleet[] may carry spec{v,h}; top-level equipSpec.
  // 1.2.0 (2026-09-24, additive): field_equipment{}, sap_flags[], field_sources[]; materials may carry
  // identity_source; meta.assessment {source, rows, eligible, category, brand, oem_pn}; meta.drop.
  var SCHEMA_VERSION = '1.2.0';
  var ENGINE_VERSION = '0.9.0';
  function assembleCanonical(dataset, meta) {
    dataset = dataset || {}; meta = meta || {};
    var mats = dataset.materials || [];
    // ── fleet tag (roadmap: engine-emitted from where-used unit types + register scope; retires mat_fleet.json) ──
    // where-used is authoritative (Tractor→TT, Trailer→TL, both→TT&TL); else the register scope
    // (tractor-trailer → provisional TT&TL pending re-scope; light-vehicle / greater-fleet → Other; unknown → Other).
    var unitType = {}; (dataset.fleet || []).forEach(function (u) { if (u && u.unit) unitType[u.unit] = u.type; });
    // ── served config sets (0.8.6) — the engine/trans/axle/ratio models a part has been consumed
    // against, rolled up from its where-used units' build specs. Basis for the fit ladder AND (0.8.7)
    // for refining the provisional fleet tag with served/category context.
    var _normC = function (s) { return String(s || '').toUpperCase().replace(/\s+/g, ' ').trim(); };
    var buildBy = {}; (dataset.fleet || []).forEach(function (u) { if (u && u.build) buildBy[u.unit] = u.build; });
    function unitDims(b) {
      var eng = _normC((b.engine && (b.engine.make + ' ' + b.engine.model)) || '');
      var trans = _normC((b.transmission && (b.transmission.make + ' ' + b.transmission.model)) || '');
      var axle = {}, ratio = {};
      (b.diffs || []).forEach(function (d) { var a = _normC((d.make || '') + ' ' + (d.model || '')); if (a) axle[a] = 1; if (d.ratio) ratio[_normC(d.ratio)] = 1; });
      return { eng: eng, trans: trans, axle: Object.keys(axle), ratio: Object.keys(ratio) };
    }
    var servedBy = {};
    mats.forEach(function (m) {
      var eng = {}, trans = {}, axle = {}, ratio = {};
      (m.where_used || []).forEach(function (w) {
        var b = buildBy[w.unit]; if (!b) return; var d = unitDims(b);
        if (d.eng) eng[d.eng] = 1; if (d.trans) trans[d.trans] = 1;
        d.axle.forEach(function (a) { axle[a] = 1; }); d.ratio.forEach(function (r) { ratio[r] = 1; });
      });
      var s = { eng: Object.keys(eng), trans: Object.keys(trans), axle: Object.keys(axle), ratio: Object.keys(ratio) };
      if (s.eng.length || s.trans.length || s.axle.length || s.ratio.length) servedBy[m.material] = s;
    });
    // power-unit-only systems — present on the tractor, ABSENT on trailers (no engine, no cab).
    // A provisional TT&TL part in one of these is really TT.
    var POWER_UNIT_CATS = { 'Engine & emissions': 1, 'Charging & starting': 1, 'Cab & body': 1 };
    function fleetOf(m) {
      var tr = false, tl = false;
      (m.where_used || []).forEach(function (w) { var t = unitType[w.unit]; if (t === 'Tractor') tr = true; else if (t === 'Trailer') tl = true; });
      if (tr && tl) return ['TT&TL', 'where-used'];
      if (tr) return ['TT', 'where-used'];
      if (tl) return ['TL', 'where-used'];
      var sc = m.scope || '';
      if (sc === 'tractor-trailer') {
        // 0.8.7 — refine the provisional TT&TL with served/category context (deterministic, no LLM):
        // engine/transmission evidence (served) OR a power-unit-only category ⇒ power unit ⇒ TT.
        var sv = servedBy[m.material];
        var powerUnit = (sv && ((sv.eng || []).length || (sv.trans || []).length)) || POWER_UNIT_CATS[m.category];
        return powerUnit ? ['TT', 'served-config'] : ['TT&TL', 'scope-provisional'];
      }
      if (sc === 'light-vehicle' || sc === 'greater-fleet') return ['Other', 'scope'];
      return ['Other', 'unknown'];
    }
    var matFleet = {}; mats.forEach(function (m) { matFleet[m.material] = fleetOf(m); });
    function famFleetUnion(mns) {
      var tr = false, tl = false, any = false;
      mns.forEach(function (mn) { var f = matFleet[mn]; if (!f || f[0] === 'Other') return; any = true;
        if (f[0] === 'TT' || f[0] === 'TT&TL') tr = true; if (f[0] === 'TL' || f[0] === 'TT&TL') tl = true; });
      if (tr && tl) return 'TT&TL'; if (tr) return 'TT'; if (tl) return 'TL'; return any ? 'TT&TL' : 'Other';
    }
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
        members: members, source: 'field'
      };
    });
    // research candidate families (assessment-tool adjudicator) fold in UNDER the
    // field-verified verdicts: the bench governs. A research family is suppressed if
    // ANY of its members already appears in a field-verified family (member-based
    // precedence — research fills the not-yet-verified gap, never contradicts the bench).
    // dedupe field families by family_id — dataset.verification[] can carry the same
    // family twice when a capture bundle was folded more than once; keep the first.
    (function () { var seen = {}; families = families.filter(function (f) { return seen[f.family_id] ? false : (seen[f.family_id] = 1, true); }); })();
    // attach catalogue display metadata (part/skus/combined_oh/cert/fleet/unsure/site_q) to the
    // field families too, so canonical.families is the COMPLETE family source for BOTH app + viewer
    // (build_app.py reads it instead of re-parsing duplicate_families.csv / fam_verified / fam_extra).
    var catMeta = {}; (dataset.catalogue_families || []).forEach(function (cf) { if (cf && cf.family_id) catMeta[cf.family_id] = cf; });
    families.forEach(function (f) {
      var cm = catMeta[f.family_id]; if (!cm) return;
      f.part = cm.part || f.part || ''; f.skus = cm.skus || ''; f.combined_oh = cm.combined_oh || '';
      f.cert = cm.cert || ''; f.fleet = cm.fleet || ''; f.unsure = cm.unsure || []; f.site_q = cm.site_q || '';
      if (!f.site_answer && cm.note) f.site_answer = cm.note;
    });
    var fieldMembers = {};
    families.forEach(function (f) { (f.members || []).forEach(function (m) { fieldMembers[m.material] = 1; }); });
    (dataset.research_families || []).forEach(function (rf) {
      if (!rf || !rf.verdict) return;
      var mems = rf.members || [];
      if (mems.some(function (m) { return fieldMembers[m.material]; })) return;   // bench wins
      families.push({
        family_id: rf.family_id, verdict: rf.verdict,
        keep: rf.canonical_mat_id ? { '1': rf.canonical_mat_id } : {},
        retire: mems.filter(function (m) { return !m.keep; }).map(function (m) { return m.material; }),
        provisional: true, tech: '', ts: '', site_answer: rf.reasoning || '',
        rating_questions: rf.rating_questions || [], members: mems, source: 'research'
      });
    });
    // catalogue duplicate families (Analysis/duplicate_families.csv + fam_verified.json +
    // fam_extra.json, parsed by refresh.js into dataset.catalogue_families) fold in UNDER
    // field + research: bench/desk-capture win. Skipped when the family_id is already present
    // or any member already sits in a higher-precedence family. They carry a verdict + cert
    // but NO per-member survivor (desk level), so members are emitted without keep/pile and
    // the family is flagged source:'catalogue' for the consumers to render as a candidate.
    var haveFam = {}; families.forEach(function (f) { haveFam[f.family_id] = 1; });
    (dataset.catalogue_families || []).forEach(function (cf) {
      if (!cf || !cf.family_id || haveFam[cf.family_id]) return;
      var mems = cf.members || [];
      if (mems.some(function (m) { return fieldMembers[m.material]; })) return;
      families.push({
        family_id: cf.family_id, verdict: cf.verdict || '', keep: {}, retire: [],
        provisional: true, tech: '', ts: cf.cert || '', site_answer: cf.note || '',
        members: mems.map(function (m) { return { material: String(m.material), keep: false }; }),
        part: cf.part || '', skus: cf.skus || '', combined_oh: cf.combined_oh || '', cert: cf.cert || '',
        fleet: cf.fleet || '', unsure: cf.unsure || [], site_q: cf.site_q || '',
        action: cf.action || '', source: 'catalogue'
      });
      haveFam[cf.family_id] = 1;
    });
    // fleet tag per family = union of its members' fleet (data-driven; overrides the fam_verified hint when members give a signal)
    families.forEach(function (f) { var ff = famFleetUnion((f.members || []).map(function (m) { return m.material; })); if (ff !== 'Other') f.fleet = ff; });
    // (servedBy computed above, before the fleet tag, so fleetOf can use served context)
    // disposition status back onto each material
    var dispBy = {};
    (dataset.duplicate_disposition || []).forEach(function (d) { dispBy[d.retire] = d.status; });
    var materials = mats.map(function (m) {
      var out = {}; Object.keys(m).forEach(function (k) { if (k.charAt(0) !== '_') out[k] = m[k]; });
      if (dispBy[m.material]) out.disposition = dispBy[m.material];
      var ft = matFleet[m.material] || ['Other', 'unknown']; out.fleet = ft[0]; out.fleet_basis = ft[1];
      if (servedBy[m.material]) out.served = servedBy[m.material];
      return out;
    });
    // fold the initial-assessment harness's category upgrades onto the audit result,
    // so a re-derive PRESERVES them (they are an input, re-applied every run).
    var asum = dataset.assessment ? applyAssessment(materials, dataset.assessment) : null;
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
        sourceFiles: meta.sourceFiles || {}, phase: meta.phase || 5, engineVersion: ENGINE_VERSION,
        binsAsOf: meta.binsAsOf || '', drop: meta.drop || '',
        assessment: asum ? { source: (meta.sourceFiles || {}).assessment || '', rows: asum.rows, eligible: asum.eligible,
          category: asum.category, brand: asum.brand, oem_pn: asum.oem_pn } : null
      },
      counts: {
        materials: materials.length, families: families.length,
        dispositions: (dataset.duplicate_disposition || []).length,
        verifications: (dataset.verification || []).length, needsIdentification: needs.length,
        units: (dataset.fleet || []).length, categoryReview: categoryReview.length,
        movers: materials.filter(function (m) { return (m.net_consumed || 0) > 0; }).length,
        zeroStock: materials.filter(function (m) { return !(m.on_hand > 0); }).length,
        unitsWithSpecEvidence: (dataset.fleet || []).filter(function (u) { return u.spec && (Object.keys(u.spec.v || {}).length || Object.keys(u.spec.h || {}).length); }).length,
        unitsWithFieldCapture: Object.keys(dataset.field_equipment || {}).length,
        sapFlags: (dataset.sap_flags || []).length, fieldSources: (dataset.field_sources || []).length
      },
      materials: materials,
      families: families,
      fleet: dataset.fleet || [],
      equipSpec: dataset.equipSpec || undefined,
      verification: dataset.verification || [],
      duplicate_disposition: dataset.duplicate_disposition || [],
      scoreboard: dataset.scoreboard || null,
      needs_identification: needs,
      category_review: categoryReview,
      field_equipment: dataset.field_equipment || {},
      sap_flags: dataset.sap_flags || [],
      field_sources: dataset.field_sources || []
    };
  }

  return {
    version: ENGINE_VERSION,
    s: s, round1: round1, postingMonth: postingMonth, numOrBlank: numOrBlank,
    indexIW39: indexIW39, derive: derive, consumedByFamily: consumedByFamily,
    indexBy: indexBy, enrich: enrich, buildFleet: buildFleet, fleetFromWhereUsed: fleetFromWhereUsed,
    // 0.8.0 additions — column contract, register seeding, canonical mapping, unit configuration
    assertColumns: assertColumns, COLS: COLS,
    seedRegister: seedRegister, toCanonicalMaterials: toCanonicalMaterials, buildBins: buildBins,
    buildEquipSpec: buildEquipSpec, buildEquipEvidence: buildEquipEvidence, buildUnitSpecs: buildUnitSpecs,
    classifyCategory: classifyCategory, applyAssessment: applyAssessment,
    verdictFromPiles: verdictFromPiles, mergeVerification: mergeVerification,
    dedupeVerification: dedupeVerification, mergeFieldCapture: mergeFieldCapture,
    buildScoreboard: buildScoreboard, assembleCanonical: assembleCanonical, SCHEMA_VERSION: SCHEMA_VERSION
  };
});
