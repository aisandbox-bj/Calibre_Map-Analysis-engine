/**
 * numacore_lib.js — NumaCore Lens Suite shared helpers
 *
 * Loaded by all four suite tools via <script src="numacore_lib.js"></script>.
 * Exposes a single global: window.NumaCoreLib
 *
 * No external dependencies, no build step. Works on file:// and https
 * (GitHub Pages production deployment + standalone disk runs).
 *
 * Lifted from existing tool implementations:
 *   esc()         — Intake v7.5:761
 *   parseDate()   — Intake v7.5:771
 *   fmtDate()     — synthesised from CPT v17:1652-1660
 *   scopedKey()   — CPT v17:1219 (getSaveKey pattern)
 *   showToast()   — CPT v17:2299 (extended with severity)
 *   loadFleetFile()— synthesised from CPT:6136 + Deploy:1033 + Lens:3596
 *
 * Version 1.5.1 — Lens v4.3.6 FIX-1: showToast bottom position raised
 *   24px → 70px so it clears Lens's #legend pill (bottom:14px, right:18px).
 *   Suite-wide visual change — every tool's toast now appears slightly higher
 *   on screen. Operator-discovered 2026-05-13 during v4.3.6 reload-survival
 *   test: the new restored-autosave toast was being visually camouflaged by
 *   the legend (similar dark palette + overlapping bottom band). No API
 *   change — internal CSS only.
 * Version 1.5.0 — Deploy v8.9 adds VPN normalisation for cross-referencing
 *   dealer-provided part numbers against Inventory Master + Component
 *   Snapshot cross-reference data:
 *     normaliseVPN(s) — strips all hyphens EXCEPT the "-EXC" suffix that
 *     identifies exchange-type variants. Operator-locked rule (2026-05-11):
 *     "3723563-EXC" → "3723563-EXC" (preserved)
 *     "123-4567"   → "1234567" (interior hyphen stripped)
 *     "XYZ-ABC-EXC" → "XYZABC-EXC" (interior stripped, EXC suffix kept)
 *   Trims + uppercases. Empty / N/A inputs return ''.
 * Version 1.4.0 — Chunk 5 (Slide 6) adds cross-tool category vocabulary
 *   unification + cross-tool Sort Field CAPS rule:
 *     canonicalCategory, categoryLabel, categoryColor, CATEGORY_SYNONYMS,
 *     normaliseSortField.
 *   Canonical set: engine, drivetrain, geared_drives, drill_rotary,
 *   hydraulics, cylinders, undercarriage, attachments, misc.
 *   Legacy aliases tracks→undercarriage and drill_swing→drill_rotary are
 *   normalised at read time so cross-tool data stays consistent regardless
 *   of which tool wrote it.
 * Version 1.3.0 — Chunk 3 (Slide 8) adds per-client settings helpers:
 *   getClientSettings, getClientTZ, fmtMoney, fmtTime + DEFAULT_CURRENCY +
 *   DEFAULT_LOCALE. Defaults are CAD / America/Edmonton / en-CA. Settings
 *   live at masterData.clientSettings; missing fields fall through to defaults.
 * Version 1.2.0 — Chunk 11 adds save-filename helper
 *   (buildSaveFilename) for cross-tool consistency.
 * Version 1.1.0 — Chunk 2 adds V5 migration helpers
 *   (makeComponentId, validateFleetJSON_v5, migrateV4FlatToV5).
 * Version 1.0.0 — Chunk 1 baseline (six helpers).
 */
