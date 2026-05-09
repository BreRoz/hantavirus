"use strict";

// ============================================================================
// 1. Config & constants
// ============================================================================

const GEN_COLORS = {
  0: "#ef4444",
  1: "#f97316",
  2: "#eab308",
  3: "#22c55e",
  4: "#22c55e",
};

const STATUS_COLORS = {
  confirmed: "#ef4444",
  suspected: "#f59e0b",
  recovered: "#10b981",
  deceased:  "#6b7280",
};

const EDGE_COLORS = {
  cabin_contact:      "#a78bfa",
  dining_contact:     "#f87171",
  crew_contact:       "#fbbf24",
  flight_contact:     "#60a5fa",
  hvac_contact:       "#2dd4bf",
  deck_contact:       "#94a3b8",
  close_contact:      "#94a3b8",
};

const RISK_LABELS = {
  intimate:  { label: "Intimate",  cls: "risk-intimate" },
  prolonged: { label: "Prolonged", cls: "risk-prolonged" },
  brief:     { label: "Brief",     cls: "risk-brief" },
};

function genColor(gen) { return GEN_COLORS[Math.min(gen, 4)] || GEN_COLORS[4]; }
function statusColor(s) { return STATUS_COLORS[s] || STATUS_COLORS.suspected; }
function edgeColor(t)   { return EDGE_COLORS[t]   || EDGE_COLORS.close_contact; }

// ============================================================================
// 2. API client
// ============================================================================

const API = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${path} → ${r.status}`);
    return r.json();
  },
  async del(path) {
    const r = await fetch(path, { method: "DELETE" });
    if (!r.ok) throw new Error(`DELETE ${path} → ${r.status}`);
    return r.json();
  },

  getCases()           { return this.get("/api/cases"); },
  getCase(id)          { return this.get(`/api/cases/${id}`); },
  addCase(data)        { return this.post("/api/cases", data); },
  deleteCase(id)       { return this.del(`/api/cases/${id}`); },
  getStats()           { return this.get("/api/stats"); },
  getTransmissionChain() { return this.get("/api/transmission-chain?include_exposure=true&include_flights=true"); },
  getExposureEvents()  { return this.get("/api/exposure-events"); },
  getFlights()         { return this.get("/api/flights"); },
  getFlight(id)        { return this.get(`/api/flights/${id}`); },
  getFlightRisk(id)    { return this.get(`/api/flights/${id}/risk`); },
  getTimeline()        { return this.get("/api/timeline"); },

  exportCases()        { window.open("/api/export/cases", "_blank"); },
  exportTransmission() { window.open("/api/export/transmission", "_blank"); },
  exportFlight(id)     { window.open(`/api/export/flight/${id}`, "_blank"); },

  async importCSV(file) {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/import/csv", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`CSV import → ${r.status}`);
    return r.json();
  },
};

// ============================================================================
// 3. Utils
// ============================================================================

const Utils = {
  parseDate(s) { return s ? new Date(s + "T00:00:00") : null; },
  daysBetween(a, b) { return Math.round((b - a) / 86400000); },
  addDays(d, n) { return new Date(d.getTime() + n * 86400000); },
  toDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  },
  toDisplay(s) {
    if (!s) return "—";
    const d = this.parseDate(s);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  },
  clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); },
  esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  },
};

// ============================================================================
// 4. Toast notifications
// ============================================================================

const Toast = {
  _el: null,
  _tmr: null,
  init() {
    this._el = document.createElement("div");
    this._el.id = "toast";
    this._el.style.cssText = [
      "position:fixed;bottom:24px;right:24px;z-index:9999",
      "background:var(--color-surface-2);border:1px solid var(--color-border)",
      "color:var(--color-text-primary);padding:10px 16px;border-radius:var(--radius-md)",
      "font-size:var(--text-sm);box-shadow:var(--shadow-lg)",
      "opacity:0;transition:opacity 0.2s;pointer-events:none;max-width:320px",
    ].join(";");
    document.body.appendChild(this._el);
  },
  show(msg, type = "info", duration = 3000) {
    if (!this._el) this.init();
    const colors = { info: "#60a5fa", success: "#22c55e", error: "#ef4444", warning: "#f59e0b" };
    this._el.style.borderLeftColor = colors[type] || colors.info;
    this._el.style.borderLeftWidth = "3px";
    this._el.textContent = msg;
    this._el.style.opacity = "1";
    clearTimeout(this._tmr);
    this._tmr = setTimeout(() => { this._el.style.opacity = "0"; }, duration);
  },
};

// ============================================================================
// 5. TabNav
// ============================================================================

const TabNav = {
  _current: "overview",
  _handlers: {},

  init() {
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => this.activate(btn.dataset.tab));
    });
  },

  activate(tabId) {
    this._current = tabId;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tabId));
    document.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id === `tab-${tabId}`));
    if (this._handlers[tabId]) this._handlers[tabId]();
  },

  onActivate(tabId, fn) { this._handlers[tabId] = fn; },
  current() { return this._current; },
};

// ============================================================================
// 6. Sidebar
// ============================================================================

const Sidebar = {
  _cases: [],
  _selectedId: null,
  _statusFilter: new Set(["confirmed", "suspected", "recovered", "deceased"]),
  _genFilter: new Set([0, 1, 2, 3]),
  _search: "",
  _onSelect: null,

  init(onSelect) {
    this._onSelect = onSelect;

    document.querySelectorAll(".filter-pills input[type=checkbox]").forEach(cb => {
      if (cb.closest("#gen-filter-pills")) {
        cb.addEventListener("change", () => {
          const v = parseInt(cb.value, 10);
          cb.checked ? this._genFilter.add(v) : this._genFilter.delete(v);
          this._render();
          App.refresh();
        });
      } else {
        cb.addEventListener("change", () => {
          cb.checked ? this._statusFilter.add(cb.value) : this._statusFilter.delete(cb.value);
          this._render();
          App.refresh();
        });
      }
    });

    document.getElementById("sidebar-search")?.addEventListener("input", e => {
      this._search = e.target.value.toLowerCase();
      this._render();
    });
  },

  load(cases) {
    this._cases = cases;
    this._render();
  },

  _locStr(c) {
    const loc = c.location;
    if (!loc) return "";
    if (typeof loc === "string") return loc;
    return [loc.city, loc.country].filter(Boolean).join(", ");
  },

  _visible() {
    return this._cases.filter(c => {
      if (!this._statusFilter.has(c.status)) return false;
      const gen = c.generation ?? 0;
      const genKey = gen >= 3 ? 3 : gen;
      if (!this._genFilter.has(genKey)) return false;
      if (this._search) {
        const q = this._search;
        return (c.id || "").toLowerCase().includes(q) ||
               (c.name || "").toLowerCase().includes(q) ||
               this._locStr(c).toLowerCase().includes(q);
      }
      return true;
    });
  },

  _render() {
    const visible = this._visible();
    const list = document.getElementById("case-list");
    const countEl = document.getElementById("sidebar-count");
    countEl.textContent = `(${visible.length} of ${this._cases.length})`;

    list.innerHTML = visible.map(c => {
      const gen = c.generation ?? 0;
      const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${genColor(gen)};flex-shrink:0"></span>`;
      const role = c.ship_info?.role ? `<span style="opacity:.6;font-size:10px"> · ${Utils.esc(c.ship_info.role)}</span>` : "";
      const isAuto = (c.reporter || "").includes("Auto-scraped");
      const srcBadge = isAuto
        ? `<span class="source-badge source-badge--unverified" title="Auto-scraped — verify before publishing">⚠ unverified</span>`
        : `<span class="source-badge source-badge--verified" title="${Utils.esc(c.reporter || "Verified source")}">✓ verified</span>`;
      return `<div class="case-item${c.id === this._selectedId ? " selected" : ""}" data-id="${c.id}">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${dot}
          <span class="case-item-id">${Utils.esc(c.id)}</span>
          <span class="case-item-status case-item-status--${c.status}">${c.status}</span>
          ${srcBadge}
        </div>
        <div class="case-item-name">${Utils.esc(c.name || "—")}${role}</div>
        <div class="case-item-meta">Gen ${gen} · ${Utils.esc(this._locStr(c) || "—")}</div>
      </div>`;
    }).join("");

    list.querySelectorAll(".case-item").forEach(el => {
      el.addEventListener("click", () => this._onSelect && this._onSelect(el.dataset.id));
    });
  },

  select(id) {
    this._selectedId = id;
    this._render();
  },

  visibleIds() { return this._visible().map(c => c.id); },
  getFilter() { return { status: this._statusFilter, gen: this._genFilter }; },
};

// ============================================================================
// 7. DateFilter
// ============================================================================

