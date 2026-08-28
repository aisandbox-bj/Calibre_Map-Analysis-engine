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
    Object.keys(materials).forEach(function (mn) {
      var m = materials[mn], i = inv[mn] || {}, t = tr[mn] || {};
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

  return {
    version: '0.2.0',
    s: s, round1: round1, postingMonth: postingMonth, numOrBlank: numOrBlank,
    indexIW39: indexIW39, derive: derive, consumedByFamily: consumedByFamily,
    indexBy: indexBy, enrich: enrich
  };
});
