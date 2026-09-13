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
let numBins = null; // spectrum bins per frame == canvas width for the waterfall
let numRfChannels = null;
let dataType = null;
let selectedChannel = 0;
let historyRows = parseInt(historyRowsInput.value, 10);
let plotType = plotTypeSelect.value;
let lastMagnitude = null;
let waterfallRow = 0; // number of rows written so far (caps at historyRows)
let frameCount = 0;
let fpsWindowStart = performance.now();
let fpsWindowCount = 0;

canvas.style.imageRendering = "pixelated";

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
    canvas.width = numBins;
    canvas.height = historyRows;
    canvas.style.imageRendering = "pixelated";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    waterfallRow = 0;
  } else {
    canvas.style.imageRendering = "auto";
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
function drawWaterfallRow(mag, minDb, maxDb) {
  const w = numBins;

  if (waterfallRow >= historyRows) {
    // shift everything up by one row, discarding the oldest (top) row
    ctx.drawImage(canvas, 0, 1, w, historyRows - 1, 0, 0, w, historyRows - 1);
  }
  const y = Math.min(waterfallRow, historyRows - 1);

  const imgData = ctx.createImageData(w, 1);
  const data = imgData.data;
  const range = maxDb - minDb || 1;
  for (let i = 0; i < w; i++) {
    const t = (mag[i] - minDb) / range;
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

function drawMagnitude(mag) {
  if (!mag) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  const minDb = parseFloat(minDbInput.value);
  const maxDb = parseFloat(maxDbInput.value);
  const range = maxDb - minDb || 1;

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const gy = (h * g) / 4;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(w, gy);
    ctx.stroke();
  }

  ctx.strokeStyle = "#58a6ff";
  ctx.lineWidth = Math.max(1, window.devicePixelRatio || 1);
  ctx.beginPath();
  const n = mag.length;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const t = (mag[i] - minDb) / range;
    const y = h - Math.min(1, Math.max(0, t)) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
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
  frameInfo.textContent = `frame ${frameCount} · ${dataType || "?"} · ${numBins} bins${chLabel}`;

  if (plotType === "waterfall") {
    drawWaterfallRow(mag, parseFloat(minDbInput.value), parseFloat(maxDbInput.value));
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

  if (!dataType || !numBins) {
    detectedInfo.textContent = "waiting for data…";
    channelField.hidden = true;
    return;
  }

  detectedInfo.textContent = `${dataType} · ${numRfChannels} channel${numRfChannels === 1 ? "" : "s"} · ${numBins} samples/ch`;

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
    setupCanvasForMode();
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
    setupCanvasForMode(); // fresh waterfall for the newly selected channel
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