const DateFilter = {
  _start: null,
  _end: null,

  init() {
    const s = document.getElementById("ctrl-start");
    const e = document.getElementById("ctrl-end");
    if (!s || !e) return;
    s.addEventListener("change", () => { this._start = s.value || null; App.refresh(); });
    e.addEventListener("change", () => { this._end = e.value || null; App.refresh(); });
  },

  matches(dateStr) {
    if (!dateStr) return true;
    if (this._start && dateStr < this._start) return false;
    if (this._end   && dateStr > this._end)   return false;
    return true;
  },
};

// ============================================================================
// 8. DetailPanel
// ============================================================================

const DetailPanel = {
  _el: null,

  init() {
    this._el = document.getElementById("case-detail");
    const closeBtn = document.getElementById("case-detail-close");
    if (closeBtn) closeBtn.addEventListener("click", () => this.hide());
  },

  show(c, edges, exposureEvents, flights) {
    if (!this._el) return;
    const gen = c.generation ?? 0;
    const infectedBy = c.infected_by ? `<span style="font-size:var(--text-xs);color:var(--color-text-muted)">← ${Utils.esc(c.infected_by)}</span>` : "";
    const genBadge = `<span style="padding:2px 8px;border-radius:20px;font-size:var(--text-xs);font-weight:600;background:${genColor(gen)}22;color:${genColor(gen)}">Gen ${gen}</span>`;
    const isAuto = (c.reporter || "").includes("Auto-scraped");
    const srcBadge = isAuto
      ? `<span class="source-badge source-badge--unverified">⚠ UNVERIFIED</span>`
      : `<span class="source-badge source-badge--verified">✓ VERIFIED</span>`;
    const reporterLine = !isAuto && c.reporter
      ? `<span style="font-size:10px;color:var(--color-text-muted);margin-left:6px">${Utils.esc(c.reporter)}</span>`
      : "";

    let html = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-2)">
        <span style="font-weight:600;font-size:var(--text-sm)">${Utils.esc(c.id)} — ${Utils.esc(c.name || "—")}</span>
        ${genBadge}
      </div>
      ${infectedBy ? `<div style="margin-bottom:var(--space-2)">${infectedBy}</div>` : ""}
      <div class="detail-row"><span class="detail-label">Status</span><span class="detail-value case-item-status case-item-status--${c.status}">${c.status}</span></div>
      <div class="detail-row"><span class="detail-label">Source</span><span class="detail-value" style="display:flex;align-items:center;flex-wrap:wrap;gap:4px">${srcBadge}${reporterLine}</span></div>
      <div class="detail-row"><span class="detail-label">Location</span><span class="detail-value">${Utils.esc(c.location && typeof c.location === "object" ? [c.location.city, c.location.country].filter(Boolean).join(", ") : c.location || "—")}</span></div>
      <div class="detail-row"><span class="detail-label">Onset</span><span class="detail-value">${Utils.toDisplay(c.onset_date)}</span></div>
      <div class="detail-row"><span class="detail-label">Reported</span><span class="detail-value">${Utils.toDisplay(c.date)}</span></div>
    `;

    if (c.ship_info) {
      const si = c.ship_info;
      html += `<div style="margin-top:var(--space-2);padding-top:var(--space-2);border-top:1px solid var(--color-border)">
        <div style="font-size:var(--text-xs);font-weight:600;color:var(--color-text-muted);margin-bottom:4px">SHIP INFO</div>
        ${si.cabin ? `<div class="detail-row"><span class="detail-label">Cabin</span><span class="detail-value">${Utils.esc(si.cabin)} — Deck ${si.deck || "?"}</span></div>` : ""}
        ${si.role ? `<div class="detail-row"><span class="detail-label">Role</span><span class="detail-value">${Utils.esc(si.role)}</span></div>` : ""}
        ${si.zone ? `<div class="detail-row"><span class="detail-label">Zone</span><span class="detail-value">${Utils.esc(si.zone)}</span></div>` : ""}
      </div>`;
    }

    if (c.exposures && c.exposures.length && exposureEvents) {
      const evts = c.exposures.map(eid => exposureEvents.find(e => e.id === eid)).filter(Boolean);
      if (evts.length) {
        html += `<div style="margin-top:var(--space-2);padding-top:var(--space-2);border-top:1px solid var(--color-border)">
          <div style="font-size:var(--text-xs);font-weight:600;color:var(--color-text-muted);margin-bottom:4px">EXPOSURES (${evts.length})</div>`;
        evts.forEach(ev => {
          const ri = RISK_LABELS[ev.transmission_risk] || { label: ev.transmission_risk, cls: "" };
          html += `<div style="font-size:var(--text-xs);margin-bottom:4px;display:flex;justify-content:space-between;align-items:center">
            <span>${Utils.esc(ev.label)}</span>
            <span class="exposure-risk-badge ${ri.cls}">${ri.label}</span>
          </div>`;
        });
        html += "</div>";
      }
    }

    if (c.flights && c.flights.length) {
      html += `<div style="margin-top:var(--space-2);padding-top:var(--space-2);border-top:1px solid var(--color-border)">
        <div style="font-size:var(--text-xs);font-weight:600;color:var(--color-text-muted);margin-bottom:4px">FLIGHTS</div>`;
      c.flights.forEach(f => {
        const fl = flights ? flights.find(x => x.id === f.flight_id) : null;
        html += `<div style="font-size:var(--text-xs);margin-bottom:4px">
          ${fl ? Utils.esc(fl.flight_number) : f.flight_id} · Seat ${Utils.esc(f.seat || "?")}
          ${f.infectious ? `<span style="color:var(--color-confirmed);margin-left:4px">● infectious</span>` : ""}
        </div>`;
      });
      html += "</div>";
    }

    if (c.notes) {
      html += `<div style="margin-top:var(--space-2);padding-top:var(--space-2);border-top:1px solid var(--color-border);font-size:var(--text-xs);color:var(--color-text-muted)">${Utils.esc(c.notes)}</div>`;
    }

    if (c.source_url) {
      html += `<div style="margin-top:var(--space-2);padding-top:var(--space-2);border-top:1px solid var(--color-border)">
        <a href="${Utils.esc(c.source_url)}" target="_blank" rel="noopener noreferrer"
           style="font-size:var(--text-xs);color:var(--color-brand);text-decoration:underline;word-break:break-all">
          ↗ Source
        </a>
      </div>`;
    } else if (c.source_notes) {
      html += `<div style="margin-top:var(--space-2);padding-top:var(--space-2);border-top:1px solid var(--color-border);font-size:var(--text-xs);color:var(--color-text-muted);font-style:italic">${Utils.esc(c.source_notes)}</div>`;
    }

    const idEl = document.getElementById("detail-id");
    if (idEl) idEl.textContent = `${c.id} · ${c.name || ""}`;
    const body = this._el.querySelector("#detail-body");
    if (body) body.innerHTML = html;
    this._el.classList.add("open");
  },

  hide() {
    if (this._el) this._el.classList.remove("open");
    const idEl = document.getElementById("detail-id");
    if (idEl) idEl.textContent = "—";
  },
};

// ============================================================================
// 9. OverviewTab (Leaflet map)
// ============================================================================

const OverviewTab = {
  _map: null,
  _markers: [],

  init() {
    this._map = L.map("map", { zoomControl: true, attributionControl: false }).setView([20, 0], 2);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: "© CartoDB",
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(this._map);

    document.getElementById("btn-map-fit")?.addEventListener("click", () => this._fit());
    this._addShipLayer();
  },

  render(cases) {
    this._markers.forEach(m => m.remove());
    this._markers = [];

    const locOf = c => c.location && typeof c.location === "object" ? c.location : {};
    const visible = cases.filter(c => locOf(c).lat && locOf(c).lng);
    document.getElementById("map-case-count").textContent = `${visible.length} case${visible.length !== 1 ? "s" : ""}`;

    // Group cases by exact coordinate so stacked pins become a cluster dot
    const clusters = {};
    visible.forEach(c => {
      const loc = locOf(c);
      const key = `${loc.lat},${loc.lng}`;
      if (!clusters[key]) clusters[key] = [];
      clusters[key].push(c);
    });

    Object.values(clusters).forEach(group => {
      const loc = locOf(group[0]);
      const isSingle = group.length === 1;

      // Pick colour from the most severe status in the group
      const severity = { deceased: 0, confirmed: 1, suspected: 2, recovered: 3 };
      const worst = group.slice().sort((a, b) => (severity[a.status] ?? 9) - (severity[b.status] ?? 9))[0];
      const gen   = worst.generation ?? 0;
      const color = genColor(gen);
      const size  = isSingle ? 14 : Math.min(14 + group.length * 3, 30);

      const icon = L.divIcon({
        html: isSingle
          ? `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid rgba(255,255,255,0.5);box-shadow:0 0 6px ${color}88"></div>`
          : `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid rgba(255,255,255,0.7);box-shadow:0 0 8px ${color}99;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;font-family:Inter,sans-serif">${group.length}</div>`,
        className: "",
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });

      const m = L.marker([loc.lat, loc.lng], { icon });

      // Popup lists all cases in the group
      const popupRows = group.map(c => {
        const isAuto = (c.reporter || "").includes("Auto-scraped");
        const srcTag = isAuto
          ? `<span style="font-size:9px;color:#f59e0b;background:rgba(245,158,11,0.12);padding:1px 5px;border-radius:3px;border:1px solid rgba(245,158,11,0.25)">⚠ unverified</span>`
          : `<span style="font-size:9px;color:#10b981;background:rgba(16,185,129,0.15);padding:1px 5px;border-radius:3px;border:1px solid rgba(16,185,129,0.3)">✓ verified</span>`;
        return `<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.07);cursor:pointer" class="popup-case-row" data-id="${c.id}">
          <span style="font-size:11px;font-weight:600">${Utils.esc(c.id)}</span>
          <span style="font-size:10px;color:#aaa;margin-left:4px">${c.status}</span>
          ${srcTag}
          <div style="font-size:10px;color:#ccc;margin-top:1px">${Utils.esc(c.name || "—")}</div>
          ${c.onset_date ? `<div style="font-size:10px;color:#888">Onset: ${Utils.toDisplay(c.onset_date)}</div>` : ""}
        </div>`;
      }).join("");

      const locLabel = [loc.city, loc.country].filter(Boolean).join(", ") || "—";
      m.bindPopup(`
        <div style="font-family:Inter,sans-serif;min-width:200px;max-height:260px;overflow-y:auto">
          <div style="font-weight:700;font-size:12px;margin-bottom:6px;color:#fff">${Utils.esc(locLabel)}
            ${group.length > 1 ? `<span style="font-size:10px;color:#aaa;font-weight:400"> · ${group.length} cases</span>` : ""}
          </div>
          ${popupRows}
        </div>
      `, { className: "dark-popup", maxWidth: 260 });

      // Clicking a row in the popup opens that case's detail panel
      m.on("popupopen", () => {
        document.querySelectorAll(".popup-case-row").forEach(row => {
          row.addEventListener("click", () => App.selectCase(row.dataset.id));
        });
      });

      // Single case: clicking the dot opens detail directly
      if (isSingle) m.on("click", () => App.selectCase(group[0].id));

      m.addTo(this._map);
      this._markers.push(m);
    });
  },

  _addShipLayer() {
    // Pinned position — MV Hondius ~200 miles west of Nouadhibou, Mauritania (LiveScience/AP, May 8)
    const shipPos    = [20.9, -20.5];
    const tenerifePos = [28.2916, -16.6291];

    // Glowing ship SVG (teal)
    const shipIcon = L.divIcon({
      html: `
        <div style="filter:drop-shadow(0 0 5px #2dd4bf) drop-shadow(0 0 12px #2dd4bf88)">
          <svg width="36" height="32" viewBox="0 0 36 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M18 4 L18 14" stroke="#2dd4bf" stroke-width="1.8" stroke-linecap="round"/>
            <path d="M18 4 L26 10 L18 10 Z" stroke="#2dd4bf" stroke-width="1.4" fill="rgba(45,212,191,0.08)"/>
            <rect x="11" y="14" width="14" height="5" rx="1" stroke="#2dd4bf" stroke-width="1.6" fill="rgba(45,212,191,0.08)"/>
            <path d="M4 19 L7 26 L29 26 L32 19 Z" stroke="#2dd4bf" stroke-width="1.6" fill="rgba(45,212,191,0.08)"/>
            <path d="M2 28 Q9 25 18 28 Q27 31 34 28" stroke="#2dd4bf" stroke-width="1.2" opacity="0.5" stroke-linecap="round"/>
          </svg>
        </div>`,
      className: "",
      iconSize: [36, 32],
      iconAnchor: [18, 28],
    });

    // Glowing anchor SVG (amber)
    const anchorIcon = L.divIcon({
      html: `
        <div style="filter:drop-shadow(0 0 5px #f97316) drop-shadow(0 0 12px #f9731688)">
          <svg width="28" height="32" viewBox="0 0 28 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="14" cy="5" r="3.5" stroke="#f97316" stroke-width="1.6"/>
            <line x1="14" y1="8.5" x2="14" y2="26" stroke="#f97316" stroke-width="1.6" stroke-linecap="round"/>
            <line x1="7" y1="13" x2="21" y2="13" stroke="#f97316" stroke-width="1.6" stroke-linecap="round"/>
            <path d="M6 26 Q14 31 22 26" stroke="#f97316" stroke-width="1.6" fill="none" stroke-linecap="round"/>
            <line x1="6" y1="22" x2="6" y2="26" stroke="#f97316" stroke-width="1.6" stroke-linecap="round"/>
            <line x1="22" y1="22" x2="22" y2="26" stroke="#f97316" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
        </div>`,
      className: "",
      iconSize: [28, 32],
      iconAnchor: [14, 32],
    });

    // Dashed route line Cape Verde → Tenerife
    const capeVerdePos = [14.933, -23.513];
    L.polyline([capeVerdePos, shipPos, tenerifePos], {
      color: "#2dd4bf",
      weight: 1.5,
      opacity: 0.4,
      dashArray: "6 8",
    }).addTo(this._map);

    // Ship marker
    L.marker(shipPos, { icon: shipIcon, zIndexOffset: 1000 })
      .bindPopup(`
        <div style="font-family:Inter,sans-serif;min-width:180px">
          <div style="font-weight:700;font-size:12px;color:#2dd4bf;margin-bottom:4px">🚢 MV Hondius</div>
          <div style="font-size:11px;color:#ccc">~200 miles west of Nouadhibou, Mauritania · May 8, 2026</div>
          <div style="font-size:11px;color:#aaa;margin-top:4px">Sailing northwest → Tenerife</div>
          <div style="font-size:11px;color:#f97316;margin-top:4px">Expected arrival: Sunday May 10</div>
          <div style="font-size:11px;color:#aaa;margin-top:4px">147 aboard · 23 nationalities · 17 Americans</div>
          <div style="font-size:10px;color:#666;margin-top:6px;font-style:italic">Source: AP / LiveScience, May 8 2026</div>
        </div>`, { className: "dark-popup" })
      .addTo(this._map);

    // Tenerife anchor marker
    L.marker(tenerifePos, { icon: anchorIcon, zIndexOffset: 999 })
      .bindPopup(`
        <div style="font-family:Inter,sans-serif;min-width:180px">
          <div style="font-weight:700;font-size:12px;color:#f97316;margin-bottom:4px">⚓ Tenerife, Canary Islands</div>
          <div style="font-size:11px;color:#ccc">MV Hondius destination — Sunday May 10, 2026</div>
          <div style="font-size:11px;color:#aaa;margin-top:4px">Fully cordoned arrival: isolated area, guarded vehicles, sealed airport section</div>
          <div style="font-size:11px;color:#aaa;margin-top:2px">14 Spanish passengers → military hospital</div>
          <div style="font-size:11px;color:#aaa;margin-top:2px">17 Americans repatriated by US government plane</div>
          <div style="font-size:11px;color:#aaa;margin-top:2px">All others repatriated per Spain Health Minister</div>
        </div>`, { className: "dark-popup" })
      .addTo(this._map);
  },

  _fit() {
    if (!this._markers.length) return;
    const group = L.featureGroup(this._markers);
    this._map.fitBounds(group.getBounds().pad(0.1));
  },

  highlightCase(id, cases) {
    const c = cases.find(x => x.id === id);
    const loc = c?.location && typeof c.location === "object" ? c.location : {};
    if (loc.lat && loc.lng) {
      this._map.setView([loc.lat, loc.lng], 6, { animate: true });
    }
  },

  invalidate() {
    setTimeout(() => this._map?.invalidateSize(), 50);
  },
};

