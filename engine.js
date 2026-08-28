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
    });
    return materials;
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
    var needs = materials.filter(function (m) { return m.identified === false; }).map(function (m) { return m.material; });
    return {
      schemaVersion: SCHEMA_VERSION,
      meta: {
        tool: 'calibre-analysis-engine', generatedAt: meta.generatedAt || '',
        clientCode: meta.clientCode || '', site: meta.site || '',
        sourceFiles: meta.sourceFiles || {}, phase: meta.phase || 5, engineVersion: '0.5.0'
      },
      counts: {
        materials: materials.length, families: families.length,
        dispositions: (dataset.duplicate_disposition || []).length,
        verifications: (dataset.verification || []).length, needsIdentification: needs.length
      },
      materials: materials,
      families: families,
      verification: dataset.verification || [],
      duplicate_disposition: dataset.duplicate_disposition || [],
      scoreboard: dataset.scoreboard || null,
      needs_identification: needs
    };
  }

  return {
    version: '0.5.0',
    s: s, round1: round1, postingMonth: postingMonth, numOrBlank: numOrBlank,
    indexIW39: indexIW39, derive: derive, consumedByFamily: consumedByFamily,
    indexBy: indexBy, enrich: enrich,
    verdictFromPiles: verdictFromPiles, mergeVerification: mergeVerification,
    buildScoreboard: buildScoreboard, assembleCanonical: assembleCanonical, SCHEMA_VERSION: SCHEMA_VERSION
  };
});
