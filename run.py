"""Entrypoint that runs uvicorn with a SelectorEventLoop on Windows.

uvicorn's built-in "asyncio" loop factory always hardcodes
asyncio.ProactorEventLoop on win32 (see uvicorn/loops/asyncio.py), which does
not support the add_reader/add_writer calls zmq.asyncio needs. We supply our
own loop factory (below) via the `loop=` string so uvicorn's asyncio_run(...,
loop_factory=...) uses a SelectorEventLoop instead.
"""
import asyncio
import sys

import uvicorn


def selector_loop_factory() -> asyncio.AbstractEventLoop:
    if sys.platform == "win32":
        return asyncio.SelectorEventLoop()
    return asyncio.new_event_loop()


if __name__ == "__main__":
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False, loop="run:selector_loop_factory")