// ============================================================================
// 9b. MapSlider — animated day-by-day outbreak playback
// ============================================================================

const MapSlider = {
  _min: null,
  _max: null,
  _current: null,
  _playing: false,
  _timer: null,
  _SPEED: 650, // ms per day-step

  initUI() {
    const slider  = document.getElementById("map-date-slider");
    const playBtn = document.getElementById("slider-play-btn");
    const resetBtn = document.getElementById("slider-reset-btn");
    if (!slider) return;

    slider.addEventListener("input", () => {
      if (this._min === null) return;
      this._current = Utils.addDays(this._min, parseInt(slider.value, 10));
      this._updateLabel();
      this._applyFilter();
    });

    playBtn?.addEventListener("click", () => {
      if (this._playing) { this._pause(); return; }
      // Rewind if already at end
      if (parseInt(slider.value, 10) >= parseInt(slider.max, 10)) {
        slider.value = 0;
        this._current = new Date(this._min);
        this._updateLabel();
        this._applyFilter();
      }
      this._play();
    });

    resetBtn?.addEventListener("click", () => {
      this._pause();
      const s = document.getElementById("map-date-slider");
      if (s && this._max) {
        s.value = s.max;
        this._current = new Date(this._max);
        this._updateLabel();
        this._applyFilter();
      }
    });
  },

  setRange(cases) {
    const slider = document.getElementById("map-date-slider");
    if (!slider) return;
    const dates = cases.map(c => c.onset_date || c.date).filter(Boolean).sort();
    if (!dates.length) return;
    this._min = Utils.parseDate(dates[0]);
    this._max = Utils.parseDate(dates[dates.length - 1]);
    const totalDays = Utils.daysBetween(this._min, this._max);
    slider.min = 0;
    slider.max = totalDays;
    slider.value = totalDays;
    this._current = new Date(this._max);
    this._updateLabel();
  },

  _play() {
    const slider = document.getElementById("map-date-slider");
    if (!slider || this._min === null) return;
    this._playing = true;
    const btn = document.getElementById("slider-play-btn");
    if (btn) btn.textContent = "⏸ Pause";
    this._timer = setInterval(() => {
      const next = parseInt(slider.value, 10) + 1;
      if (next > parseInt(slider.max, 10)) { this._pause(); return; }
      slider.value = next;
      this._current = Utils.addDays(this._min, next);
      this._updateLabel();
      this._applyFilter();
    }, this._SPEED);
  },

  _pause() {
    this._playing = false;
    clearInterval(this._timer);
    const btn = document.getElementById("slider-play-btn");
    if (btn) btn.textContent = "▶ Play";
  },

  _updateLabel() {
    const label = document.getElementById("slider-date-label");
    if (!label || !this._current || !this._max) return;
    const atMax = Utils.toDateStr(this._current) >= Utils.toDateStr(this._max);
    label.textContent = atMax
      ? "All dates"
      : this._current.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  },

  _applyFilter() {
    if (!this._current) return;
    const cutoff = Utils.toDateStr(this._current);
    const f = Sidebar.getFilter();
    const filtered = App._cases.filter(c => {
      if (!f.status.has(c.status)) return false;
      const g = Math.min(c.generation ?? 0, 3);
      if (!f.gen.has(g)) return false;
      const d = c.onset_date || c.date;
      if (d && d > cutoff) return false;
      return true;
    });
    OverviewTab.render(filtered);
  },
};