(function () {
  'use strict';

  var VERSION = '1.5.1';
  var DEFAULT_TZ = 'America/Edmonton';   // Mountain Time (Canada)
  var DEFAULT_CURRENCY = 'CAD';          // Canadian dollar — Chunk 3 (Slide 8) operator decision 2026-05-10
  var DEFAULT_LOCALE = 'en-CA';          // Canadian English — Chunk 3 (Slide 8) operator decision 2026-05-10

  // ─────────────────────────────────────────────────────────────
  // HTML ESCAPE
  // ─────────────────────────────────────────────────────────────
  /**
   * Escape a value for safe innerHTML interpolation.
   * Handles null/undefined gracefully (returns empty string).
   * Escapes the five XML-special characters plus single quote.
   */
  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─────────────────────────────────────────────────────────────
  // DATE PARSING
  // ─────────────────────────────────────────────────────────────
  /**
   * Parse a value of any common origin into an ISO date string (YYYY-MM-DD).
   * Handles ISO strings, Excel serial numbers, JS Date objects.
   * Returns null if unparseable.
   */
  function parseDate(val) {
    if (val == null || val === '') return null;
    if (val instanceof Date) {
      if (isNaN(val)) return null;
      return val.toISOString().split('T')[0];
    }
    if (typeof val === 'number') {
      // Excel serial date — origin 1900-01-01, offset 25569 days from Unix epoch
      var d = new Date(Math.round((val - 25569) * 86400 * 1000));
      if (isNaN(d)) return null;
      return d.toISOString().split('T')[0];
    }
    if (typeof val === 'string') {
      var s = val.trim();
      if (!s) return null;
      var dd = new Date(s);
      if (!isNaN(dd)) return dd.toISOString().split('T')[0];
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // DATE FORMATTING
  // ─────────────────────────────────────────────────────────────
  /**
   * Format an ISO date string for display.
   * Format options:
   *   'iso'       (default) — returns the input as-is (YYYY-MM-DD)
   *   'short'     — "Jan 5, 2026"
   *   'monthYear' — "Jan 26"
   *   'long'      — "January 5, 2026"
   * Timezone-aware via DEFAULT_TZ ('America/Edmonton' / Mountain).
   */
  function fmtDate(s, format) {
    if (!s) return '';
    format = format || 'iso';
    if (format === 'iso') return String(s).slice(0, 10);

    var d = (s instanceof Date) ? s : new Date(String(s).slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return '';

    var opts = { timeZone: DEFAULT_TZ };
    if (format === 'short') {
      opts.year = 'numeric'; opts.month = 'short'; opts.day = 'numeric';
    } else if (format === 'monthYear') {
      opts.year = '2-digit'; opts.month = 'short';
    } else if (format === 'long') {
      opts.year = 'numeric'; opts.month = 'long'; opts.day = 'numeric';
    } else {
      opts.year = 'numeric'; opts.month = 'short';
    }
    return d.toLocaleDateString('en-CA', opts);
  }

  // ─────────────────────────────────────────────────────────────
  // SCOPED LOCALSTORAGE KEY
  // ─────────────────────────────────────────────────────────────
  /**
   * Build a localStorage key scoped to a clientCode.
   * Pattern: <prefix>_<sanitised_clientCode>.
   * Sanitises clientCode by replacing non-alphanumeric/underscore with '_'.
   * Used by Cadence autosave, Intake state persistence, Deploy autosave.
   */
  function scopedKey(prefix, clientCode) {
    var code = String(clientCode || 'default').replace(/[^A-Z0-9_]/gi, '_');
    return prefix + '_' + code;
  }

  // ─────────────────────────────────────────────────────────────
  // TOAST NOTIFICATIONS
  // ─────────────────────────────────────────────────────────────
  var _toastTimer = null;
  var _toastEl = null;

  /**
   * Show a transient toast notification.
   * Severity: 'info' (default) | 'success' | 'warn' | 'error'.
   * Default duration: 2800 ms.
   * Auto-creates the toast container on first call. Idempotent.
   */
  function showToast(msg, severity, durationMs) {
    severity = severity || 'info';
    durationMs = durationMs || 2800;

    if (!_toastEl) {
      _toastEl = document.createElement('div');
      _toastEl.id = '_numacoreToast';
      // v1.5.1 — bottom raised 24px → 70px so the toast clears Lens's #legend
      // pill (bottom:14px, top edge ~39px from screen bottom). Same dark-on-dark
      // palette + overlapping bottom-band caused the v4.3.6 restored-autosave
      // toast to be visually camouflaged by the legend on the operator's first
      // live test. 70px leaves a 31px gap above the legend's top edge at rest;
      // entry/exit slide animations (translateY 20→0→10) stay clear.
      _toastEl.style.cssText = [
        'position:fixed',
        'bottom:70px',
        'left:50%',
        'transform:translateX(-50%) translateY(20px)',
        'padding:10px 18px',
        'border-radius:8px',
        'font-size:12px',
        'font-weight:500',
        'color:#e6edf3',
        'box-shadow:0 4px 20px rgba(0,0,0,0.6)',
        'z-index:9999',
        'opacity:0',
        'transition:opacity 0.2s, transform 0.2s',
        'pointer-events:none',
        'max-width:420px',
        'text-align:center',
        'font-family:"Segoe UI",system-ui,sans-serif',
        'line-height:1.45'
      ].join(';');
      document.body.appendChild(_toastEl);
    }

    var sevStyles = {
      info:    { bg: '#21262d', border: '#30363d' },
      success: { bg: '#1b3a2a', border: '#2ea043' },
      warn:    { bg: '#3a2a1b', border: '#d29922' },
      error:   { bg: '#3a1b1b', border: '#f85149' }
    };
    var sty = sevStyles[severity] || sevStyles.info;
    _toastEl.style.background = sty.bg;
    _toastEl.style.border = '1px solid ' + sty.border;

    _toastEl.textContent = msg;
    _toastEl.style.opacity = '1';
    _toastEl.style.transform = 'translateX(-50%) translateY(0)';

    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () {
      if (_toastEl) {
        _toastEl.style.opacity = '0';
        _toastEl.style.transform = 'translateX(-50%) translateY(10px)';
      }
    }, durationMs);
  }

  // ─────────────────────────────────────────────────────────────
  // FLEET FILE LOAD
  // ─────────────────────────────────────────────────────────────
  /**
   * Load a fleet JSON file via FileReader. Validates extension and parses.
   * Calls onSuccess(json, filename) on success.
   * Calls onError(message) on failure (wrong extension, parse error, read error).
   */
  function loadFleetFile(file, onSuccess, onError) {
    if (!file) {
      if (onError) onError('No file provided');
      return;
    }
    if (!file.name || !file.name.toLowerCase().endsWith('.json')) {
      if (onError) onError('Please drop a .json file (got: ' + (file.name || 'unnamed') + ')');
      return;
    }
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var json = JSON.parse(ev.target.result);
        if (onSuccess) onSuccess(json, file.name);
      } catch (err) {
        if (onError) onError('Could not parse JSON: ' + err.message);
      }
    };
    reader.onerror = function () {
      if (onError) onError('Could not read file');
    };
    reader.readAsText(file);
  }

  // ═════════════════════════════════════════════════════════════
  // V5 SCHEMA HELPERS (added in Chunk 2)
  // ═════════════════════════════════════════════════════════════

  /**
   * Build a deterministic string component ID from a unit's FLOC,
   * the component name, and an optional position label. Same inputs
   * always produce the same ID. Critical for FK stability across
   * imports and re-imports.
   *
   * Format: <floc_slug>_<component_name_slug>[_<position_slug>]
   * Example: makeComponentId('WA500-12345', 'Engine')
   *          → 'wa500_12345_engine'
   * Example: makeComponentId('PC5500-67890', 'Final Drive', 'LH')
   *          → 'pc5500_67890_final_drive_lh'
   */
  function makeComponentId(unit_floc, component_name, position) {
    function slug(s) {
      return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
    }
    var parts = [slug(unit_floc), slug(component_name)];
    if (position && String(position).trim()) parts.push(slug(position));
    return parts.filter(Boolean).join('_');
  }

  /**
   * Validate a fleet JSON against the V5 spec.
   * Returns: { ok: boolean, issues: [{ severity, msg }] }
   *  severity: 'fatal' | 'warn' | 'info'
   * 'ok' is true if there are no fatal issues.
   */
  function validateFleetJSON_v5(json) {
    var issues = [];
    if (!json || typeof json !== 'object') {
      issues.push({ severity: 'fatal', msg: 'Input is not a JSON object' });
      return { ok: false, issues: issues };
    }
    if (!json.meta || typeof json.meta !== 'object') {
      issues.push({ severity: 'warn', msg: 'meta block missing' });
    } else {
      if (json.meta.schemaVersion !== 5) {
        issues.push({
          severity: 'warn',
          msg: 'meta.schemaVersion is ' + JSON.stringify(json.meta.schemaVersion) + ' (expected 5)'
        });
      }
      if (!json.meta.clientCode) {
        issues.push({ severity: 'warn', msg: 'meta.clientCode is empty' });
      }
    }
    if (!json.masterData || typeof json.masterData !== 'object') {
      issues.push({ severity: 'fatal', msg: 'masterData block missing' });
      return { ok: false, issues: issues };
    }
    if (!Array.isArray(json.masterData.components)) {
      issues.push({ severity: 'fatal', msg: 'masterData.components is not an array' });
    }
    if (!json.workingData || typeof json.workingData !== 'object') {
      issues.push({ severity: 'warn', msg: 'workingData block missing — defaults to empty' });
    }
    // FK integrity check across components ↔ projectComponents
    var components = (json.masterData && json.masterData.components) || [];
    var projComp  = (json.workingData && json.workingData.projectComponents) || [];
    if (Array.isArray(components) && Array.isArray(projComp) && components.length && projComp.length) {
      var validIds = {};
      components.forEach(function (c) { if (c && c.id != null) validIds[c.id] = true; });
      var dangling = 0;
      projComp.forEach(function (pc) {
        if (!pc || pc.component_id == null) return;
        if (!validIds[pc.component_id]) dangling++;
      });
      if (dangling > 0) {
        issues.push({
          severity: 'warn',
          msg: dangling + ' projectComponents row(s) reference component_id values that do not exist in masterData.components'
        });
      }
    }
    return { ok: !issues.some(function (i) { return i.severity === 'fatal'; }), issues: issues };
  }

  /**
   * One-shot V4 Flat → V5 migration.
   * Returns: { migrated, audit }
   *   migrated: the V5-shaped JSON (or the unchanged input if already V5)
   *   audit: { ok, issues, counts: { before, after }, idMapSize }
   *
   * Behaviour:
   *  - Idempotent: if input is already V5 (meta.schemaVersion === 5), returns
   *    it unchanged with audit.ok = true.
   *  - Component IDs become deterministic strings via makeComponentId().
   *  - FK references in working.componentDates → componentDateOverrides,
   *    working.decisionLog → decisions, working.projects[].linkedIds → both
   *    preserved on projects AND surfaced as projectComponents[].
   *  - oil_samples[] preserved at the JSON root for Lens v3.5 compatibility
   *    (not yet routed through masterData.conditionMonitoring — that's Chunk 8).
   *  - fleets[] and units[] derived from unique fleet / unit_floc tuples on
   *    components. sn_prefix / unit_variant_id default to null (FleetConfig
   *    later, Chunk 9a).
   *  - All new V5 entities (componentPockets, partsLibrary, etc.) initialised
   *    as empty arrays.
   *
   * Counts/key audits surface mismatches as warn-level issues. FATAL only on
   * unparseable input.
   */
  function migrateV4FlatToV5(input) {
    var audit = {
      ok: false,
      issues: [],
      counts: { before: {}, after: {} },
      idMapSize: 0,
      droppedFKs: 0
    };

    if (!input || typeof input !== 'object') {
      audit.issues.push({ severity: 'fatal', msg: 'Input is not a JSON object' });
      return { migrated: null, audit: audit };
    }

    // Idempotent — already V5
    if (input.meta && input.meta.schemaVersion === 5) {
      audit.issues.push({ severity: 'info', msg: 'Input is already V5 — no migration needed' });
      audit.ok = true;
      return { migrated: input, audit: audit };
    }

    var working = input.working || {};
    audit.counts.before = {
      components:              (input.components       || []).length,
      componentHistory:        (input.componentHistory || []).length,
      projects:                (working.projects       || []).length,
      componentDateOverrides:  (working.componentDates || []).length,
      decisions:               (working.decisionLog    || []).length,
      oil_samples:             (input.oil_samples      || []).length
    };

    // 1. Build id_map (numeric old ID → new string ID) and rewrite components
    var id_map = {};
    var newComponents = (input.components || []).map(function (c) {
      var floc = c.unit_floc || c.unit || c.unit_id || '';
      var new_id = makeComponentId(floc, c.component, c.position);
      if (c.id !== undefined && c.id !== null) {
        id_map[String(c.id)] = new_id;
      }
      var out = {};
      Object.keys(c).forEach(function (k) { out[k] = c[k]; });
      out.id = new_id;
      out.unit_floc = floc;
      if (out.replacement_strategy == null) out.replacement_strategy = 'usage_based';
      if (out.parts_status == null) out.parts_status = 'none';
      return out;
    });
    audit.idMapSize = Object.keys(id_map).length;

    // 2. Rewrite componentDateOverrides (was working.componentDates)
    var newDateOverrides = (working.componentDates || []).map(function (o) {
      var new_id = id_map[String(o.id)];
      if (!new_id) {
        audit.droppedFKs++;
        audit.issues.push({
          severity: 'warn',
          msg: 'componentDates entry references unknown component id ' + JSON.stringify(o.id) + ' — entry dropped'
        });
        return null;
      }
      return {
        component_id: new_id,
        override_date: o.changeout_date,
        override_reason: o.reason || '',
        set_at: o.set_at || ''
      };
    }).filter(Boolean);

    // 3. Rewrite decisions (was working.decisionLog)
    var newDecisions = (working.decisionLog || []).map(function (d) {
      var out = {};
      Object.keys(d || {}).forEach(function (k) { out[k] = d[k]; });
      if (d && d.component_id !== undefined && d.component_id !== null) {
        var new_id = id_map[String(d.component_id)];
        if (new_id) {
          out.component_id = new_id;
        } else {
          audit.issues.push({
            severity: 'warn',
            msg: 'decisions entry references unknown component_id ' + JSON.stringify(d.component_id) + ' — left as-is'
          });
        }
      }
      return out;
    });

    // 4. Rewrite projects' linkedIds → string IDs
    var newProjects = (working.projects || []).map(function (p) {
      var out = {};
      Object.keys(p || {}).forEach(function (k) { out[k] = p[k]; });
      if (Array.isArray(p.linkedIds)) {
        out.linkedIds = p.linkedIds.map(function (oldId) {
          return id_map[String(oldId)] || oldId;
        });
      }
      return out;
    });

    // 4a. Surface projectComponents from project linkedIds (V5 explicit join table)
    var projectComponents = [];
    newProjects.forEach(function (p) {
      (p.linkedIds || []).forEach(function (cid) {
        projectComponents.push({ project_id: p.id, component_id: cid });
      });
    });

    // 5. Derive fleets[] from unique fleet names
    var fleetMap = {};
    newComponents.forEach(function (c) {
      if (c.fleet && !fleetMap[c.fleet]) {
        fleetMap[c.fleet] = { id: c.fleet, name: c.fleet, type: '' };
      }
    });
    var fleets = Object.keys(fleetMap).map(function (k) { return fleetMap[k]; });

    // 6. Derive units[] from unique unit_floc tuples
    var unitMap = {};
    newComponents.forEach(function (c) {
      var floc = c.unit_floc;
      if (!floc || unitMap[floc]) return;
      unitMap[floc] = {
        floc: floc,
        id: c.unit || floc,
        fleet_id: c.fleet || '',
        model: c.model || '',
        sn_prefix: null,
        unit_variant_id: null,
        status: 'active',
        expected_life_hours: null
      };
    });
    var units = Object.keys(unitMap).map(function (k) { return unitMap[k]; });

    // 7. Construct V5 output
    var meta = {
      schemaVersion: 5,
      clientCode:    input.client_code || (input.meta && input.meta.clientCode) || 'CLIENT',
      clientName:   (input.meta && input.meta.clientName) || '',
      site:         (input.meta && input.meta.site) || '',
      currency:     (input.meta && input.meta.currency) || DEFAULT_CURRENCY,
      lastSaved:    (input.meta && input.meta.lastSaved) || new Date().toISOString(),
      migratedAt:    new Date().toISOString(),
      migratedFrom:  input.schema_version || 'v4 FINAL'
    };

    // Chunk 3 (Slide 8) — synthesise masterData.clientSettings during V4→V5 migration.
    // Source precedence: pre-existing clientSettings block (rare in V4) > legacy meta.currency
    // > suite defaults (CAD / America/Edmonton / en-CA). Locale and timezone are NEW (no V4
    // analog), so they always take the default unless an explicit pre-existing block exists.
    var inSettings = (input.meta && input.meta.clientSettings) || {};
    var clientSettings = {
      currency: inSettings.currency || meta.currency || DEFAULT_CURRENCY,
      timezone: inSettings.timezone || DEFAULT_TZ,
      locale:   inSettings.locale   || DEFAULT_LOCALE
    };

    var migrated = {
      meta: meta,
      masterData: {
        clientSettings: clientSettings,
        fleets: fleets,
        units: units,
        components: newComponents,
        componentHistory: input.componentHistory || [],
        componentPockets: [],
        partsLibrary: [],
        readings: [],
        utilizationProfiles: [],
        unitActivitySchedule: [],
        fleetPlan: [],
        costs: [],
        workOrders: [],
        materialRequirements: [],
        materials: [],
        conditionMonitoring: [],
        budget: []
      },
      workingData: {
        projects: newProjects,
        projectComponents: projectComponents,
        projectDetails: [],
        checklistItems: [],
        actionItems: [],
        projectNotes: [],
        componentDateOverrides: newDateOverrides,
        decisions: newDecisions
      },
      appState: {
        ui_settings: input.ui_settings || {}
      },
      // Preserved at root for Lens v3.5 backward compatibility — Chunk 8
      // re-routes through masterData.conditionMonitoring with vocabulary fix.
      oil_samples: input.oil_samples || []
    };

    // 8. Post-migration counts + audit
    audit.counts.after = {
      components:             migrated.masterData.components.length,
      componentHistory:       migrated.masterData.componentHistory.length,
      projects:               migrated.workingData.projects.length,
      componentDateOverrides: migrated.workingData.componentDateOverrides.length,
      decisions:              migrated.workingData.decisions.length,
      oil_samples:            migrated.oil_samples.length
    };

    Object.keys(audit.counts.before).forEach(function (k) {
      if (audit.counts.before[k] !== audit.counts.after[k]) {
        audit.issues.push({
          severity: 'warn',
          msg: 'Count mismatch on ' + k + ': before=' + audit.counts.before[k] + ', after=' + audit.counts.after[k] + ' (likely dropped due to missing FK)'
        });
      }
    });

    // FK integrity audit
    var validIds = {};
    migrated.masterData.components.forEach(function (c) { if (c.id) validIds[c.id] = true; });
    var dangling = 0;
    migrated.workingData.projectComponents.forEach(function (pc) {
      if (!validIds[pc.component_id]) dangling++;
    });
    if (dangling > 0) {
      audit.issues.push({
        severity: 'warn',
        msg: dangling + ' projectComponents reference component IDs that no longer exist'
      });
    }

    audit.ok = !audit.issues.some(function (i) { return i.severity === 'fatal'; });
    return { migrated: migrated, audit: audit };
  }

  // ─────────────────────────────────────────────────────────────
  // SAVE FILENAME — Chunk 11 (v1.2.0)
  // ─────────────────────────────────────────────────────────────
  /**
   * Build a unified save filename across all suite tools.
   *
   * Format: <safeClientCode>_<YYYY-MM-DD_HH-MM-SS>[_<suffix>].<ext>
   *
   * Examples:
   *   buildSaveFilename('CLIENT')                              → 'CLIENT_2026-05-08_14-30-45.json'
   *   buildSaveFilename('Acme Corp')                           → 'Acme_Corp_2026-05-08_14-30-45.json'
   *   buildSaveFilename('CLIENT', { suffix: 'v5-conmon' })     → 'CLIENT_2026-05-08_14-30-45_v5-conmon.json'
   *   buildSaveFilename('CLIENT', { tz: 'America/Vancouver' }) → 'CLIENT_2026-05-08_07-30-45.json' (in Pacific)
   *
   * @param {string} clientCode — sanitized to [A-Z0-9_]; falls back to 'CLIENT' if empty.
   * @param {object} [opts]
   * @param {Date|string} [opts.ts] — timestamp; defaults to new Date().
   * @param {string} [opts.tz]     — IANA timezone (e.g. 'America/Vancouver'); defaults to
   *                                 fleetData.masterData.clientSettings.timezone if available
   *                                 (Chunk 12 — falls back to browser-local until Chunk 12 lands).
   * @param {string} [opts.suffix] — optional decoration appended after datetime.
   * @param {string} [opts.ext]    — file extension without dot. Defaults to 'json'.
   * @param {object} [opts.fleetData] — optional fleet JSON object to read clientSettings.timezone from.
   * @returns {string}
   */
  function buildSaveFilename(clientCode, opts) {
    opts = opts || {};
    var safeCC = String(clientCode || 'CLIENT').replace(/[^A-Z0-9_]/gi, '_');
    var ts     = opts.ts ? (opts.ts instanceof Date ? opts.ts : new Date(opts.ts)) : new Date();
    if (isNaN(ts.getTime())) ts = new Date();
    // Resolve timezone — explicit opts.tz beats fleetData.masterData.clientSettings.timezone
    // beats browser local. clientSettings is a Chunk 12 slot; safe to read defensively.
    var tz = opts.tz;
    if (!tz && opts.fleetData && opts.fleetData.masterData && opts.fleetData.masterData.clientSettings) {
      tz = opts.fleetData.masterData.clientSettings.timezone;
    }
    // Format datetime as YYYY-MM-DD_HH-MM-SS in the chosen TZ.
    // Use Intl.DateTimeFormat with toParts() for reliable locale-independent assembly.
    var fmtOpts = {
      year:   'numeric', month:  '2-digit', day:    '2-digit',
      hour:   '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    };
    if (tz) fmtOpts.timeZone = tz;
    var parts;
    try {
      parts = new Intl.DateTimeFormat('en-CA', fmtOpts).formatToParts(ts);
    } catch (e) {
      // Invalid timezone — fall back to browser local (drop the tz option)
      delete fmtOpts.timeZone;
      parts = new Intl.DateTimeFormat('en-CA', fmtOpts).formatToParts(ts);
    }
    var get = function (type) {
      var p = parts.find(function (x) { return x.type === type; });
      return p ? p.value : '00';
    };
    // Some locales return 'hour: 24' for midnight — normalize to '00'.
    var hh = get('hour'); if (hh === '24') hh = '00';
    var dt = get('year') + '-' + get('month') + '-' + get('day') +
             '_' + hh + '-' + get('minute') + '-' + get('second');
    var suffix = opts.suffix ? '_' + String(opts.suffix).replace(/[^A-Z0-9_-]/gi, '_') : '';
    var ext    = (opts.ext || 'json').replace(/[^A-Z0-9]/gi, '');
    return safeCC + '_' + dt + suffix + '.' + ext;
  }

  // ─────────────────────────────────────────────────────────────
  // CLIENT SETTINGS  (Chunk 3 / Slide 8 — per-client currency + TZ + locale)
  // ─────────────────────────────────────────────────────────────
  /**
   * Extract client settings from a fleet JSON with fallbacks to suite defaults.
   * Reads masterData.clientSettings; missing fields fall back to:
   *   currency: 'CAD'  ·  timezone: 'America/Edmonton' (Mountain)  ·  locale: 'en-CA'
   * Safe to pass anything (null, {}, malformed) — always returns a complete settings object.
   * Caller pattern:
   *   var s = NumaCoreLib.getClientSettings(json);
   *   var label = NumaCoreLib.fmtMoney(177187.88, s);  // "CA$177,187.88"
   */
  function getClientSettings(json) {
    var s = (json && json.masterData && json.masterData.clientSettings) || {};
    return {
      currency: s.currency || DEFAULT_CURRENCY,
      timezone: s.timezone || DEFAULT_TZ,
      locale:   s.locale   || DEFAULT_LOCALE
    };
  }

  /** Convenience: return just the timezone string from a fleet JSON, with default fallback. */
  function getClientTZ(json) {
    return getClientSettings(json).timezone;
  }

  /**
   * Format a money amount using client settings.
   *   settings:  { currency, timezone, locale }  (as returned by getClientSettings)
   *              May also be null/undefined → falls back to suite defaults.
   *   amount:    number (or numeric string). null/NaN returns ''.
   * Example: fmtMoney(177187.88, {currency:'CAD', locale:'en-CA'}) → "CA$177,187.88"
   * Falls back to a plain "$X.XX" string if the runtime doesn't support Intl.NumberFormat
   * for the requested currency.
   */
  function fmtMoney(amount, settings) {
    if (amount == null || amount === '' || isNaN(amount)) return '';
    var s = settings || {};
    var locale   = s.locale   || DEFAULT_LOCALE;
    var currency = s.currency || DEFAULT_CURRENCY;
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currency,
        maximumFractionDigits: 2
      }).format(Number(amount));
    } catch (e) {
      return '$' + Number(amount).toFixed(2);
    }
  }

  /**
   * Format a Date (or ISO string) using client settings.
   *   settings:  { currency, timezone, locale }  (as returned by getClientSettings)
   *              May also be null/undefined → falls back to suite defaults.
   *   format:    'datetime' (default) | 'date' | 'time' | 'short' | 'iso'
   *
   * Examples (settings = {timezone:'America/Edmonton', locale:'en-CA'}):
   *   fmtTime(new Date(), s)              → "2026-05-10, 21:30 MDT"
   *   fmtTime(new Date(), s, 'date')      → "May 10, 2026"
   *   fmtTime(new Date(), s, 'time')      → "21:30 MDT"
   *   fmtTime(new Date(), s, 'short')     → "May 10, 2026, 21:30"
   *   fmtTime(new Date(), s, 'iso')       → "2026-05-10"  (no TZ adjustment — for storage)
   */
  function fmtTime(date, settings, format) {
    if (!date) return '';
    var d = (date instanceof Date) ? date : new Date(date);
    if (isNaN(d)) return '';
    format = format || 'datetime';
    if (format === 'iso') return d.toISOString().slice(0, 10);

    var s = settings || {};
    var tz     = s.timezone || DEFAULT_TZ;
    var locale = s.locale   || DEFAULT_LOCALE;
    var opts = { timeZone: tz };

    try {
      if (format === 'date') {
        opts.year = 'numeric'; opts.month = 'short'; opts.day = 'numeric';
        return d.toLocaleDateString(locale, opts);
      }
      if (format === 'time') {
        opts.hour = '2-digit'; opts.minute = '2-digit'; opts.timeZoneName = 'short';
        return d.toLocaleTimeString(locale, opts);
      }
      if (format === 'short') {
        opts.year = 'numeric'; opts.month = 'short'; opts.day = 'numeric';
        opts.hour = '2-digit'; opts.minute = '2-digit';
        return d.toLocaleString(locale, opts);
      }
      // 'datetime' default — date + time + tz abbreviation
      opts.year = 'numeric'; opts.month = '2-digit'; opts.day = '2-digit';
      opts.hour = '2-digit'; opts.minute = '2-digit';
      opts.timeZoneName = 'short';
      return d.toLocaleString(locale, opts);
    } catch (e) {
      return d.toISOString();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // CATEGORY VOCABULARY  (Chunk 5 / Slide 6 — single source of truth)
  // ═════════════════════════════════════════════════════════════
  //
  // Canonical set (9 keys). Matches Intake's source-of-truth vocabulary so
  // freshly-built fleets land on canonical keys without translation. Legacy
  // values from older Cadence builds (tracks, drill_swing) are normalised at
  // read time via CATEGORY_SYNONYMS.
  //
  //   engine          drivetrain      geared_drives
  //   drill_rotary    hydraulics      cylinders
  //   undercarriage   attachments     misc
  //
  // Operator-locked vocabulary winner (2026-05-10): undercarriage (NOT tracks).
  // drill_rotary chosen to match Intake's existing keyword group.

  var CATEGORY_CANONICAL = {
    engine: true, drivetrain: true, geared_drives: true,
    drill_rotary: true, hydraulics: true, cylinders: true,
    undercarriage: true, attachments: true, misc: true
  };

  // Legacy / alternative spellings → canonical key.
  // Lookup is case-insensitive; non-alphanumerics are normalised to '_'.
  var CATEGORY_SYNONYMS = {
    // legacy Cadence COLORS/LABELS keys
    tracks: 'undercarriage',
    track: 'undercarriage',
    drill_swing: 'drill_rotary',
    drill: 'drill_rotary',
    rotary: 'drill_rotary',
    swing: 'drill_rotary',
    // common operator phrasings (matches Lens' free-text categories)
    miscellaneous: 'misc',
    other: 'misc',
    // explicit canonical aliases (defensive — same in, same out)
    engine: 'engine',
    drivetrain: 'drivetrain',
    geared_drives: 'geared_drives',
    final_drive: 'geared_drives',
    final_drives: 'geared_drives',
    drill_rotary: 'drill_rotary',
    hydraulics: 'hydraulics',
    hydraulic: 'hydraulics',
    cylinders: 'cylinders',
    cylinder: 'cylinders',
    undercarriage: 'undercarriage',
    attachments: 'attachments',
    attachment: 'attachments',
    misc: 'misc'
  };

  // Keyword inference fallback when rawCategory is missing/unknown.
  // Ordered: first match wins. Mirrors Intake's COMP_CATEGORIES intent so a
  // component name like "Engine Cooler" canonicalises to 'engine' even with
  // no upstream category value.
  var CATEGORY_KEYWORDS = [
    { cat: 'engine',        kws: ['engine', 'turbo', 'radiator', 'cooler', 'fuel pump', 'starting motor', 'motor engine', 'emissions'] },
    { cat: 'drivetrain',    kws: ['transmission', 'torque', 'differential', 'drive shaft', 'drop box', 'gear box', 'gearbox', 'bevel', 'transfer', 'wheel', 'brake', 'axle'] },
    { cat: 'geared_drives', kws: ['final drive', 'swing drive', 'pump drive'] },
    { cat: 'drill_rotary',  kws: ['drill', 'rotary', 'drifter', 'rock drill', 'feed', 'boom sbr', 'precussion'] },
    { cat: 'hydraulics',    kws: ['pump', 'motor', 'hydraulic', 'swing motor', 'travel motor', 'track motor', 'pilot'] },
    { cat: 'cylinders',     kws: ['cylinder', 'cyl '] },
    { cat: 'undercarriage', kws: ['track', 'idler', 'roller', 'sprocket', 'undercarriage', 'adjuster', 'tensioner'] },
    { cat: 'attachments',   kws: ['bucket', 'blade', 'ripper', 'edge', 'cutting edge', 'wear'] }
  ];

  var CATEGORY_LABELS = {
    engine:         'Engine / Cooling',
    drivetrain:     'Drivetrain',
    geared_drives:  'Geared Drives / Final Drive',
    drill_rotary:   'Drill / Rotary / Swing',
    hydraulics:     'Hydraulic Pumps',
    cylinders:      'Cylinders / Suspension',
    undercarriage:  'Undercarriage',
    attachments:    'Attachments / Blades',
    misc:           'Miscellaneous'
  };

  // Cadence-derived palette (preserves visual continuity from v18.3 onward).
  var CATEGORY_COLORS = {
    engine:         '#F87171',
    drivetrain:     '#FB923C',
    geared_drives:  '#FBBF24',
    drill_rotary:   '#22D3EE',
    hydraulics:     '#60A5FA',
    cylinders:      '#A78BFA',
    undercarriage:  '#34D399',
    attachments:    '#F472B6',
    misc:           '#94A3B8'
  };

  function _normCatKey(s) {
    return String(s == null ? '' : s)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
  }

  /**
   * Resolve any incoming category value to a canonical key.
   *
   *   rawCategory:   the .category field from a component record (or null/undefined)
   *   componentName: the component name (used for keyword inference if rawCategory
   *                  is blank or doesn't resolve)
   *   opts.synonyms: optional extra synonym map (e.g. from clientSettings.categorySynonyms)
   *                  merged ON TOP of the suite synonym table for per-client overrides.
   *
   * Returns one of the 9 canonical keys; never returns null or empty string.
   *
   * Examples:
   *   canonicalCategory('tracks')                 → 'undercarriage'
   *   canonicalCategory('Tracks / Running Gear')  → 'undercarriage' (matches 'tracks')
   *   canonicalCategory(null, 'Front Track Frame') → 'undercarriage' (keyword inference)
   *   canonicalCategory('something weird')        → 'misc'
   *   canonicalCategory('')                       → 'misc'
   */
  function canonicalCategory(rawCategory, componentName, opts) {
    var key = _normCatKey(rawCategory);
    var extraSyns = (opts && opts.synonyms) || null;

    // 1. Direct canonical match
    if (key && CATEGORY_CANONICAL[key]) return key;

    // 2. Synonym (client-override beats suite default)
    if (key) {
      if (extraSyns && extraSyns[key] && CATEGORY_CANONICAL[extraSyns[key]]) return extraSyns[key];
      if (CATEGORY_SYNONYMS[key])                                            return CATEGORY_SYNONYMS[key];
    }

    // 3. Try the human-readable label as a synonym lookup (e.g. "Tracks / Running Gear"
    //    → split on non-alpha, scan tokens for synonym matches).
    if (key) {
      var tokens = key.split('_').filter(Boolean);
      for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        if (CATEGORY_CANONICAL[t]) return t;
        if (CATEGORY_SYNONYMS[t])  return CATEGORY_SYNONYMS[t];
      }
    }

    // 4. Keyword inference from component name
    var nameLower = String(componentName == null ? '' : componentName).toLowerCase();
    if (nameLower) {
      for (var j = 0; j < CATEGORY_KEYWORDS.length; j++) {
        var entry = CATEGORY_KEYWORDS[j];
        for (var k = 0; k < entry.kws.length; k++) {
          if (nameLower.indexOf(entry.kws[k]) !== -1) return entry.cat;
        }
      }
    }

    // 5. Default
    return 'misc';
  }

  /** Human-readable label for a canonical category key (e.g. 'undercarriage' → 'Undercarriage'). */
  function categoryLabel(canonicalKey) {
    var key = _normCatKey(canonicalKey);
    if (CATEGORY_LABELS[key]) return CATEGORY_LABELS[key];
    // Defensive: if caller passes a raw legacy value, canonicalise first.
    var c = canonicalCategory(canonicalKey, null);
    return CATEGORY_LABELS[c] || CATEGORY_LABELS.misc;
  }

  /** Colour token for a canonical category key. Returns the misc colour for unknown keys. */
  function categoryColor(canonicalKey) {
    var key = _normCatKey(canonicalKey);
    if (CATEGORY_COLORS[key]) return CATEGORY_COLORS[key];
    var c = canonicalCategory(canonicalKey, null);
    return CATEGORY_COLORS[c] || CATEGORY_COLORS.misc;
  }

  // ─────────────────────────────────────────────────────────────
  // SORT FIELD NORMALISATION  (Chunk 5 / Slide 6 — cross-tool CAPS rule)
  // ─────────────────────────────────────────────────────────────
  /**
   * Normalise a Sort Field / machine ID to the operator's "always CAPS" rule.
   * Trims whitespace; uppercases ASCII letters; preserves digits, dashes,
   * underscores, and dots. Safe on null/undefined (returns '').
   *
   * Examples:
   *   normaliseSortField('ex401')      → 'EX401'
   *   normaliseSortField('  bd-203 ')  → 'BD-203'
   *   normaliseSortField(null)         → ''
   *
   * Use at WRITE boundaries (ConMon import, Excel ingest, manual edits) so the
   * suite's downstream readers all see a consistent CAPS-only value.
   */
  function normaliseSortField(rawId) {
    if (rawId == null) return '';
    return String(rawId).trim().toUpperCase();
  }

  // ─────────────────────────────────────────────────────────────
  // VPN NORMALISATION  (Deploy v8.9 — cross-reference matching)
  // ─────────────────────────────────────────────────────────────
  /**
   * Normalise a vendor part number (VPN) for cross-reference matching.
   *
   * Operator-locked rule (2026-05-11): strip all hyphens EXCEPT the literal
   * "-EXC" suffix that identifies exchange-variant parts. Trims whitespace,
   * uppercases for case-insensitive matching. Treats null / undefined / ''
   * / 'N/A' as empty (returns '').
   *
   * Examples:
   *   normaliseVPN('3723563')         → '3723563'
   *   normaliseVPN('3723563-EXC')     → '3723563-EXC'   (EXC suffix preserved)
   *   normaliseVPN('9W9603-EXC')      → '9W9603-EXC'   (preserved)
   *   normaliseVPN('123-4567')        → '1234567'      (interior hyphen stripped)
   *   normaliseVPN('XYZ-ABC-EXC')     → 'XYZABC-EXC'   (interior stripped, EXC kept)
   *   normaliseVPN('  3723563  ')     → '3723563'      (trim)
   *   normaliseVPN('N/A')             → ''             (literal N/A treated as missing)
   *   normaliseVPN(null)              → ''
   *
   * Use at LOOKUP boundaries when matching dealer-provided part numbers
   * against an Inventory Master or Component Snapshot cross-reference table.
   */
  function normaliseVPN(rawVPN) {
    if (rawVPN == null) return '';
    var v = String(rawVPN).trim().toUpperCase();
    if (v === '' || v === 'N/A') return '';
    if (v.length >= 4 && v.slice(-4) === '-EXC') {
      return v.slice(0, -4).replace(/-/g, '') + '-EXC';
    }
    return v.replace(/-/g, '');
  }

  // ─────────────────────────────────────────────────────────────
  // EXPORT
  // ─────────────────────────────────────────────────────────────
  window.NumaCoreLib = {
    esc: esc,
    parseDate: parseDate,
    fmtDate: fmtDate,
    scopedKey: scopedKey,
    showToast: showToast,
    loadFleetFile: loadFleetFile,
    // Chunk 2 — V5 migration helpers
    makeComponentId: makeComponentId,
    validateFleetJSON_v5: validateFleetJSON_v5,
    migrateV4FlatToV5: migrateV4FlatToV5,
    // Chunk 11 — save-filename consistency
    buildSaveFilename: buildSaveFilename,
    // Chunk 3 (Slide 8) — per-client settings (CAD / Mountain / en-CA defaults)
    getClientSettings: getClientSettings,
    getClientTZ: getClientTZ,
    fmtMoney: fmtMoney,
    fmtTime: fmtTime,
    DEFAULT_CURRENCY: DEFAULT_CURRENCY,
    DEFAULT_TZ: DEFAULT_TZ,
    DEFAULT_LOCALE: DEFAULT_LOCALE,
    // Chunk 5 (Slide 6) — cross-tool category vocabulary + Sort Field CAPS rule
    canonicalCategory: canonicalCategory,
    categoryLabel: categoryLabel,
    categoryColor: categoryColor,
    CATEGORY_SYNONYMS: CATEGORY_SYNONYMS,
    CATEGORY_LABELS: CATEGORY_LABELS,
    CATEGORY_COLORS: CATEGORY_COLORS,
    normaliseSortField: normaliseSortField,
    // Deploy v8.9 — VPN normalisation for cross-reference matching
    normaliseVPN: normaliseVPN,
    VERSION: VERSION
  };
})();
