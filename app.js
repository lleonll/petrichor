"use strict";

// ── Constants ──────────────────────────────────────────────────────────────────
const BOM_API       = "https://api.weather.bom.gov.au/v1";
const OPEN_METEO    = "https://archive-api.open-meteo.com/v1/archive";
const GEOHASH_CHARS = "0123456789bcdefghjkmnpqrstuvwxyz";
const CURRENT_YEAR  = new Date().getFullYear();
const HISTORY_START = 1940;
const SERIF         = "Georgia, 'Times New Roman', serif";

// ── DOM refs ───────────────────────────────────────────────────────────────────
const locationInput   = document.getElementById("location-input");
const suggestions     = document.getElementById("suggestions");
const yearSelect      = document.getElementById("year-select");
const chartStatus     = document.getElementById("chart-status");
const canvasContainer = document.getElementById("canvas-container");
const canvas          = document.getElementById("rainfall-canvas");
const obsStrip        = document.getElementById("obs-strip");

// ── App state ──────────────────────────────────────────────────────────────────
let processedData  = null;
let selectedYear   = CURRENT_YEAR;
let chart          = null;
let resizeObserver = null;

// ── Geohash decode ─────────────────────────────────────────────────────────────
function decodeGeohash(hash) {
  let minLat = -90, maxLat = 90, minLon = -180, maxLon = 180, isLon = true;
  for (const ch of hash) {
    const idx = GEOHASH_CHARS.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid geohash character: ${ch}`);
    for (let bits = 4; bits >= 0; bits--) {
      const bit = (idx >> bits) & 1;
      if (isLon) { const mid = (minLon + maxLon) / 2; if (bit) minLon = mid; else maxLon = mid; }
      else        { const mid = (minLat + maxLat) / 2; if (bit) minLat = mid; else maxLat = mid; }
      isLon = !isLon;
    }
  }
  return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
}

// ── Date helpers ───────────────────────────────────────────────────────────────
function yesterday() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function dayOfYear(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.min(Math.round((new Date(y, m-1, d) - new Date(y, 0, 1)) / 86400000), 364);
}

// ── Data processing ────────────────────────────────────────────────────────────
function processRainfallData(omData) {
  const dates  = omData.daily.time;
  const precip = omData.daily.precipitation_sum;

  const rawByYear = new Map();
  for (let i = 0; i < dates.length; i++) {
    const val = precip[i];
    if (val == null || isNaN(val)) continue;
    const year = parseInt(dates[i].slice(0, 4), 10);
    if (year < HISTORY_START) continue;
    if (!rawByYear.has(year)) rawByYear.set(year, new Float32Array(365));
    rawByYear.get(year)[dayOfYear(dates[i])] += val;
  }

  const cumByYear = new Map();
  for (const [year, raw] of rawByYear) {
    const cum = new Float64Array(365);
    let r = 0;
    for (let d = 0; d < 365; d++) { r += raw[d]; cum[d] = r; }
    cumByYear.set(year, cum);
  }

  let currentYearLastDay = -1;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (parseInt(dates[i].slice(0, 4), 10) === CURRENT_YEAR && precip[i] != null) {
      currentYearLastDay = dayOfYear(dates[i]); break;
    }
  }

  const avgCum = new Float64Array(365), counts = new Int32Array(365);
  for (const [year, cum] of cumByYear) {
    if (year === CURRENT_YEAR) continue;
    for (let d = 0; d < 365; d++) { avgCum[d] += cum[d]; counts[d]++; }
  }
  for (let d = 0; d < 365; d++) avgCum[d] = counts[d] > 0 ? avgCum[d] / counts[d] : 0;

  return { cumByYear, rawByYear, avgCum, currentYearLastDay };
}

// ── API ────────────────────────────────────────────────────────────────────────
async function searchLocations(query) {
  const res = await fetch(`${BOM_API}/locations?search=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`BoM API ${res.status}`);
  return (await res.json()).data ?? [];
}