// ============================================================================
// 10. ChainTab (Cytoscape.js)
// ============================================================================

const ChainTab = {
  _cy: null,
  _layout: "force",
  _showExposure: true,
  _showFlight: true,

  init() {
    this._cy = cytoscape({
      container: document.getElementById("chain-cy"),
      style: [
        {
          selector: "node[type='case']",
          style: {
            shape: "ellipse",
            width: 36, height: 36,
            "background-color": "data(color)",
            "border-width": 2,
            "border-color": "rgba(255,255,255,0.3)",
            label: "data(label)",
            "font-family": "Inter,sans-serif",
            "font-size": 9,
            color: "#fff",
            "text-valign": "bottom",
            "text-margin-y": 4,
            "text-outline-width": 0,
          },
        },
        {
          selector: "node[type='exposure']",
          style: {
            shape: "rectangle",
            width: 28, height: 18,
            "background-color": "var(--color-node-exposure, #7c3aed)",
            "border-width": 1,
            "border-color": "rgba(255,255,255,0.3)",
            label: "data(label)",
            "font-size": 7,
            color: "#ccc",
            "text-valign": "bottom",
            "text-margin-y": 3,
          },
        },
        {
          selector: "node[type='flight']",
          style: {
            shape: "diamond",
            width: 28, height: 28,
            "background-color": "var(--color-node-flight, #0ea5e9)",
            "border-width": 1,
            "border-color": "rgba(255,255,255,0.3)",
            label: "data(label)",
            "font-size": 7,
            color: "#ccc",
            "text-valign": "bottom",
            "text-margin-y": 4,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "data(color)",
            "target-arrow-color": "data(color)",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.8,
            "curve-style": "bezier",
            opacity: 0.7,
          },
        },
        {
          selector: "node:selected, node.highlighted",
          style: { "border-width": 3, "border-color": "#fff" },
        },
        { selector: "node.dimmed, edge.dimmed", style: { opacity: 0.2 } },
      ],
      layout: { name: "preset" },
    });

    this._cy.on("tap", "node[type='case']", evt => {
      App.selectCase(evt.target.data("id"));
    });

    document.getElementById("layout-force")?.addEventListener("click", () => {
      this._layout = "force";
      document.getElementById("layout-force").classList.add("active");
      document.getElementById("layout-timeline").classList.remove("active");
      this._runLayout();
    });
    document.getElementById("layout-timeline")?.addEventListener("click", () => {
      this._layout = "timeline";
      document.getElementById("layout-timeline").classList.add("active");
      document.getElementById("layout-force").classList.remove("active");
      this._runLayout();
    });
    document.getElementById("show-exposure-nodes")?.addEventListener("change", e => {
      this._showExposure = e.target.checked;
      this._updateVisibility();
    });
    document.getElementById("show-flight-nodes")?.addEventListener("change", e => {
      this._showFlight = e.target.checked;
      this._updateVisibility();
    });
    document.getElementById("chain-fit-btn")?.addEventListener("click", () => {
      this._cy.fit(undefined, 40);
    });
  },

  render(chainData, filter) {
    if (!chainData) return;
    const { nodes, edges } = chainData;

    const elements = [];
    nodes.forEach(n => {
      const skip =
        (n.type === "exposure" && !this._showExposure) ||
        (n.type === "flight" && !this._showFlight);
      if (skip) return;

      if (n.type === "case") {
        const gen = n.generation ?? 0;
        const genKey = gen >= 3 ? 3 : gen;
        if (!filter.status.has(n.status)) return;
        if (!filter.gen.has(genKey)) return;
      }

      const color = n.type === "case" ? genColor(n.generation ?? 0) : undefined;
      elements.push({
        data: {
          id: n.id,
          type: n.type || "case",
          label: n.type === "case" ? n.id : (n.label || n.id),
          color,
          id_orig: n.id,
          generation: n.generation,
          status: n.status,
          date: n.date,
        },
      });
    });

    const nodeIds = new Set(elements.map(e => e.data.id));
    edges.forEach(e => {
      if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) return;
      elements.push({
        data: {
          id: e.id || `${e.source}-${e.target}`,
          source: e.source,
          target: e.target,
          color: edgeColor(e.type),
          type: e.type,
        },
      });
    });

    this._cy.elements().remove();
    this._cy.add(elements);
    this._runLayout();
  },

  _runLayout() {
    if (!this._cy) return;
    const cases = this._cy.nodes("[type='case']");

    if (this._layout === "timeline") {
      let minD = Infinity, maxD = -Infinity;
      cases.forEach(n => {
        const d = Utils.parseDate(n.data("date"))?.getTime();
        if (d) { minD = Math.min(minD, d); maxD = Math.max(maxD, d); }
      });
      const span = maxD - minD || 1;
      const W = this._cy.container().offsetWidth - 80;
      const H = this._cy.container().offsetHeight - 80;

      cases.forEach(n => {
        const d = Utils.parseDate(n.data("date"))?.getTime() ?? minD;
        const x = 40 + ((d - minD) / span) * W;
        const gen = n.data("generation") ?? 0;
        const y = 60 + gen * 100;
        n.position({ x, y });
      });

      this._cy.nodes("[type='exposure']").forEach((n, i) => n.position({ x: 40 + (i * 80) % W, y: H - 40 }));
      this._cy.nodes("[type='flight']").forEach((n, i) => n.position({ x: 40 + (i * 100) % W, y: H - 100 }));
      this._cy.fit(undefined, 40);
    } else {
      this._cy.layout({
        name: "cose",
        animate: true,
        animationDuration: 400,
        randomize: false,
        nodeRepulsion: () => 4000,
        idealEdgeLength: () => 80,
        edgeElasticity: () => 100,
        gravity: 0.3,
        padding: 40,
      }).run();
    }
  },

  _updateVisibility() {
    this._cy.nodes("[type='exposure']").style("display", this._showExposure ? "element" : "none");
    this._cy.nodes("[type='flight']").style("display", this._showFlight ? "element" : "none");
  },

  highlightCase(id) {
    this._cy.elements().removeClass("highlighted dimmed");
    if (!id) return;
    const node = this._cy.getElementById(id);
    if (!node.length) return;
    const connected = node.closedNeighborhood();
    this._cy.elements().addClass("dimmed");
    connected.removeClass("dimmed").addClass("highlighted");
  },

  clearHighlight() {
    this._cy.elements().removeClass("highlighted dimmed");
  },

  invalidate() {
    setTimeout(() => this._cy?.resize(), 50);
  },
};

