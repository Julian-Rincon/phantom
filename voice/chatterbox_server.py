#!/usr/bin/env python3
"""phantom-voice Chatterbox TTS microservice: cloned-voice synthesis on
127.0.0.1:3092, fed the agent reference WAVs under
~/.local/share/phantom-voice/refs/. The heavy dependency stack (torch,
chatterbox) is imported lazily inside the real model factory only, so this
module stays importable (and testable) with the lightweight phantom-voice
venv.

Run via run-chatterbox.sh under the phantom-voice-chatterbox systemd unit.
"""
from __future__ import annotations

import asyncio
import contextlib
import gc
import io
import logging
import os
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

logger = logging.getLogger("phantom_chatterbox")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s phantom_chatterbox: %(message)s")

HOST = "127.0.0.1"
PORT = int(os.environ.get("PHANTOM_CHATTERBOX_PORT", "3092"))

SERVER_ENV_PATH = Path(
    os.environ.get(
        "PHANTOM_CHATTERBOX_SERVER_ENV",
        str(Path.home() / ".config/codeg/server.env"),
    )
)
REFS_DIR = Path(
    os.environ.get(
        "PHANTOM_CHATTERBOX_REFS_DIR",
        str(Path.home() / ".local/share/phantom-voice/refs"),
    )
)
MAX_CHARS = 600
IDLE_UNLOAD_S = float(os.environ.get("PHANTOM_CHATTERBOX_IDLE_UNLOAD_S", "600"))
IDLE_CHECK_INTERVAL_S = 30.0


def _load_codeg_token() -> str:
    """Read CODEG_TOKEN from server.env at startup. Never logged."""
    if not SERVER_ENV_PATH.exists():
        raise RuntimeError(f"cannot start phantom-chatterbox: missing {SERVER_ENV_PATH}")
    for line in SERVER_ENV_PATH.read_text().splitlines():
        line = line.strip()
        if line.startswith("CODEG_TOKEN="):
            value = line.split("=", 1)[1].strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            if not value:
                raise RuntimeError(f"CODEG_TOKEN is empty in {SERVER_ENV_PATH}")
            return value
    raise RuntimeError(f"CODEG_TOKEN not found in {SERVER_ENV_PATH}")


CODEG_TOKEN = _load_codeg_token()


def _real_model_factory():
    """Build the real Chatterbox model (requires the brag/chatterbox venv)."""
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    model = ChatterboxMultilingualTTS.from_pretrained(device="cuda")

    class _RealChatterboxModel:
        def generate(self, text, reference, exaggeration, cfg_weight, lang):
            wav = model.generate(
                text,
                language_id=lang,
                audio_prompt_path=reference,
                exaggeration=exaggeration,
                cfg_weight=cfg_weight,
            )
            return wav.squeeze().cpu().numpy(), int(model.sr)

    return _RealChatterboxModel()


class ModelHolder:
    """Owns the (at most one) loaded Chatterbox model.

    `get()` lazy-loads under a threading.Lock; `touch()` refreshes the idle
    clock; `unload_if_idle(now, idle_s)` is deterministic given its inputs so
    the idle-release logic is testable without real sleeps.
    """

    def __init__(self, model_factory):
        self._factory = model_factory
        self._model = None
        self._lock = threading.Lock()
        self._last_used = 0.0

    def get(self):
        with self._lock:
            if self._model is None:
                self._model = self._factory()
                logger.info("chatterbox model loaded")
            self._last_used = time.monotonic()
            return self._model

    def touch(self) -> None:
        with self._lock:
            self._last_used = time.monotonic()

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def unload_if_idle(self, now: float, idle_s: float) -> bool:
        with self._lock:
            if self._model is None or idle_s <= 0:
                return False
            if now - self._last_used < idle_s:
                return False
            del self._model
            self._model = None
        gc.collect()
        try:
            import torch

            torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001 - torch absent in the light venv
            pass
        logger.info("chatterbox model unloaded after %.0fs idle", now - self._last_used)
        return True


_holder: Optional[ModelHolder] = None


def get_holder() -> ModelHolder:
    global _holder
    if _holder is None:
        _holder = ModelHolder(_real_model_factory)
    return _holder


def _seed_for_repro() -> None:
    """Reproducible decoding; torch is only present in the real venv."""
    try:
        import torch

        torch.manual_seed(7)
    except Exception:  # noqa: BLE001
        pass


def _generate_sync(model, text: str, reference: Optional[str], exaggeration: float,
                   cfg_weight: float, lang: str):
    _seed_for_repro()
    return model.generate(
        text, reference=reference, exaggeration=exaggeration, cfg_weight=cfg_weight, lang=lang
    )


# One generation at a time on the GPU: voice mode prefetches the next sentence
# while the current one plays, and two concurrent decodes on one model collide.
_generate_lock: Optional[asyncio.Lock] = None


def _get_generate_lock() -> asyncio.Lock:
    global _generate_lock
    if _generate_lock is None:
        _generate_lock = asyncio.Lock()
    return _generate_lock


async def _idle_unload_loop() -> None:
    while True:
        await asyncio.sleep(IDLE_CHECK_INTERVAL_S)
        try:
            get_holder().unload_if_idle(time.monotonic(), IDLE_UNLOAD_S)
        except Exception:  # noqa: BLE001 - the watchdog must never die
            logger.exception("idle-unload check failed")


@contextlib.asynccontextmanager
async def _lifespan(app: FastAPI):
    task = asyncio.create_task(_idle_unload_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="phantom-chatterbox", lifespan=_lifespan)


async def require_auth(request: Request) -> None:
    if request.method == "OPTIONS":
        return
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer ") or auth_header[len("Bearer ") :] != CODEG_TOKEN:
        raise HTTPException(status_code=401, detail="unauthorized")


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"error": "invalid request", "detail": exc.errors()})


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "loaded": get_holder().loaded}


class TtsRequest(BaseModel):
    text: str
    lang: str
    reference: Optional[str] = None
    exaggeration: float = 0.5
    cfg_weight: float = 0.5


@app.post("/tts", dependencies=[Depends(require_auth)])
async def tts_endpoint(payload: TtsRequest) -> Response:
    if payload.lang not in ("es", "en"):
        raise HTTPException(status_code=400, detail="lang must be 'es' or 'en'")
    if len(payload.text) > MAX_CHARS:
        raise HTTPException(status_code=413, detail=f"text too long (max {MAX_CHARS} chars)")

    reference: Optional[str] = None
    if payload.reference:
        ref = Path(payload.reference)
        if not ref.is_absolute():
            ref = REFS_DIR / ref
        try:
            ref = ref.resolve()
            ref.relative_to(REFS_DIR.resolve())
        except (ValueError, OSError):
            raise HTTPException(status_code=400, detail="reference must live under the refs directory")
        if not ref.is_file():
            raise HTTPException(status_code=400, detail=f"reference not found: {payload.reference}")
        reference = str(ref)

    holder = get_holder()
    try:
        async with _get_generate_lock():
            # The first load takes ~16 s: keep it off the event loop so /health
            # and auth rejections stay responsive meanwhile.
            model = await asyncio.to_thread(holder.get)
            audio, sample_rate = await asyncio.to_thread(
                _generate_sync, model, payload.text, reference,
                payload.exaggeration, payload.cfg_weight, payload.lang,
            )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("TTS synthesis failed")
        raise HTTPException(status_code=500, detail=f"could not synthesize speech: {exc}") from exc
    holder.touch()

    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
    buf.seek(0)
    return Response(content=buf.read(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
