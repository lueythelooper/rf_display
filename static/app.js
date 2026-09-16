// ---- DOM ----
const el = (id) => document.getElementById(id);
const canvas = el("plot");
const ctx = canvas.getContext("2d", { alpha: false });
const statusEl = el("status");
const statusText = el("statusText");
const errorMsg = el("errorMsg");
const frameInfo = el("frameInfo");
const fpsInfo = el("fpsInfo");
const plotArea = el("plotArea");
const zoomBtn = el("zoomBtn");
const autoscaleBtn = el("autoscaleBtn");
const zoomRectOverlay = el("zoomRectOverlay");
const freqAxisEl = el("freqAxis");

const endpointInput = el("endpoint");
const applyBtn = el("applyBtn");
const detectedInfo = el("detectedInfo");
const channelField = el("channelField");
const channelSelect = el("channelSelect");
const plotTypeSelect = el("plotType");
const minDbInput = el("minDb");
const maxDbInput = el("maxDb");
const historyRowsInput = el("historyRows");

// ---- state ----
// The wire format is self-describing (4-byte header per ZMQ message: samples
// per RF channel, RF channel count, FFT-vs-time-domain type). None of that
// is configured client-side — it's reported back by the server once it has
// seen the first packet, via "status" websocket messages.
let ws = null;
let numBins = null; // spectrum bins per frame reported by the server
let numRfChannels = null;
let dataType = null;
let selectedChannel = 0;
let centerFreqHz = null; // from the packet header; null until the first frame arrives
let sampleRateHz = null;
let historyRows = parseInt(historyRowsInput.value, 10);
let plotType = plotTypeSelect.value;
let lastMagnitude = null;
let waterfallRow = 0; // number of rows written so far (caps at historyRows)
let frameCount = 0;
let fpsWindowStart = performance.now();
let fpsWindowCount = 0;

// Zoom: a bin sub-range (frequency axis, both plot types) and a dB sub-range
// (amplitude axis — vertical scale on the magnitude plot, color scale on the
// waterfall). null means "no override, use the full/default value".
let zoomBinStart = 0;
let zoomBinEnd = null; // null => numBins
let zoomMinDb = null; // null => minDbInput.value
let zoomMaxDb = null; // null => maxDbInput.value
let zoomModeActive = false;
let dragState = null; // {startX, startY} in plotArea-relative CSS pixels while dragging

canvas.style.imageRendering = "pixelated";

function effectiveBinRange() {
  const start = Math.max(0, zoomBinStart);
  const end = zoomBinEnd == null ? numBins : Math.min(zoomBinEnd, numBins);
  return [start, Math.max(start + 1, end)];
}

function effectiveDbRange() {
  const lo = zoomMinDb == null ? parseFloat(minDbInput.value) : zoomMinDb;
  const hi = zoomMaxDb == null ? parseFloat(maxDbInput.value) : zoomMaxDb;
  return [lo, hi];
}

// ---- frequency axis ----
// Per-bin frequency, matching np.fft.fftshift's convention: the center bin
// (numBins // 2) corresponds to center_freq_hz, and each bin steps by
// sample_rate_hz / numBins.
function binFreq(i) {
  const centerBin = Math.floor(numBins / 2);
  return centerFreqHz + (i - centerBin) * (sampleRateHz / numBins);
}

function formatFreq(hz) {
  const abs = Math.abs(hz);
  if (abs >= 1e9) return (hz / 1e9).toFixed(3) + " GHz";
  if (abs >= 1e6) return (hz / 1e6).toFixed(3) + " MHz";
  if (abs >= 1e3) return (hz / 1e3).toFixed(3) + " kHz";
  return hz.toFixed(0) + " Hz";
}

function pickBinTicks(bs, be, count) {
  const ticks = [];
  for (let k = 0; k < count; k++) {
    const frac = count === 1 ? 0 : k / (count - 1);
    const bin = Math.round(bs + frac * (be - bs - 1));
    ticks.push({ bin, frac });
  }
  return ticks;
}

function renderFreqAxisStrip() {
  freqAxisEl.innerHTML = "";
  if (!numBins || centerFreqHz == null || sampleRateHz == null) return;
  const [bs, be] = effectiveBinRange();
  for (const { bin, frac } of pickBinTicks(bs, be, 6)) {
    const span = document.createElement("span");
    span.style.left = `${frac * 100}%`;
    span.textContent = formatFreq(binFreq(bin));
    freqAxisEl.appendChild(span);
  }
}

// ---- colormap (jet-like) ----
const STOPS = [
  [0.0, 0, 0, 130],
  [0.15, 0, 0, 255],
  [0.35, 0, 255, 255],
  [0.5, 0, 255, 0],
  [0.65, 255, 255, 0],
  [0.85, 255, 0, 0],
  [1.0, 128, 0, 0],
];