// ============================================================================
// 11. ExposureTab
// ============================================================================

const ExposureTab = {
  _events: [],
  _cases: [],
  _sortByRisk: true,

  init() {
    document.getElementById("exposure-sort-risk")?.addEventListener("click", () => {
      this._sortByRisk = !this._sortByRisk;
      this._renderTable();
    });
  },

  render(exposureEvents, cases) {
    this._events = exposureEvents;
    this._cases = cases;
    this._renderDeck();
    this._renderTable();
    const badge = document.getElementById("exposure-count-badge");
    if (badge) badge.textContent = `${exposureEvents.length} events`;
  },

  _renderDeck() {
    const container = document.getElementById("deck-view");
    if (!container) return;

    const decks = {};
    this._events.forEach(ev => {
      const d = ev.deck ?? "?";
      if (!decks[d]) decks[d] = [];
      decks[d].push(ev);
    });

    const casesByExp = {};
    this._cases.forEach(c => {
      (c.exposures || []).forEach(eid => {
        if (!casesByExp[eid]) casesByExp[eid] = [];
        casesByExp[eid].push(c);
      });
    });

    const deckNums = Object.keys(decks).sort((a, b) => Number(b) - Number(a));
    container.innerHTML = deckNums.map(dn => {
      const evts = decks[dn];
      return `
        <div class="deck-row">
          <div class="deck-label">Deck ${dn}</div>
          <div class="deck-cells">
            ${evts.map(ev => {
              const ri = RISK_LABELS[ev.transmission_risk] || { label: ev.transmission_risk, cls: "" };
              const cses = casesByExp[ev.id] || [];
              const hasCase = cses.length > 0;
              return `
                <div class="cabin-cell ${hasCase ? "has-case" : "has-exposure"}" title="${Utils.esc(ev.label)}">
                  <div class="cabin-cell-label">${Utils.esc(ev.area || ev.type)}</div>
                  <div class="cabin-cell-zone">${Utils.esc(ev.zone || "")}</div>
                  <div class="cabin-risk-badge ${ri.cls}">${ri.label}</div>
                  ${cses.length ? `<div style="margin-top:4px;font-size:9px">${cses.map(c => Utils.esc(c.id)).join(", ")}</div>` : ""}
                </div>`;
            }).join("")}
          </div>
        </div>`;
    }).join("");
  },

  _renderTable() {
    const container = document.getElementById("exposure-table");
    if (!container) return;

    const sorted = [...this._events].sort((a, b) => {
      return this._sortByRisk ? b.risk_score - a.risk_score : a.date_start.localeCompare(b.date_start);
    });

    const caseMap = {};
    this._cases.forEach(c => { caseMap[c.id] = c; });

    container.innerHTML = sorted.map(ev => {
      const ri = RISK_LABELS[ev.transmission_risk] || { label: ev.transmission_risk, cls: "" };
      const participants = (ev.participants || []).map(pid => {
        const c = caseMap[pid];
        if (!c) return `<span class="participant-tag">${Utils.esc(pid)}</span>`;
        const col = genColor(c.generation ?? 0);
        return `<span class="participant-tag" style="border-color:${col};color:${col};cursor:pointer" onclick="App.selectCase('${Utils.esc(pid)}')">${Utils.esc(pid)}</span>`;
      }).join(" ");

      return `
        <div class="exposure-row">
          <div class="exposure-row-header">
            <span class="exposure-row-label">${Utils.esc(ev.label)}</span>
            <span class="exposure-risk-badge ${ri.cls}">${ri.label}</span>
          </div>
          <div class="exposure-row-meta">
            ${Utils.esc(ev.location)} · ${Utils.toDisplay(ev.date_start)} → ${Utils.toDisplay(ev.date_end)}
            · ${ev.duration_days}d · ${ev.duration_hours_daily}h/day
          </div>
          <div class="exposure-row-risk-bar">
            <div style="width:${Math.round(ev.risk_score * 100)}%;height:4px;background:var(--color-brand);border-radius:2px;opacity:.8"></div>
          </div>
          <div class="exposure-row-participants">${participants}</div>
          ${ev.notes ? `<div class="exposure-row-notes">${Utils.esc(ev.notes)}</div>` : ""}
        </div>`;
    }).join("");
  },
};

// ============================================================================
// 12. FlightRiskTab
// ============================================================================

