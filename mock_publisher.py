"""Publishes synthetic complex RF data over a ZeroMQ PUB socket for testing
the data-driven waterfall web service.

Each message starts with a 12-byte little-endian header:
    float32 center_freq_hz - tuner center frequency, in Hz
    float32 sample_rate_hz - sample rate, in Hz
    uint16  num_samples    - samples per RF channel
    uint8   num_channels   - number of RF channels
    uint8   data_type      - 0 = FFT (complex float32 spectrum bins)
                              1 = TIME_DOMAIN (complex int16 IQ)
followed by num_channels blocks of num_samples complex samples each,
channel 0 first (non-interleaved), all little-endian.

Each RF channel gets a distinct fixed tone plus a shared sweeping tone, so
channel selection in the UI is visibly meaningful.
"""
import argparse
import struct
import time

import numpy as np
import zmq

DATA_TYPE_FFT = 0
DATA_TYPE_TIME_DOMAIN = 1
HEADER = struct.Struct("<ffHBB")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--bind", default="tcp://*:5555")
    p.add_argument(
        "--type",
        choices=["fft", "time"],
        default="time",
        help="fft = pre-computed complex64 spectrum bins, time = raw complex int16 IQ",
    )
    p.add_argument("--channels", type=int, default=2, help="number of RF channels")
    p.add_argument("--samples", type=int, default=1024, help="samples per channel")
    p.add_argument("--rate", type=float, default=20.0, help="frames per second")
    p.add_argument("--sample-rate", type=float, default=48000.0, help="sample rate in Hz, sent in the header")
    p.add_argument("--center-freq", type=float, default=915e6, help="center frequency in Hz, sent in the header")
    args = p.parse_args()

    data_type = DATA_TYPE_FFT if args.type == "fft" else DATA_TYPE_TIME_DOMAIN

    ctx = zmq.Context()
    sock = ctx.socket(zmq.PUB)
    sock.bind(args.bind)
    print(
        f"Publishing {args.type} data: {args.channels} ch x {args.samples} samples/ch "
        f"@ {args.rate} fps, fc={args.center_freq/1e6:.3f} MHz, fs={args.sample_rate/1e3:.3f} kHz "
        f"on {args.bind}  (Ctrl+C to stop)"
    )
    time.sleep(0.5)  # slow-joiner: give subscribers time to connect

    dt = 1.0 / args.sample_rate
    period = 1.0 / args.rate
    t_total = 0.0
    n = args.samples
    window = np.hanning(n).astype(np.float32)

    try:
        while True:
            loop_start = time.time()
            header = HEADER.pack(args.center_freq, args.sample_rate, n, args.channels, data_type)
            blocks = []
            for ch in range(args.channels):
                ts = t_total + np.arange(n) * dt
                base_freq = 2000.0 + ch * 3000.0
                sweep_freq = -6000.0 + 3000.0 * np.sin(2 * np.pi * 0.05 * t_total + ch)
                sig = (
                    np.exp(2j * np.pi * base_freq * ts)
                    + 0.8 * np.exp(2j * np.pi * sweep_freq * ts)
                    + (np.random.randn(n) + 1j * np.random.randn(n)) * 0.25
                )
                if data_type == DATA_TYPE_FFT:
                    spectrum = np.fft.fftshift(np.fft.fft(sig * window))
                    blocks.append(spectrum.astype(np.complex64).tobytes())
                else:
                    scaled = np.clip(sig * 8000.0, -32767, 32767)
                    interleaved = np.empty(n * 2, dtype="<i2")
                    interleaved[0::2] = scaled.real.astype(np.int16)
                    interleaved[1::2] = scaled.imag.astype(np.int16)
                    blocks.append(interleaved.tobytes())
            t_total += n * dt

            sock.send(header + b"".join(blocks))

            elapsed = time.time() - loop_start
            time.sleep(max(0.0, period - elapsed))
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