function colormap(t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [t0, r0, g0, b0] = STOPS[i];
    const [t1, r1, g1, b1] = STOPS[i + 1];
    if (t >= t0 && t <= t1) {
      const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
    }
  }
  return [255, 255, 255];
}

// ---- canvas sizing ----
function setupCanvasForMode() {
  if (!numBins) return; // nothing detected yet
  if (plotType === "waterfall") {
    const [bs, be] = effectiveBinRange();
    canvas.width = be - bs;
    canvas.height = historyRows;
    canvas.style.imageRendering = "pixelated";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    waterfallRow = 0;
    plotArea.classList.add("has-freq-axis");
    freqAxisEl.hidden = false;
    renderFreqAxisStrip();
  } else {
    canvas.style.imageRendering = "auto";
    plotArea.classList.remove("has-freq-axis");
    freqAxisEl.hidden = true;
    resizeMagnitudeCanvas();
  }
}

function resizeMagnitudeCanvas() {
  const rect = plotArea.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  drawMagnitude(lastMagnitude);
}

window.addEventListener("resize", () => {
  if (plotType === "magnitude") resizeMagnitudeCanvas();
});

// ---- rendering ----
function drawWaterfallRow(fullMag) {
  const [bs, be] = effectiveBinRange();
  const [minDb, maxDb] = effectiveDbRange();
  const w = be - bs;

  if (waterfallRow >= historyRows) {
    // shift everything up by one row, discarding the oldest (top) row
    ctx.drawImage(canvas, 0, 1, w, historyRows - 1, 0, 0, w, historyRows - 1);
  }
  const y = Math.min(waterfallRow, historyRows - 1);

  const imgData = ctx.createImageData(w, 1);
  const data = imgData.data;
  const range = maxDb - minDb || 1;
  for (let i = 0; i < w; i++) {
    const t = (fullMag[bs + i] - minDb) / range;
    const [r, g, b] = colormap(t);
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  }
  ctx.putImageData(imgData, 0, y);

  if (waterfallRow < historyRows) waterfallRow++;
}

// Draws text with a translucent background chip behind it so axis labels
// stay legible over a busy trace, regardless of what's underneath.
function fillTextWithBg(text, x, y) {
  const metrics = ctx.measureText(text);
  const ascent = metrics.actualBoundingBoxAscent ?? 8;
  const descent = metrics.actualBoundingBoxDescent ?? 3;
  let boxX = x;
  if (ctx.textAlign === "center") boxX = x - metrics.width / 2;
  else if (ctx.textAlign === "right") boxX = x - metrics.width;
  let boxY = y;
  if (ctx.textBaseline === "middle") boxY = y - ascent;
  else if (ctx.textBaseline === "bottom") boxY = y - ascent - descent;
  const pad = 2;
  const prevFill = ctx.fillStyle;
  ctx.fillStyle = "rgba(13,17,23,0.75)";
  ctx.fillRect(boxX - pad, boxY - pad, metrics.width + pad * 2, ascent + descent + pad * 2);
  ctx.fillStyle = prevFill;
  ctx.fillText(text, x, y);
}

function drawMagnitude(fullMag) {
  if (!fullMag) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  const [bs, be] = effectiveBinRange();
  const [minDb, maxDb] = effectiveDbRange();
  const range = maxDb - minDb || 1;
  const dpr = window.devicePixelRatio || 1;

  // horizontal gridlines
  const dbTicks = 5;
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let g = 0; g < dbTicks; g++) {
    const gy = h * (g / (dbTicks - 1));
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(w, gy);
    ctx.stroke();
  }

  // trace
  ctx.strokeStyle = "#58a6ff";
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  const n = be - bs;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const t = (fullMag[bs + i] - minDb) / range;
    const y = h - Math.min(1, Math.max(0, t)) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // dB axis labels, drawn on top of the trace with a background chip
  ctx.font = `${10 * dpr}px -apple-system, sans-serif`;
  ctx.fillStyle = "rgba(230,237,243,0.85)";
  ctx.textAlign = "left";
  for (let g = 0; g < dbTicks; g++) {
    const frac = g / (dbTicks - 1);
    const gy = h * frac;
    const dbVal = maxDb - frac * range;
    ctx.textBaseline = g === 0 ? "top" : g === dbTicks - 1 ? "bottom" : "middle";
    fillTextWithBg(`${dbVal.toFixed(0)} dB`, 4 * dpr, gy);
  }

  // frequency axis labels along the bottom
  if (centerFreqHz != null && sampleRateHz != null) {
    const ticks = pickBinTicks(bs, be, 6);
    ctx.textBaseline = "bottom";
    ticks.forEach(({ bin, frac }, idx) => {
      const x = frac * w;
      ctx.textAlign = idx === 0 ? "left" : idx === ticks.length - 1 ? "right" : "center";
      fillTextWithBg(formatFreq(binFreq(bin)), x, h - 4 * dpr);
    });
  }
}