const FlightRiskTab = {
  _flights: [],
  _selectedFlight: null,
  _riskData: null,

  init() {
    document.getElementById("btn-export-manifest")?.addEventListener("click", () => {
      if (this._selectedFlight) API.exportFlight(this._selectedFlight.id);
    });

    // Seat tooltip
    const tooltip = document.getElementById("seat-tooltip");
    if (tooltip) {
      document.addEventListener("mousemove", e => {
        tooltip.style.left = (e.clientX + 12) + "px";
        tooltip.style.top  = (e.clientY - 8) + "px";
      });
    }
  },

  render(flights) {
    this._flights = flights;
    const list = document.getElementById("flight-list");
    if (!list) return;

    const badge = document.getElementById("tab-badge-flights");
    if (badge) badge.textContent = flights.length;

    list.innerHTML = flights.map(f => `
      <div class="flight-card${this._selectedFlight?.id === f.id ? " selected" : ""}" data-id="${f.id}">
        <div style="font-weight:600;font-size:var(--text-sm)">${Utils.esc(f.flight_number)}</div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted)">${Utils.esc(f.airline)}</div>
        <div style="font-size:var(--text-xs);margin-top:4px">${Utils.esc(f.departure_airport)} → ${Utils.esc(f.arrival_airport)}</div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted)">${Utils.toDisplay(f.date)} · ${Math.round(f.duration_minutes / 60)}h ${f.duration_minutes % 60}m</div>
        <div style="font-size:var(--text-xs);margin-top:4px">${f.aircraft_type}</div>
      </div>
    `).join("");

    list.querySelectorAll(".flight-card").forEach(el => {
      el.addEventListener("click", () => this._selectFlight(el.dataset.id));
    });

    if (this._selectedFlight) {
      const still = flights.find(f => f.id === this._selectedFlight.id);
      if (still) this._selectFlight(still.id);
    }
  },

  async _selectFlight(id) {
    const flight = this._flights.find(f => f.id === id);
    if (!flight) return;
    this._selectedFlight = flight;

    document.querySelectorAll(".flight-card").forEach(el => el.classList.toggle("selected", el.dataset.id === id));
    document.getElementById("flight-panel-title").textContent = `${flight.flight_number} — ${flight.departure_city} → ${flight.arrival_city}`;
    document.getElementById("btn-export-manifest").style.display = "inline-flex";

    try {
      this._riskData = await API.getFlightRisk(id);
      // API enriches manifest entries with risk_score in-place, returns flight.manifest
      const enrichedFlight = this._riskData.flight || flight;
      this._renderSeatMap(enrichedFlight, this._riskData);
      this._renderManifest(enrichedFlight, this._riskData);
    } catch (e) {
      Toast.show("Failed to load flight risk data", "error");
    }
  },

  _renderSeatMap(flight, riskData) {
    const placeholder = document.getElementById("seat-map-placeholder");
    const mapEl = document.getElementById("seat-map");
    if (placeholder) placeholder.style.display = "none";
    if (mapEl) mapEl.style.display = "block";

    const label = document.getElementById("seat-map-flight-label");
    if (label) label.textContent = `${flight.flight_number} · ${flight.aircraft_type} · Layout ${flight.layout}`;

    const grid = document.getElementById("seat-grid");
    if (!grid) return;

    const cols = flight.seat_columns || ["A","B","C","D","E","F"];
    const aisleAfter = flight.aisle_after || [2];
    const totalRows = flight.total_rows || 30;
    const riskZone = flight.risk_zone_rows || 3;

    // Risk scores are embedded directly on manifest entries by the API
    const caseSeats = new Set((flight.manifest || []).filter(p => p.type === "case" && p.infectious).map(p => p.seat));
    const caseSeatRows = [...caseSeats].map(s => parseInt(s, 10)).filter(Boolean);
    const minCaseRow = Math.min(...caseSeatRows);
    const maxCaseRow = Math.max(...caseSeatRows);

    let html = `<div class="seat-row seat-row--header">
      <div class="seat-row-num"></div>`;
    cols.forEach((col, i) => {
      if (aisleAfter.includes(i)) html += `<div class="seat-aisle"></div>`;
      html += `<div class="seat seat--col-label">${col}</div>`;
    });
    html += `</div>`;

    for (let row = 1; row <= totalRows; row++) {
      const inRiskZone = caseSeatRows.length && row >= minCaseRow - riskZone && row <= maxCaseRow + riskZone;
      html += `<div class="seat-row${inRiskZone ? " seat-row--risk-zone" : ""}">
        <div class="seat-row-num">${row}</div>`;

      cols.forEach((col, i) => {
        if (aisleAfter.includes(i)) html += `<div class="seat-aisle"></div>`;
        const seatId = `${row}${col}`;
        const passenger = (flight.manifest || []).find(p => p.seat === seatId);

        let cls = "seat";
        let title = seatId;
        let inner = "";

        if (passenger) {
          const score = passenger.risk_score ?? null;
          if (passenger.type === "case" && passenger.infectious) {
            cls += " seat--case-infectious";
            inner = "✕";
            title = `${seatId} — ${passenger.name || passenger.passenger_id} (INFECTIOUS CASE)`;
          } else if (passenger.type === "case") {
            cls += " seat--case-confirmed";
            inner = "●";
            title = `${seatId} — ${passenger.name || passenger.passenger_id} (Case)`;
          } else if (passenger.type === "contact") {
            cls += " seat--contact";
            if (score !== null) {
              if (score >= 0.7) cls += " seat--risk-high";
              else if (score >= 0.4) cls += " seat--risk-medium";
              else if (score >= 0.15) cls += " seat--risk-low";
              else cls += " seat--risk-minimal";
              inner = `<span style="font-size:8px">${Math.round(score * 100)}%</span>`;
              title = `${seatId} — ${passenger.name} · Risk: ${Math.round(score * 100)}%`;
            }
          }
        } else {
          cls += " seat--empty";
        }

        html += `<div class="${cls}" title="${Utils.esc(title)}"
          onmouseenter="FlightRiskTab._showSeatTooltip(this,'${Utils.esc(title)}')"
          onmouseleave="FlightRiskTab._hideSeatTooltip()">${inner}</div>`;
      });

      html += "</div>";
    }

    grid.innerHTML = html;

    const legend = document.getElementById("seat-map-legend");
    if (legend) {
      legend.innerHTML = `
        <div class="seat-legend-item"><div class="seat seat--case-infectious" style="display:inline-block;width:14px;height:14px"></div> Infectious</div>
        <div class="seat-legend-item"><div class="seat seat--risk-high" style="display:inline-block;width:14px;height:14px"></div> High risk</div>
        <div class="seat-legend-item"><div class="seat seat--risk-medium" style="display:inline-block;width:14px;height:14px"></div> Medium</div>
        <div class="seat-legend-item"><div class="seat seat--risk-low" style="display:inline-block;width:14px;height:14px"></div> Low</div>
        <div class="seat-legend-item"><div class="seat seat--risk-minimal" style="display:inline-block;width:14px;height:14px"></div> Minimal</div>
      `;
    }
  },

  _renderManifest(flight, riskData) {
    const tbody = document.getElementById("manifest-tbody");
    if (!tbody) return;

    const rows = [...(flight.manifest || [])].sort((a, b) => a.seat.localeCompare(b.seat, undefined, { numeric: true }));

    tbody.innerHTML = rows.map(p => {
      // risk_score is embedded on each manifest entry by the API
      const score = p.risk_score ?? (p.type === "case" && p.infectious ? 1.0 : null);
      const level = score === null ? "—" : score >= 0.7 ? "High" : score >= 0.4 ? "Medium" : score >= 0.15 ? "Low" : "Minimal";
      const barColor = score === null ? "transparent" : score >= 0.7 ? "var(--color-risk-high,#ef4444)" : score >= 0.4 ? "var(--color-risk-medium,#f59e0b)" : score >= 0.15 ? "var(--color-risk-low,#eab308)" : "var(--color-risk-minimal,#22c55e)";

      const typeLabel = p.type === "case" ? (p.infectious ? "Case (infectious)" : "Case") : "Contact";
      const statusBadge = p.status ? `<span class="case-item-status case-item-status--${p.status}">${p.status}</span>` : "—";

      return `<tr>
        <td style="font-family:var(--font-mono);font-size:var(--text-xs)">${Utils.esc(p.seat)}</td>
        <td style="font-size:var(--text-xs)">${Utils.esc(p.name || p.passenger_id)}</td>
        <td style="font-size:var(--text-xs)">${typeLabel}</td>
        <td>${statusBadge}</td>
        <td style="font-size:var(--text-xs)">${score !== null ? Math.round(score * 100) + "%" : "—"}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px">
            <div class="risk-bar"><div class="risk-fill" style="width:${score !== null ? Math.round(score * 100) : 0}%;background:${barColor}"></div></div>
            <span style="font-size:var(--text-xs);min-width:40px">${level}</span>
          </div>
        </td>
      </tr>`;
    }).join("");
  },

  _showSeatTooltip(el, text) {
    const t = document.getElementById("seat-tooltip");
    if (!t) return;
    t.textContent = text;
    t.style.display = "block";
  },

  _hideSeatTooltip() {
    const t = document.getElementById("seat-tooltip");
    if (t) t.style.display = "none";
  },
};

// ============================================================================
// 13. TimelineTab (SVG Gantt)
// ============================================================================