async function fetchRainfallHistory(lat, lon) {
  const url = `${OPEN_METEO}?latitude=${lat}&longitude=${lon}&start_date=${HISTORY_START}-01-01&end_date=${yesterday()}&daily=precipitation_sum&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  return res.json();
}

async function fetchBomObs(geohash6) {
  try {
    const res = await fetch(`${BOM_API}/locations/${geohash6}/observations`);
    if (!res.ok) return null;
    return (await res.json()).data ?? null;
  } catch { return null; }
}

// ── RainfallChart ──────────────────────────────────────────────────────────────
class RainfallChart {
  constructor(canvas, data, selectedYear, onYearSelect) {
    this.canvas             = canvas;
    this.ctx                = canvas.getContext("2d");
    this.cumByYear          = data.cumByYear;
    this.rawByYear          = data.rawByYear;
    this.avgCum             = data.avgCum;
    this.currentYearLastDay = data.currentYearLastDay;
    this.selectedYear       = selectedYear;
    this.onYearSelect       = onYearSelect;
    this.mouse     = null;
    this.hoverYear = null;

    canvas.addEventListener("mousemove",  e => this._onMouseMove(e));
    canvas.addEventListener("mouseleave", () => { this.mouse = null; this.hoverYear = null; canvas.style.cursor = ""; this.draw(); });
    canvas.addEventListener("click", () => {
      if (this.selectedYear !== CURRENT_YEAR) this._deselectYear();
      else if (this.hoverYear !== null) this._selectYear(this.hoverYear);
    });

    canvas.addEventListener("touchstart", e => {
      e.preventDefault();
      const t = e.touches[0];
      const r = canvas.getBoundingClientRect();
      this._handlePointer(t.clientX - r.left, t.clientY - r.top, true);
    }, { passive: false });
    canvas.addEventListener("touchend", () => { this.mouse = null; this.hoverYear = null; this.draw(); });
  }

  setSelectedYear(year) { this.selectedYear = year; this.draw(); }

  _selectYear(year) {
    this.selectedYear = year;
    this.hoverYear    = null;
    this.canvas.style.cursor = "";
    this.onYearSelect?.(year);
    this.draw();
  }

  _deselectYear() {
    this.selectedYear = CURRENT_YEAR;
    this.hoverYear    = null;
    this.canvas.style.cursor = "";
    this.onYearSelect?.(CURRENT_YEAR);
    this.draw();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.parentElement.clientWidth;
    const h = this.canvas.parentElement.clientHeight;
    this.canvas.width  = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._cssW = w; this._cssH = h;
    this.draw();
  }

  _layout() {
    const W = this._cssW, H = this._cssH;
    const narrow = W < 500;
    const mL = narrow ? 38 : 54;
    const mR = narrow ? 70 : 120; // 120 gives room for the pill label on desktop
    const mT = 16, mB = narrow ? 28 : 34;
    const plotW = W - mL - mR, plotH = H - mT - mB;

    let yMax = 0;
    for (const cum of this.cumByYear.values())
      for (let d = 0; d < 365; d++) if (cum[d] > yMax) yMax = cum[d];
    const rawInt  = yMax / 6;
    const mag     = Math.pow(10, Math.floor(Math.log10(rawInt || 1)));
    const gridInt = [1, 2, 2.5, 5, 10].map(f => f * mag).find(i => i >= rawInt) ?? mag * 10;
    yMax = Math.ceil(yMax / gridInt) * gridInt;

    const xScale = doy => mL + (doy / 364) * plotW;
    const yScale = mm  => mT + plotH - (mm / yMax) * plotH;
    return { W, H, mL, mR, mT, mB, plotW, plotH, yMax, gridInt, xScale, yScale, narrow };
  }

  draw() {
    const ctx = this.ctx;
    const L   = this._layout();
    const { W, H, mL, mT, mB, plotW, plotH, yMax, gridInt, xScale, yScale, narrow } = L;
    const plotBottom = mT + plotH;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fafaf8";
    ctx.fillRect(0, 0, W, H);

    const histYears   = [...this.cumByYear.keys()].filter(y => y !== this.selectedYear).sort((a, b) => a - b);
    const yearSpan    = (CURRENT_YEAR - 1) - HISTORY_START || 1;
    const exploration = this.selectedYear === CURRENT_YEAR;
    const dimming     = exploration && this.hoverYear !== null;

    // ── Grid ──────────────────────────────────────────────────────────────────
    ctx.setLineDash([]);
    for (let mm = 0; mm <= yMax; mm += gridInt) {
      const y = yScale(mm);
      ctx.strokeStyle = "rgba(0,0,0,0.055)"; ctx.lineWidth = 0.75;
      ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(mL + plotW, y); ctx.stroke();
      if (mm > 0) {
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.font = `10px ${SERIF}`;
        ctx.textAlign = "right"; ctx.textBaseline = "middle";
        ctx.fillText(mm >= 1000 ? (mm/1000).toFixed(mm % 1000 === 0 ? 0 : 1) + "k" : mm, mL - 6, y);
      }
    }

    // ── Month labels ───────────────────────────────────────────────────────────
    const MONTHS       = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const MONTH_STARTS = [0,31,59,90,120,151,181,212,243,273,304,334];
    // On narrow screens skip alternate months to avoid crowding
    const monthStep = narrow ? 2 : 1;
    ctx.fillStyle = "rgba(0,0,0,0.32)"; ctx.font = `${narrow ? 9 : 10}px var(--font, sans-serif)`;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let i = 0; i < 12; i += monthStep) {
      const x = xScale(MONTH_STARTS[i]);
      ctx.fillText(MONTHS[i], x, plotBottom + 5);
      ctx.strokeStyle = "rgba(0,0,0,0.1)"; ctx.lineWidth = 0.5; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x, plotBottom); ctx.lineTo(x, plotBottom + 4); ctx.stroke();
    }

    // ── Historical lines ───────────────────────────────────────────────────────
    for (const year of histYears) {
      if (year === this.hoverYear) continue;
      const cum     = this.cumByYear.get(year);
      const recency = (year - HISTORY_START) / yearSpan;
      let   opacity = 0.04 + recency * 0.22;
      if (dimming) opacity *= 0.35;
      ctx.strokeStyle = `rgba(60,90,130,${opacity.toFixed(3)})`;
      ctx.lineWidth   = 0.5 + recency * 0.6; ctx.setLineDash([]);
      ctx.beginPath();
      for (let d = 0; d < 365; d++) {
        const x = xScale(d), y = yScale(cum[d]);
        if (d === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // ── Hovered year line (exploration mode only) ────────────────────────────
    if (exploration && this.hoverYear !== null) {
      const cum = this.cumByYear.get(this.hoverYear);
      ctx.strokeStyle = "rgba(60,90,130,0.7)"; ctx.lineWidth = 1.75; ctx.setLineDash([]);
      ctx.beginPath();
      for (let d = 0; d < 365; d++) {
        const x = xScale(d), y = yScale(cum[d]);
        if (d === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // ── Average line ───────────────────────────────────────────────────────────
    ctx.strokeStyle = "rgba(80,80,80,0.5)"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
    ctx.beginPath();
    for (let d = 0; d < 365; d++) {
      const x = xScale(d), y = yScale(this.avgCum[d]);
      if (d === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.setLineDash([]);
    if (!narrow) {
      ctx.fillStyle = "rgba(80,80,80,0.6)";
      ctx.font = `10px ${SERIF}`;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(`avg · ${Math.round(this.avgCum[364])}mm`, xScale(364) + 5, yScale(this.avgCum[364]));
    }

    // ── Selected year ──────────────────────────────────────────────────────────
    const selCum      = this.cumByYear.get(this.selectedYear);
    const isCurrentCal = this.selectedYear === CURRENT_YEAR;
    const selLastDoy   = isCurrentCal ? this.currentYearLastDay : 364;

    if (selCum && selLastDoy >= 0) {
      // Area fill
      const grad = ctx.createLinearGradient(0, mT, 0, mT + plotH);
      grad.addColorStop(0, "rgba(30,60,120,0.10)");
      grad.addColorStop(1, "rgba(30,60,120,0.00)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(xScale(0), yScale(0));
      for (let d = 0; d <= selLastDoy; d++) ctx.lineTo(xScale(d), yScale(selCum[d]));
      ctx.lineTo(xScale(selLastDoy), yScale(0));
      ctx.closePath(); ctx.fill();

      // Line
      ctx.strokeStyle = "#1e3a6e"; ctx.lineWidth = 2.5; ctx.setLineDash([]);
      ctx.beginPath();
      for (let d = 0; d <= selLastDoy; d++) {
        const x = xScale(d), y = yScale(selCum[d]);
        if (d === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Endpoint dot
      const endX = xScale(selLastDoy), endY = yScale(selCum[selLastDoy]);
      ctx.fillStyle = "#1e3a6e";
      ctx.beginPath(); ctx.arc(endX, endY, 3, 0, Math.PI * 2); ctx.fill();

      // Inverted pill label
      const pillText = narrow
        ? `${this.selectedYear}`
        : `${this.selectedYear} · ${Math.round(selCum[selLastDoy])}mm`;
      ctx.font = `bold ${narrow ? 10 : 11}px ${SERIF}`;
      const textW  = ctx.measureText(pillText).width;
      const padX   = 7, padY = 4, pillH = 20;
      const pillW  = textW + padX * 2;
      let   pillX  = endX + 7;
      // Flip to left of dot if it would overflow the canvas
      if (pillX + pillW > W - 4) pillX = endX - pillW - 7;
      const pillY  = endY - pillH / 2;

      ctx.fillStyle = "#1e3a6e";
      this._roundRect(ctx, pillX, pillY, pillW, pillH, 4);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.font = `bold ${narrow ? 10 : 11}px ${SERIF}`;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(pillText, pillX + padX, endY);
    }

    // ── Last 5 historical year labels ──────────────────────────────────────────
    if (!narrow) {
      const recent5 = histYears.slice(-5);
      ctx.font = `10px ${SERIF}`;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      for (const year of recent5) {
        if (year === this.hoverYear) continue;
        const cum     = this.cumByYear.get(year);
        const recency = (year - HISTORY_START) / yearSpan;
        ctx.fillStyle = dimming
          ? `rgba(60,90,130,${((0.35 + recency * 0.35) * 0.35).toFixed(3)})`
          : `rgba(60,90,130,${(0.35 + recency * 0.35).toFixed(3)})`;
        ctx.fillText(`${year} · ${Math.round(cum[364])}mm`, xScale(364) + 5, yScale(cum[364]));
      }
    }

    // ── Hover overlay ──────────────────────────────────────────────────────────
    if (this.mouse) this._drawHover(ctx, L, histYears);
  }

  _onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    this._handlePointer(e.clientX - rect.left, e.clientY - rect.top, false);
  }

  _handlePointer(mx, my, selectOnHit) {
    this.mouse = { x: mx, y: my };
    const { mL, mT, plotW, plotH, yScale } = this._layout();
    const plotBottom = mT + plotH;
    const inPlot = mx >= mL && mx <= mL + plotW && my >= mT && my <= plotBottom;

    // Locked mode: a past year is selected — click anywhere to return to current year
    if (this.selectedYear !== CURRENT_YEAR) {
      this.hoverYear = null;
      this.canvas.style.cursor = inPlot ? "pointer" : "";
      if (selectOnHit && inPlot) this._deselectYear();
      else this.draw();
      return;
    }

    // Exploration mode: current year is selected, hover to preview other years
    if (!inPlot) {
      this.hoverYear = null; this.canvas.style.cursor = ""; this.draw(); return;
    }

    const doy       = Math.max(0, Math.min(364, Math.round(((mx - mL) / plotW) * 364)));
    const histYears = [...this.cumByYear.keys()].filter(y => y !== CURRENT_YEAR);
    const threshold = selectOnHit ? 40 : 16;

    let nearest = null, minDist = threshold;
    for (const year of histYears) {
      const dist = Math.abs(my - yScale(this.cumByYear.get(year)[doy]));
      if (dist < minDist) { minDist = dist; nearest = year; }
    }

    if (selectOnHit) {
      if (nearest !== null) this._selectYear(nearest);
      return;
    }

    this.hoverYear = nearest;
    this.canvas.style.cursor = nearest !== null ? "pointer" : "";
    this.draw();
  }

  _drawHover(ctx, L, histYears) {
    const { mL, mT, plotW, plotH, xScale, yScale, W } = L;
    const { x: mx, y: my } = this.mouse;
    const plotBottom = mT + plotH;
    if (mx < mL || mx > mL + plotW || my < mT || my > plotBottom) return;

    const doy   = Math.max(0, Math.min(364, Math.round(((mx - mL) / plotW) * 364)));
    const lineX = xScale(doy);

    // Vertical rule
    ctx.strokeStyle = "rgba(0,0,0,0.12)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(lineX, mT); ctx.lineTo(lineX, plotBottom); ctx.stroke();
    ctx.setLineDash([]);

    // Dot on selected year line
    const selCum       = this.cumByYear.get(this.selectedYear);
    const isCurrentCal = this.selectedYear === CURRENT_YEAR;
    const selLastDoy   = isCurrentCal ? this.currentYearLastDay : 364;
    if (selCum && doy <= selLastDoy) {
      const dotY = yScale(selCum[doy]);
      ctx.fillStyle = "#1e3a6e"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(lineX, dotY, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    // Tooltip
    const lines = [{ text: this._dayToDate(doy), style: "date" }];

    if (this.hoverYear !== null) {
      const raw = this.rawByYear.get(this.hoverYear);
      const cum = this.cumByYear.get(this.hoverYear);
      if (raw) lines.push({ text: `daily: ${raw[doy].toFixed(1)}mm`, style: "daily" });
      lines.push({ text: `${this.hoverYear}: ${cum[doy].toFixed(1)}mm`, style: "hover" });
      lines.push({ text: "click to highlight", style: "hint" });
    }

    if (selCum && doy <= selLastDoy) {
      const selRaw = this.rawByYear.get(this.selectedYear);
      if (selRaw && !this.hoverYear) lines.push({ text: `daily: ${selRaw[doy].toFixed(1)}mm`, style: "daily" });
      lines.push({ text: `${this.selectedYear}: ${selCum[doy].toFixed(1)}mm`, style: "sel" });
      if (this.selectedYear !== CURRENT_YEAR) lines.push({ text: "click to return to current year", style: "hint" });
    }

    lines.push({ text: `avg: ${this.avgCum[doy].toFixed(1)}mm`, style: "muted" });

    if (!this.hoverYear && histYears.length > 0) {
      let lo = Infinity, hi = -Infinity;
      for (const y of histYears) { const v = this.cumByYear.get(y)[doy]; if (v < lo) lo = v; if (v > hi) hi = v; }
      lines.push({ text: `range: ${Math.round(lo)}–${Math.round(hi)}mm`, style: "muted" });
    }

    const PAD = 9, LINE_H = 16, BOX_W = 162, BOX_H = PAD * 2 + lines.length * LINE_H - 3;
    let boxX = lineX + 12;
    if (boxX + BOX_W > W - 8) boxX = lineX - BOX_W - 12;
    const boxY = Math.min(Math.max(my - BOX_H / 2, mT + 4), plotBottom - BOX_H - 4);

    ctx.shadowColor = "rgba(0,0,0,0.09)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
    ctx.fillStyle = "rgba(255,255,254,0.97)"; ctx.strokeStyle = "rgba(0,0,0,0.09)"; ctx.lineWidth = 1;
    this._roundRect(ctx, boxX, boxY, BOX_W, BOX_H, 5); ctx.fill(); ctx.stroke();
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

    ctx.textBaseline = "top"; ctx.textAlign = "left";
    const SANS = "-apple-system, system-ui, sans-serif";
    for (let i = 0; i < lines.length; i++) {
      const { text, style } = lines[i];
      const ty = boxY + PAD + i * LINE_H;
      if      (style === "date")  { ctx.font = `600 11px ${SANS}`;    ctx.fillStyle = "#1c1c1c"; }
      else if (style === "daily") { ctx.font = `11px ${SANS}`;        ctx.fillStyle = "#444"; }
      else if (style === "hover") { ctx.font = `600 11px ${SANS}`;    ctx.fillStyle = "rgba(40,75,140,0.9)"; }
      else if (style === "sel")   { ctx.font = `600 11px ${SANS}`;    ctx.fillStyle = "#1e3a6e"; }
      else if (style === "hint")  { ctx.font = `italic 10px ${SANS}`; ctx.fillStyle = "rgba(40,75,140,0.45)"; }
      else                        { ctx.font = `11px ${SANS}`;        ctx.fillStyle = "#777"; }
      ctx.fillText(text, boxX + PAD, ty);
    }
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  _dayToDate(doy) {
    const MS = [0,31,59,90,120,151,181,212,243,273,304,334];
    const MN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    let m = 11;
    for (let i = 0; i < 12; i++) { if (MS[i] > doy) { m = i - 1; break; } }
    return `${doy - MS[m] + 1} ${MN[m]}`;
  }
}

// ── Location autocomplete ──────────────────────────────────────────────────────
let searchTimer = null;

locationInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = locationInput.value.trim();
  hideSuggestions();
  if (q.length < 2) return;
  searchTimer = setTimeout(() => doSearch(q), 300);
});

locationInput.addEventListener("keydown", e => { if (e.key === "Escape") hideSuggestions(); });
document.addEventListener("click", e => { if (!e.target.closest(".location-wrap")) hideSuggestions(); });

async function doSearch(q) {
  try { renderSuggestions(await searchLocations(q)); } catch { hideSuggestions(); }
}

function renderSuggestions(locs) {
  if (!locs.length) { hideSuggestions(); return; }
  suggestions.innerHTML = "";
  for (const loc of locs) {
    const li = document.createElement("li");
    li.className = "suggestion-item";
    li.setAttribute("role", "option");
    const meta = [loc.state, loc.postcode].filter(Boolean).join(" ");
    li.innerHTML = `<span class="sug-name">${esc(loc.name)}</span><span class="sug-meta">${esc(meta)}</span>`;
    li.addEventListener("mousedown", e => { e.preventDefault(); selectLocation(loc); });
    suggestions.appendChild(li);
  }
  suggestions.hidden = false;
}

function hideSuggestions() { suggestions.hidden = true; suggestions.innerHTML = ""; }

async function selectLocation(loc) {
  hideSuggestions();
  locationInput.value = loc.name;
  locationInput.blur();
  await loadLocation(loc);
}

// ── Year selector ──────────────────────────────────────────────────────────────
yearSelect.addEventListener("change", () => {
  const y = parseInt(yearSelect.value, 10);
  if (!processedData?.cumByYear.has(y)) return;
  selectedYear = y;
  chart?.setSelectedYear(y);
});

function populateYearSelector(cumByYear) {
  const years = [...cumByYear.keys()].sort((a, b) => b - a);
  yearSelect.innerHTML = "";
  for (const y of years) {
    const opt = new Option(y, y);
    if (y === selectedYear) opt.selected = true;
    yearSelect.appendChild(opt);
  }
  yearSelect.disabled = false;
}

// ── Load location ──────────────────────────────────────────────────────────────
async function loadLocation(loc) {
  setStatus("Loading rainfall data…");
  canvasContainer.hidden = true;
  obsStrip.textContent = "";
  yearSelect.disabled = true;

  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
  chart = null;

  let lat, lon;
  try { ({ lat, lon } = decodeGeohash(loc.geohash)); }
  catch (e) { setStatus(`Error: ${e.message}`); return; }

  const [omRes, obsRes] = await Promise.allSettled([
    fetchRainfallHistory(lat, lon),
    fetchBomObs(loc.geohash.slice(0, 6)),
  ]);

  if (obsRes.status === "fulfilled" && obsRes.value) {
    const obs = obsRes.value, parts = [];
    if (obs.rain_since_9am != null) parts.push(`Rain since 9am: ${obs.rain_since_9am}mm`);
    if (obs.temp != null) parts.push(`${obs.temp}°C`);
    obsStrip.textContent = parts.join("  ·  ");
    if (obs.station?.name) locationInput.value = obs.station.name;
  }

  if (omRes.status === "rejected") {
    setStatus(`Failed to load data: ${omRes.reason?.message ?? "unknown error"}`); return;
  }

  try { processedData = processRainfallData(omRes.value); }
  catch (e) { setStatus(`Error processing data: ${e.message}`); return; }

  if (!processedData.cumByYear.has(selectedYear)) {
    selectedYear = processedData.cumByYear.has(CURRENT_YEAR)
      ? CURRENT_YEAR
      : Math.max(...processedData.cumByYear.keys());
  }

  populateYearSelector(processedData.cumByYear);
  setStatus("");
  canvasContainer.hidden = false;

  chart = new RainfallChart(canvas, processedData, selectedYear, (year) => {
    selectedYear = year ?? CURRENT_YEAR;
    yearSelect.value = String(selectedYear);
  });
  chart.resize();

  resizeObserver = new ResizeObserver(() => chart?.resize());
  resizeObserver.observe(canvasContainer);
}

function setStatus(msg) {
  chartStatus.textContent = msg;
  chartStatus.hidden = !msg;
}

function esc(str) {
  return String(str ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Boot ───────────────────────────────────────────────────────────────────────
(async () => {
  setStatus("Loading…");
  try {
    const locs  = await searchLocations("Perth Airport");
    const perth = locs.find(l => l.name === "Perth Airport" && l.state === "WA") ?? locs[0];
    if (perth) { locationInput.value = perth.name; await loadLocation(perth); }
    else setStatus("Search for a location to get started.");
  } catch { setStatus("Search for a location to get started."); }
})();