function handleFrame(mag) {
  lastMagnitude = mag;
  frameCount++;
  fpsWindowCount++;

  const now = performance.now();
  if (now - fpsWindowStart >= 1000) {
    fpsInfo.textContent = `${fpsWindowCount} fps`;
    fpsWindowCount = 0;
    fpsWindowStart = now;
  }
  const chLabel = numRfChannels > 1 ? ` · ch${selectedChannel}/${numRfChannels}` : "";
  const [bs, be] = effectiveBinRange();
  const zoomLabel = bs !== 0 || be !== numBins ? ` · zoomed [${bs}:${be}]` : "";
  frameInfo.textContent = `frame ${frameCount} · ${dataType || "?"} · ${numBins} bins${chLabel}${zoomLabel}`;

  if (plotType === "waterfall") {
    drawWaterfallRow(mag);
  } else {
    drawMagnitude(mag);
  }
}

// ---- status / detected-format handling ----
function applyStatus(msg) {
  endpointInput.value = msg.endpoint;
  selectedChannel = msg.selected_channel ?? 0;

  const shapeChanged =
    msg.num_samples !== numBins || msg.num_channels !== numRfChannels || msg.data_type !== dataType;

  dataType = msg.data_type;
  numRfChannels = msg.num_channels;
  numBins = msg.num_samples;
  centerFreqHz = msg.center_freq_hz;
  sampleRateHz = msg.sample_rate_hz;

  if (!dataType || !numBins) {
    detectedInfo.textContent = "waiting for data…";
    channelField.hidden = true;
    return;
  }

  const freqInfo =
    centerFreqHz != null && sampleRateHz != null
      ? ` · fc=${formatFreq(centerFreqHz)} · fs=${formatFreq(sampleRateHz)}`
      : "";
  detectedInfo.textContent = `${dataType} · ${numRfChannels} channel${numRfChannels === 1 ? "" : "s"} · ${numBins} samples/ch${freqInfo}`;

  channelField.hidden = numRfChannels <= 1;
  if (
    channelSelect.dataset.populatedFor !== String(numRfChannels) ||
    channelSelect.options.length !== numRfChannels
  ) {
    channelSelect.innerHTML = "";
    for (let i = 0; i < numRfChannels; i++) {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = `Channel ${i}`;
      channelSelect.appendChild(opt);
    }
    channelSelect.dataset.populatedFor = String(numRfChannels);
  }
  channelSelect.value = String(selectedChannel);

  if (shapeChanged) {
    errorMsg.textContent = "";
    resetZoom();
    setupCanvasForMode();
  } else if (plotType === "waterfall") {
    // center_freq/sample_rate can change (retune) without the frame shape
    // changing — refresh the axis labels without resetting scroll history.
    renderFreqAxisStrip();
  }
}

// ---- websocket ----
function setStatus(state, text) {
  statusEl.className = state;
  statusText.textContent = text;
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => setStatus("connected", "connected");
  ws.onclose = () => {
    setStatus("", "disconnected — retrying…");
    setTimeout(connect, 1500);
  };
  ws.onerror = () => setStatus("error", "connection error");

  ws.onmessage = (evt) => {
    if (typeof evt.data === "string") {
      const msg = JSON.parse(evt.data);
      if (msg.type === "status") {
        applyStatus(msg);
      } else if (msg.type === "error") {
        errorMsg.textContent = msg.message;
      }
    } else {
      const mag = new Float32Array(evt.data);
      handleFrame(mag);
    }
  };
}

// ---- zoom tool ----
function resetZoom() {
  zoomBinStart = 0;
  zoomBinEnd = null;
  zoomMinDb = null;
  zoomMaxDb = null;
}

function setZoomMode(active) {
  zoomModeActive = active;
  zoomBtn.classList.toggle("active", active);
  plotArea.classList.toggle("zoom-active", active);
}

zoomBtn.addEventListener("click", () => setZoomMode(!zoomModeActive));

autoscaleBtn.addEventListener("click", () => {
  resetZoom();
  setupCanvasForMode();
});

function plotAreaFraction(clientX, clientY) {
  const rect = plotArea.getBoundingClientRect();
  return {
    fx: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
    fy: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    rect,
  };
}

plotArea.addEventListener("mousedown", (evt) => {
  if (!zoomModeActive || !numBins) return;
  dragState = { startX: evt.clientX, startY: evt.clientY };
  zoomRectOverlay.hidden = false;
  updateZoomRectOverlay(evt.clientX, evt.clientY, evt.clientX, evt.clientY);
  evt.preventDefault();
});