const TimelineTab = {
  _data: [],
  _cases: [],
  _sortBy: "onset",
  _svgEl: null,

  init() {
    this._svgEl = document.getElementById("gantt-svg");
    document.getElementById("tl-sort-onset")?.addEventListener("click", () => {
      this._sortBy = "onset";
      document.getElementById("tl-sort-onset").classList.add("active");
      document.getElementById("tl-sort-gen").classList.remove("active");
      this._render();
    });
    document.getElementById("tl-sort-gen")?.addEventListener("click", () => {
      this._sortBy = "gen";
      document.getElementById("tl-sort-gen").classList.add("active");
      document.getElementById("tl-sort-onset").classList.remove("active");
      this._render();
    });
  },

  load(timelineData, cases) {
    this._data = timelineData;
    this._cases = cases;
    this._render();
  },

  _render() {
    if (!this._svgEl || !this._data.length) return;

    const ROW_H = 42;
    const LABEL_W = 130;
    const PAD_T = 36;
    const PAD_B = 20;
    const PAD_R = 20;

    const caseMap = {};
    this._cases.forEach(c => { caseMap[c.id] = c; });

    let rows = [...this._data];
    if (this._sortBy === "onset") {
      rows.sort((a, b) => (a.onset_date || "9").localeCompare(b.onset_date || "9"));
    } else {
      rows.sort((a, b) => {
        const ga = (a.generation ?? caseMap[a.id]?.generation ?? 0);
        const gb = (b.generation ?? caseMap[b.id]?.generation ?? 0);
        return ga - gb || (a.onset_date || "").localeCompare(b.onset_date || "");
      });
    }

    // Determine date range
    let minD = Infinity, maxD = -Infinity;
    rows.forEach(r => {
      const push = d => { if (d) { const t = Utils.parseDate(d)?.getTime(); if (t) { minD = Math.min(minD, t); maxD = Math.max(maxD, t); } } };
      push(r.incubation_start); push(r.onset_date); push(r.infectious_end);
      (r.flights || []).forEach(f => push(f.date));
    });
    if (!isFinite(minD)) return;
    minD -= 86400000 * 2;
    maxD += 86400000 * 4;
    const span = maxD - minD;

    const containerW = this._svgEl.parentElement?.offsetWidth || 900;
    const W = Math.max(600, containerW - 20);
    const chartW = W - LABEL_W - PAD_R;
    const H = PAD_T + rows.length * ROW_H + PAD_B;

    const px = t => LABEL_W + ((t - minD) / span) * chartW;
    const datePx = s => px(Utils.parseDate(s)?.getTime() ?? minD);

    const NS = "http://www.w3.org/2000/svg";
    const _el = (tag, attrs) => {
      const el = document.createElementNS(NS, tag);
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
      return el;
    };
    const _text = (content, attrs) => {
      const el = _el("text", attrs);
      el.textContent = content;
      return el;
    };

    this._svgEl.setAttribute("width", W);
    this._svgEl.setAttribute("height", H);
    this._svgEl.innerHTML = "";

    // Background
    this._svgEl.appendChild(_el("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent" }));

    // Axis — tick marks every 7 days
    const tickStart = new Date(minD);
    tickStart.setDate(tickStart.getDate() - tickStart.getDay());
    let td = tickStart.getTime();
    while (td <= maxD) {
      const x = px(td);
      if (x >= LABEL_W && x <= W - PAD_R) {
        const tick = _el("line", { x1: x, y1: PAD_T - 6, x2: x, y2: H - PAD_B, stroke: "rgba(255,255,255,0.06)", "stroke-width": 1 });
        this._svgEl.appendChild(tick);
        const d = new Date(td);
        const label = d.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
        this._svgEl.appendChild(_text(label, { x, y: PAD_T - 10, "font-size": 9, fill: "rgba(255,255,255,0.3)", "text-anchor": "middle", "font-family": "Inter,sans-serif" }));
      }
      td += 86400000 * 7;
    }

    // Rows
    rows.forEach((r, i) => {
      const y = PAD_T + i * ROW_H;
      const cy = y + ROW_H / 2;
      const c = caseMap[r.id];
      const gen = c?.generation ?? 0;
      const color = genColor(gen);

      // Alternating row bg
      if (i % 2 === 0) {
        this._svgEl.appendChild(_el("rect", { x: 0, y, width: W, height: ROW_H, fill: "rgba(255,255,255,0.015)" }));
      }

      // Row click area
      const clickRect = _el("rect", { x: 0, y, width: W, height: ROW_H, fill: "transparent", cursor: "pointer" });
      clickRect.addEventListener("click", () => App.selectCase(r.id));
      this._svgEl.appendChild(clickRect);

      // Label
      this._svgEl.appendChild(_text(r.id, {
        x: LABEL_W - 8, y: cy - 5,
        "font-size": 10, fill: color, "text-anchor": "end", "font-family": "Inter,sans-serif", "font-weight": 600,
      }));
      if (c?.name) {
        this._svgEl.appendChild(_text(c.name.split(" ")[0], {
          x: LABEL_W - 8, y: cy + 7,
          "font-size": 8, fill: "rgba(255,255,255,0.4)", "text-anchor": "end", "font-family": "Inter,sans-serif",
        }));
      }

      // Incubation window (dashed rect)
      if (r.incubation_start && r.onset_date) {
        const x1 = datePx(r.incubation_start);
        const x2 = datePx(r.onset_date);
        const rEl = _el("rect", {
          x: x1, y: cy - 6, width: Math.max(2, x2 - x1), height: 12,
          fill: "rgba(255,255,255,0.04)", stroke: "rgba(255,255,255,0.18)",
          "stroke-dasharray": "3,2", "stroke-width": 1, rx: 2,
        });
        this._svgEl.appendChild(rEl);
      }

      // Infectious period bar
      if (r.onset_date) {
        const x1 = datePx(r.onset_date);
        const end = r.infectious_end || Utils.toDateStr(Utils.addDays(Utils.parseDate(r.onset_date), 7));
        const x2 = datePx(end);
        const bar = _el("rect", {
          x: x1, y: cy - 5, width: Math.max(2, x2 - x1), height: 10,
          fill: color + "66", rx: 2,
        });
        this._svgEl.appendChild(bar);
      }

      // Onset dot
      if (r.onset_date) {
        const x = datePx(r.onset_date);
        const dot = _el("circle", { cx: x, cy, r: 4, fill: color, stroke: "#fff", "stroke-width": 1.5 });
        this._svgEl.appendChild(dot);
      }

      // Flight events
      (r.flights || []).forEach(f => {
        if (!f.date) return;
        const x = datePx(f.date);
        const t = _text("✈", { x, y: cy + 3, "font-size": 10, fill: "#60a5fa", "text-anchor": "middle", "font-family": "sans-serif" });
        t.style.cursor = "pointer";
        t.setAttribute("title", f.flight_id);
        this._svgEl.appendChild(t);
      });
    });
  },

  highlightCase(id) {
    if (!this._svgEl) return;
    this._svgEl.querySelectorAll(".tl-row-hl").forEach(e => e.remove());
    const rows = this._data;
    const idx = rows.findIndex(r => r.id === id);
    if (idx < 0) return;
    const ROW_H = 42, PAD_T = 36, W = parseInt(this._svgEl.getAttribute("width")) || 900;
    const NS = "http://www.w3.org/2000/svg";
    const hl = document.createElementNS(NS, "rect");
    hl.setAttribute("x", 0);
    hl.setAttribute("y", PAD_T + idx * ROW_H);
    hl.setAttribute("width", W);
    hl.setAttribute("height", ROW_H);
    hl.setAttribute("fill", "rgba(255,255,255,0.05)");
    hl.setAttribute("pointer-events", "none");
    hl.classList.add("tl-row-hl");
    this._svgEl.insertBefore(hl, this._svgEl.firstChild.nextSibling);
  },
};

// ============================================================================
// 14. CaseForm (modal)
// ============================================================================

const CaseForm = {
  _modal: null,
  _onSave: null,

  init(onSave) {
    this._onSave = onSave;
    this._modal = document.getElementById("case-modal");
    if (!this._modal) return;

    document.getElementById("btn-add-case")?.addEventListener("click", () => this.open());
    document.getElementById("modal-cancel")?.addEventListener("click", () => this.close());
    document.getElementById("modal-close")?.addEventListener("click", () => this.close());
    this._modal.querySelector(".modal-overlay")?.addEventListener("click", () => this.close());

    document.getElementById("case-form")?.addEventListener("submit", async e => {
      e.preventDefault();
      await this._submit();
    });
  },

  open(prefill = {}) {
    if (!this._modal) return;
    this._modal.classList.add("open");
    const form = document.getElementById("case-form");
    if (form) form.reset();
    Object.entries(prefill).forEach(([k, v]) => {
      const el = form?.elements[k];
      if (el) el.value = v;
    });
  },

  close() {
    this._modal?.classList.remove("open");
  },

  async _submit() {
    const val = id => document.getElementById(id)?.value || "";
    const lat = parseFloat(val("f-lat"));
    const lng = parseFloat(val("f-lng"));

    const data = {
      name:       val("f-name"),
      status:     val("f-status") || "suspected",
      age:        parseInt(val("f-age"), 10) || undefined,
      sex:        val("f-sex") || undefined,
      date:       val("f-date"),
      onset_date: val("f-onset") || undefined,
      generation: parseInt(val("f-generation"), 10) || 0,
      infected_by: val("f-infected-by") || undefined,
      location: {
        city:    val("f-city"),
        country: val("f-country"),
        venue:   val("f-venue"),
        lat: isNaN(lat) ? undefined : lat,
        lng: isNaN(lng) ? undefined : lng,
      },
      transport: {
        type: val("f-transport-type"),
        id:   val("f-transport-id") || undefined,
      },
      clinical_notes: val("f-notes") || undefined,
      reporter:       val("f-reporter") || undefined,
    };

    if (!data.date) { Toast.show("Report date is required", "warning"); return; }

    try {
      const result = await API.addCase(data);
      Toast.show(`Case ${result.id} added`, "success");
      this.close();
      if (this._onSave) await this._onSave();
    } catch (err) {
      Toast.show("Failed to save case: " + err.message, "error");
    }
  },
};

// ============================================================================
// 15. NewCasesPopup — "new since last visit" modal
// ============================================================================

const NewCasesPopup = {
  _KEY: "epitrace_seen_ids_v1",
  _checked: false,

  _getSeenIds() {
    try { return new Set(JSON.parse(localStorage.getItem(this._KEY)) || []); }
    catch { return new Set(); }
  },

  _saveSeenIds(cases) {
    localStorage.setItem(this._KEY, JSON.stringify(cases.map(c => c.id)));
  },

  check(cases) {
    if (this._checked) return;        // only fire once per page load
    this._checked = true;

    const seen = this._getSeenIds();
    const isFirstVisit = seen.size === 0;
    const newCases = isFirstVisit ? [] : cases.filter(c => !seen.has(c.id));

    this._saveSeenIds(cases);         // update storage with current full list

    if (!isFirstVisit && newCases.length > 0) this._show(newCases);
  },

  _show(newCases) {
    const popup   = document.getElementById("new-cases-popup");
    const countEl = document.getElementById("ncp-count");
    const listEl  = document.getElementById("ncp-list");
    if (!popup || !listEl) return;

    countEl.textContent = `${newCases.length} new case${newCases.length !== 1 ? "s" : ""} added`;

    listEl.innerHTML = newCases.map(c => {
      const isAuto = (c.reporter || "").includes("Auto-scraped");
      const srcBadge = isAuto
        ? `<span class="source-badge source-badge--unverified">⚠ unverified</span>`
        : `<span class="source-badge source-badge--verified">✓ verified</span>`;

      const statusLabel = { confirmed:"CONFIRMED", suspected:"SUSPECTED", recovered:"RECOVERED", deceased:"DECEASED" }[c.status] || c.status?.toUpperCase();
      const loc  = [c.location?.city, c.location?.country].filter(Boolean).join(", ") || "—";
      const date = c.date ? new Date(c.date + "T00:00:00").toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" }) : "—";
      const meta = [
        c.age  ? `${c.age}yo`       : null,
        c.sex  ? (c.sex === "M" || c.sex === "male" ? "Male" : c.sex === "F" || c.sex === "female" ? "Female" : c.sex) : null,
        c.nationality || null,
        c.generation != null ? `Gen ${c.generation}` : null,
      ].filter(Boolean).join(" · ");

      return `<div class="ncp-case" data-id="${c.id}" onclick="NewCasesPopup._clickCase('${c.id}')">
        <div class="ncp-case-top">
          <span class="ncp-dot ncp-dot--${c.status || "suspected"}"></span>
          <span class="ncp-case-status">${statusLabel}</span>
          ${srcBadge}
          <span class="ncp-case-id">${c.id}</span>
        </div>
        <div class="ncp-case-name">${c.name || "Unknown"}</div>
        <div class="ncp-case-meta">📍 ${loc} &nbsp;·&nbsp; 📅 ${date}</div>
        ${meta ? `<div class="ncp-case-meta">${meta}</div>` : ""}
      </div>`;
    }).join("");

    popup.classList.add("open");
    popup.focus();
  },

  _clickCase(id) {
    this.close();
    App.selectCase(id);
  },

  close() {
    document.getElementById("new-cases-popup")?.classList.remove("open");
  },
};

