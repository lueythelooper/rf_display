import asyncio
import json
import math
import struct
import sys
from typing import Optional, Set

import numpy as np
import zmq
import zmq.asyncio

if sys.platform == "win32":
    # zmq.asyncio needs selector-based add_reader/add_writer support, which
    # the default ProactorEventLoop on Windows does not provide.
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

app = FastAPI()

# ---- wire protocol -------------------------------------------------------
# Every ZMQ message starts with a 12-byte little-endian header:
#   float32 center_freq_hz - tuner center frequency, in Hz
#   float32 sample_rate_hz - sample rate the data was captured/produced at, in Hz
#   uint16  num_samples    - samples per RF channel
#   uint8   num_channels   - number of RF channels
#   uint8   data_type      - 0 = FFT (complex float32 spectrum bins),
#                             1 = TIME_DOMAIN (complex int16 IQ)
# followed by num_channels blocks of num_samples complex samples each,
# channel 0 first (non-interleaved), all little-endian.
#
# The frequency axis is derived from center_freq_hz/sample_rate_hz: the
# center bin (num_samples // 2, matching np.fft.fftshift's convention)
# corresponds to center_freq_hz, and each bin steps by sample_rate_hz /
# num_samples.
DATA_TYPE_FFT = 0
DATA_TYPE_TIME_DOMAIN = 1
DATA_TYPE_NAMES = {DATA_TYPE_FFT: "FFT", DATA_TYPE_TIME_DOMAIN: "TIME_DOMAIN"}
DATA_TYPE_ITEMSIZE = {DATA_TYPE_FFT: 8, DATA_TYPE_TIME_DOMAIN: 4}  # bytes/complex sample
HEADER = struct.Struct("<ffHBB")


class Config(BaseModel):
    endpoint: str = "tcp://localhost:5555"
    selected_channel: int = 0

    @field_validator("selected_channel")
    @classmethod
    def check_channel(cls, v):
        if v < 0:
            raise ValueError("selected_channel must be >= 0")
        return v


class ChannelSelection(BaseModel):
    channel: int

    @field_validator("channel")
    @classmethod
    def check_channel(cls, v):
        if v < 0:
            raise ValueError("channel must be >= 0")
        return v


class Detected(BaseModel):
    data_type: Optional[str] = None
    num_channels: Optional[int] = None
    num_samples: Optional[int] = None
    center_freq_hz: Optional[float] = None
    sample_rate_hz: Optional[float] = None


class State:
    def __init__(self):
        self.config = Config()
        self.detected = Detected()
        self.clients: Set[WebSocket] = set()
        self.task: Optional[asyncio.Task] = None
        self.zctx = zmq.asyncio.Context.instance()
        self.lock = asyncio.Lock()
        self.last_error: Optional[str] = None


state = State()


def status_payload() -> dict:
    return {
        "type": "status",
        "endpoint": state.config.endpoint,
        "selected_channel": state.config.selected_channel,
        "data_type": state.detected.data_type,
        "num_channels": state.detected.num_channels,
        "num_samples": state.detected.num_samples,
        "center_freq_hz": state.detected.center_freq_hz,
        "sample_rate_hz": state.detected.sample_rate_hz,
    }