window.addEventListener("mousemove", (evt) => {
  if (!dragState) return;
  updateZoomRectOverlay(dragState.startX, dragState.startY, evt.clientX, evt.clientY);
});

window.addEventListener("mouseup", (evt) => {
  if (!dragState) return;
  const { startX, startY } = dragState;
  dragState = null;
  zoomRectOverlay.hidden = true;

  const rect = plotArea.getBoundingClientRect();
  const minPixels = 6;
  if (Math.abs(evt.clientX - startX) < minPixels && Math.abs(evt.clientY - startY) < minPixels) {
    return; // treat as a click, not a drag — ignore
  }

  const a = plotAreaFraction(startX, startY);
  const b = plotAreaFraction(evt.clientX, evt.clientY);
  const fx0 = Math.min(a.fx, b.fx);
  const fx1 = Math.max(a.fx, b.fx);
  const fy0 = Math.min(a.fy, b.fy);
  const fy1 = Math.max(a.fy, b.fy);

  // Horizontal drag extent -> bin (frequency) sub-range, for both plot types.
  const [curBs, curBe] = effectiveBinRange();
  const span = curBe - curBs;
  let newBs = curBs + Math.round(fx0 * span);
  let newBe = curBs + Math.round(fx1 * span);
  newBs = Math.max(0, Math.min(newBs, numBins - 4));
  newBe = Math.max(newBs + 4, Math.min(newBe, numBins));
  zoomBinStart = newBs;
  zoomBinEnd = newBe;

  // Vertical drag extent -> dB sub-range, only meaningful for the magnitude
  // plot (its y-axis is amplitude). On the waterfall, y is time, so vertical
  // drag is ignored there and only the frequency axis zooms.
  if (plotType === "magnitude") {
    const [curLo, curHi] = effectiveDbRange();
    const dbRange = curHi - curLo;
    const newHi = curHi - fy0 * dbRange;
    const newLo = curHi - fy1 * dbRange;
    if (newHi - newLo >= 1) {
      zoomMinDb = newLo;
      zoomMaxDb = newHi;
    }
  }

  setupCanvasForMode();
});

function updateZoomRectOverlay(x0, y0, x1, y1) {
  const rect = plotArea.getBoundingClientRect();
  const left = Math.min(x0, x1) - rect.left;
  const top = plotType === "magnitude" ? Math.min(y0, y1) - rect.top : 0;
  const width = Math.abs(x1 - x0);
  const height = plotType === "magnitude" ? Math.abs(y1 - y0) : rect.height;
  zoomRectOverlay.style.left = `${left}px`;
  zoomRectOverlay.style.top = `${top}px`;
  zoomRectOverlay.style.width = `${width}px`;
  zoomRectOverlay.style.height = `${height}px`;
}

// ---- controls ----
applyBtn.addEventListener("click", async () => {
  const cfg = {
    endpoint: endpointInput.value.trim(),
    selected_channel: selectedChannel,
  };
  try {
    const resp = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      errorMsg.textContent = "config rejected: " + JSON.stringify(body.detail || body);
      return;
    }
    errorMsg.textContent = "";
    frameCount = 0;
    numBins = null; // reconnecting: format will be re-detected from the next frame
    centerFreqHz = null;
    sampleRateHz = null;
    resetZoom();
    detectedInfo.textContent = "waiting for data…";
  } catch (e) {
    errorMsg.textContent = "failed to apply config: " + e;
  }
});

channelSelect.addEventListener("change", async () => {
  const channel = parseInt(channelSelect.value, 10);
  try {
    const resp = await fetch("/api/select_channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      errorMsg.textContent = "channel select rejected: " + JSON.stringify(body.detail || body);
      return;
    }
    errorMsg.textContent = "";
    selectedChannel = channel;
    setupCanvasForMode(); // fresh waterfall for the newly selected channel (zoom preserved)
  } catch (e) {
    errorMsg.textContent = "failed to select channel: " + e;
  }
});

plotTypeSelect.addEventListener("change", () => {
  plotType = plotTypeSelect.value;
  el("historyLabel").textContent =
    plotType === "waterfall" ? "History rows (waterfall)" : "History rows (unused)";
  setupCanvasForMode();
});

historyRowsInput.addEventListener("change", () => {
  historyRows = Math.max(16, Math.min(4096, parseInt(historyRowsInput.value, 10) || 600));
  if (plotType === "waterfall") setupCanvasForMode();
});

[minDbInput, maxDbInput].forEach((input) =>
  input.addEventListener("change", () => {
    if (plotType === "magnitude") drawMagnitude(lastMagnitude);
  })
);

// ---- init ----
connect();