// ============================================================================
// 16. App — main controller
// ============================================================================

const App = {
  _cases: [],
  _exposureEvents: [],
  _flights: [],
  _chainData: null,
  _timelineData: [],
  _selectedId: null,

  async init() {
    Toast.init();
    TabNav.init();
    Sidebar.init(id => this.selectCase(id));
    DateFilter.init();
    DetailPanel.init();
    OverviewTab.init();
    MapSlider.initUI();
    ChainTab.init();
    ExposureTab.init();
    FlightRiskTab.init();
    TimelineTab.init();
    CaseForm.init(() => this.refresh());

    // Tab activation handlers
    TabNav.onActivate("overview", () => OverviewTab.invalidate());
    TabNav.onActivate("chains", () => {
      ChainTab.invalidate();
      if (this._chainData) ChainTab.render(this._chainData, Sidebar.getFilter());
    });
    TabNav.onActivate("exposure", () => {
      ExposureTab.render(this._exposureEvents, this._cases);
    });
    TabNav.onActivate("flights", () => {
      FlightRiskTab.render(this._flights);
    });
    TabNav.onActivate("timeline", () => {
      TimelineTab.load(this._timelineData, this._cases);
    });
    TabNav.onActivate("tracking", () => {
      const iframe = document.getElementById("vessel-finder-frame");
      if (iframe && !iframe.src && iframe.dataset.src) {
        iframe.src = iframe.dataset.src;
      }
    });

    // Controls bar exports
    document.getElementById("btn-export-cases")?.addEventListener("click", () => API.exportCases());
    document.getElementById("btn-export-chain")?.addEventListener("click", () => API.exportTransmission());

    // CSV import
    const csvInput = document.getElementById("csv-file-input");
    document.getElementById("btn-import-csv")?.addEventListener("click", () => csvInput?.click());
    csvInput?.addEventListener("change", async () => {
      if (!csvInput.files[0]) return;
      try {
        const result = await API.importCSV(csvInput.files[0]);
        Toast.show(`Imported ${result.imported} cases`, "success");
        await this.refresh();
      } catch (err) {
        Toast.show("Import failed: " + err.message, "error");
      }
      csvInput.value = "";
    });

    // Map fit
    document.getElementById("btn-map-fit")?.addEventListener("click", () => {});

    // Social share dropdown
    const socialBtn      = document.getElementById("btn-social-share");
    const socialDropdown = document.getElementById("social-dropdown");
    const SITE_URL  = "https://hantavirus.up.railway.app/";
    const SITE_TEXT = "Live hantavirus outbreak tracker for the 2026 MV Hondius cruise ship cluster — 3 deaths, transmission chains mapped case by case. #hantavirus #MVHondius";

    socialBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      socialDropdown?.classList.toggle("open");
    });
    document.addEventListener("click", () => socialDropdown?.classList.remove("open"));

    document.getElementById("share-twitter")?.addEventListener("click", () => {
      const tweet = encodeURIComponent(`${SITE_TEXT}\n\n${SITE_URL}`);
      window.open(`https://twitter.com/intent/tweet?text=${tweet}`, "_blank", "noopener");
      socialDropdown?.classList.remove("open");
    });
    document.getElementById("share-reddit")?.addEventListener("click", () => {
      const title = encodeURIComponent("Live Hantavirus Outbreak Tracker — MV Hondius cruise ship cluster (3 deaths, transmission chains, case by case)");
      window.open(`https://www.reddit.com/submit?url=${encodeURIComponent(SITE_URL)}&title=${title}`, "_blank", "noopener");
      socialDropdown?.classList.remove("open");
    });
    document.getElementById("share-facebook")?.addEventListener("click", () => {
      window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(SITE_URL)}`, "_blank", "noopener");
      socialDropdown?.classList.remove("open");
    });
    document.getElementById("share-copy")?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(SITE_URL);
      Toast.show("Link copied to clipboard!", "success", 3000);
      socialDropdown?.classList.remove("open");
    });

    // Share button
    document.getElementById("btn-share")?.addEventListener("click", async () => {
      const shareData = {
        title: "Hantavirus Outbreak Tracker — MV Hondius",
        text: "Happy Mother's Day 💐 — thought you'd want to see this live hantavirus outbreak tracker following the cruise ship story you've probably been hearing about. Case by case, verified sources, updated daily.",
        url: "https://hantavirus.up.railway.app/",
      };
      if (navigator.share) {
        try { await navigator.share(shareData); } catch (e) { /* user cancelled */ }
      } else {
        const text = `${shareData.text}\n\n${shareData.url}`;
        await navigator.clipboard.writeText(text);
        Toast.show("Copied to clipboard — paste it to share! 💐", "success", 4000);
      }
    });

    await this.refresh();
  },

  async refresh() {
    try {
      const [casesData, statsData, chainData, exposureData, flightsData, timelineData] = await Promise.all([
        API.getCases(),
        API.getStats(),
        API.getTransmissionChain(),
        API.getExposureEvents(),
        API.getFlights(),
        API.getTimeline(),
      ]);

      this._cases = casesData.cases || [];
      MapSlider.setRange(this._cases);
      NewCasesPopup.check(this._cases);   // show "new since last visit" popup once
      this._chainData = chainData;

      // Last updated timestamp
      const tsEl = document.getElementById("header-last-updated");
      if (tsEl) {
        tsEl.textContent = "Updated " + new Date().toLocaleTimeString("en-US", {
          hour: "numeric", minute: "2-digit", timeZoneName: "short"
        });
      }
      this._exposureEvents = exposureData.exposure_events || [];
      this._flights = flightsData.flights || [];
      this._timelineData = timelineData.timeline || [];

      Sidebar.load(this._cases);
      this._updateStats(statsData);

      // Update tab badges
      const chainBadge = document.getElementById("tab-badge-chains");
      if (chainBadge) chainBadge.textContent = (chainData.nodes || []).filter(n => n.type === "case").length;
      const expBadge = document.getElementById("tab-badge-exposure");
      if (expBadge) expBadge.textContent = this._exposureEvents.length;
      const flBadge = document.getElementById("tab-badge-flights");
      if (flBadge) flBadge.textContent = this._flights.length;

      const filter = Sidebar.getFilter();
      OverviewTab.render(this._cases.filter(c => {
        if (!filter.status.has(c.status)) return false;
        const g = Math.min(c.generation ?? 0, 3);
        return filter.gen.has(g);
      }));

      const tab = TabNav.current();
      if (tab === "chains" && this._chainData) ChainTab.render(this._chainData, filter);
      if (tab === "exposure") ExposureTab.render(this._exposureEvents, this._cases);
      if (tab === "flights") FlightRiskTab.render(this._flights);
      if (tab === "timeline") TimelineTab.load(this._timelineData, this._cases);

    } catch (err) {
      Toast.show("Failed to load data: " + err.message, "error");
      console.error(err);
    }
  },

  _updateStats(stats) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v ?? "—"; };
    set("stat-total",     stats.total);
    set("stat-confirmed", stats.confirmed);
    set("stat-suspected", stats.suspected);
    set("stat-recovered", stats.recovered);
    set("stat-deceased",  stats.deceased);

    const gens = stats.generations || {};
    set("stat-gen-0", gens["0"] ?? 0);
    set("stat-gen-1", gens["1"] ?? 0);
    const g2plus = Object.entries(gens)
      .filter(([k]) => parseInt(k, 10) >= 2)
      .reduce((s, [, v]) => s + v, 0);
    set("stat-gen-2plus", g2plus);
  },

  async selectCase(id) {
    this._selectedId = id;
    Sidebar.select(id);
    OverviewTab.highlightCase(id, this._cases);
    ChainTab.highlightCase(id);
    TimelineTab.highlightCase(id);

    try {
      const c = await API.getCase(id);
      DetailPanel.show(c, this._chainData?.edges, this._exposureEvents, this._flights);
    } catch (e) {
      Toast.show("Failed to load case detail", "error");
    }
  },

  clearSelection() {
    this._selectedId = null;
    Sidebar.select(null);
    ChainTab.clearHighlight();
    DetailPanel.hide();
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());