async def broadcast_status():
    msg = json.dumps(status_payload())
    dead = []
    for ws in state.clients:
        try:
            await ws.send_text(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        state.clients.discard(ws)


async def broadcast_error(message: str):
    state.last_error = message
    msg = json.dumps({"type": "error", "message": message})
    dead = []
    for ws in state.clients:
        try:
            await ws.send_text(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        state.clients.discard(ws)


async def broadcast_frame(mag: np.ndarray):
    data = mag.astype("<f4").tobytes()
    dead = []
    for ws in state.clients:
        try:
            await ws.send_bytes(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        state.clients.discard(ws)


async def subscriber_loop(cfg: Config):
    sock = state.zctx.socket(zmq.SUB)
    sock.setsockopt(zmq.SUBSCRIBE, b"")
    sock.setsockopt(zmq.RCVTIMEO, 500)
    sock.setsockopt(zmq.LINGER, 0)
    try:
        sock.connect(cfg.endpoint)
    except Exception as exc:
        await broadcast_error(f"failed to connect to {cfg.endpoint}: {exc}")
        sock.close(0)
        return

    locked: Optional[tuple] = None  # (num_channels, num_samples, data_type)
    window_cache: dict = {}

    try:
        while True:
            try:
                raw = await sock.recv()
            except zmq.Again:
                continue
            except Exception as exc:
                await broadcast_error(f"recv error: {exc}")
                await asyncio.sleep(0.5)
                continue

            if len(raw) < HEADER.size:
                await broadcast_error(f"frame too short for header: {len(raw)} bytes")
                continue

            center_freq, sample_rate, num_samples, num_channels, data_type = HEADER.unpack_from(raw, 0)

            if data_type not in DATA_TYPE_NAMES:
                await broadcast_error(f"unknown data type in header: {data_type}")
                continue
            if num_samples <= 0 or num_channels <= 0:
                await broadcast_error(
                    f"invalid header: {num_samples} samples x {num_channels} channels"
                )
                continue
            if not math.isfinite(center_freq) or not math.isfinite(sample_rate) or sample_rate <= 0:
                await broadcast_error(
                    f"invalid header: center_freq={center_freq} sample_rate={sample_rate}"
                )
                continue

            shape = (num_channels, num_samples, data_type)
            status_changed = False
            if locked is None:
                locked = shape
                state.detected.data_type = DATA_TYPE_NAMES[data_type]
                state.detected.num_channels = num_channels
                state.detected.num_samples = num_samples
                status_changed = True
            elif shape != locked:
                exp_ch, exp_sm, exp_ty = locked
                await broadcast_error(
                    "Input data is of inconsistent size: expected "
                    f"{exp_sm} samples x {exp_ch} channels ({DATA_TYPE_NAMES[exp_ty]}), got "
                    f"{num_samples} samples x {num_channels} channels ({DATA_TYPE_NAMES[data_type]})"
                )
                continue

            # center_freq/sample_rate may legitimately change frame-to-frame
            # (e.g. the SDR was retuned) without that being a framing error.
            if state.detected.center_freq_hz != center_freq or state.detected.sample_rate_hz != sample_rate:
                state.detected.center_freq_hz = center_freq
                state.detected.sample_rate_hz = sample_rate
                status_changed = True

            if status_changed:
                await broadcast_status()

            itemsize = DATA_TYPE_ITEMSIZE[data_type]
            expected_bytes = num_samples * num_channels * itemsize
            payload = raw[HEADER.size:]
            if len(payload) < expected_bytes:
                await broadcast_error(
                    f"payload too short: expected {expected_bytes} bytes, got {len(payload)}"
                )
                continue

            if data_type == DATA_TYPE_FFT:
                samples = np.frombuffer(payload[:expected_bytes], dtype="<c8")
            else:
                ints = np.frombuffer(payload[:expected_bytes], dtype="<i2").astype(np.float32)
                samples = (ints[0::2] + 1j * ints[1::2]) / 32768.0

            channels = samples.reshape(num_channels, num_samples)

            if data_type == DATA_TYPE_TIME_DOMAIN:
                window = window_cache.get(num_samples)
                if window is None:
                    window = np.hanning(num_samples).astype(np.float32)
                    window_cache[num_samples] = window
                spectrum = np.fft.fftshift(np.fft.fft(channels * window, axis=1), axes=1)
                mag = 20 * np.log10(np.abs(spectrum) + 1e-12).astype(np.float32)
            else:
                # FFT-type input is already frequency-domain: just take magnitude.
                mag = 20 * np.log10(np.abs(channels) + 1e-12).astype(np.float32)

            sel = min(max(state.config.selected_channel, 0), num_channels - 1)
            await broadcast_frame(mag[sel])
    except asyncio.CancelledError:
        pass
    finally:
        sock.close(0)


async def restart_subscriber():
    if state.task and not state.task.done():
        state.task.cancel()
        try:
            await state.task
        except asyncio.CancelledError:
            pass
    state.detected = Detected()
    state.last_error = None
    state.task = asyncio.create_task(subscriber_loop(state.config))


@app.on_event("startup")
async def startup():
    await restart_subscriber()


@app.get("/api/config")
async def get_config():
    return status_payload()


@app.post("/api/config")
async def set_config(cfg: Config):
    async with state.lock:
        state.config = cfg
        await restart_subscriber()
        await broadcast_status()
    return status_payload()


@app.post("/api/select_channel")
async def select_channel(sel: ChannelSelection):
    async with state.lock:
        state.config.selected_channel = sel.channel
        await broadcast_status()
    return status_payload()


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    state.clients.add(websocket)
    await websocket.send_text(json.dumps(status_payload()))
    if state.last_error:
        await websocket.send_text(json.dumps({"type": "error", "message": state.last_error}))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        state.clients.discard(websocket)


app.mount("/", StaticFiles(directory="static", html=True), name="static")
