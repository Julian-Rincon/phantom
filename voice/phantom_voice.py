#!/usr/bin/env python3
"""phantom-voice: local, loopback-only STT/TTS service for Phantom.

Speech-to-text via faster-whisper (CUDA float16, CPU int8 fallback) and
text-to-speech via kokoro-onnx. No audio ever leaves this machine: the
process binds to 127.0.0.1 only and every model runs locally.

Run directly for development:
    uvicorn phantom_voice:app --host 127.0.0.1 --port 3091

In production this is started by the phantom-voice systemd user unit via
run-phantom-voice.sh, which sets LD_LIBRARY_PATH for the CUDA wheels.
"""
from __future__ import annotations

import asyncio
import contextlib
import gc
import io
import logging
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

logger = logging.getLogger("phantom_voice")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s phantom_voice: %(message)s")

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

HOST = "127.0.0.1"
PORT = int(os.environ.get("PHANTOM_VOICE_PORT", "3091"))

ALLOWED_ORIGINS = ["http://127.0.0.1:3080", "http://localhost:3080"]

# Overridable for tests / alternate installs; defaults match the service contract.
SERVER_ENV_PATH = Path(os.environ.get("PHANTOM_VOICE_SERVER_ENV", str(Path.home() / ".config/codeg/server.env")))
MODELS_DIR = Path(os.environ.get("PHANTOM_VOICE_MODELS_DIR", str(Path.home() / ".local/share/brag/models")))
KOKORO_ONNX_PATH = MODELS_DIR / "kokoro-v1.0.onnx"
KOKORO_VOICES_PATH = MODELS_DIR / "voices-v1.0.bin"

STT_MODEL_NAME = os.environ.get("PHANTOM_VOICE_STT_MODEL", "large-v3-turbo")
STT_MAX_BYTES = 20 * 1024 * 1024  # 20 MB
TTS_MAX_CHARS = 4000

# Idle VRAM release: this machine's 8 GB GPU is shared with gaming, so the
# ~2.2 GB float16 STT model must not sit pinned in VRAM indefinitely. After
# this many seconds without an /stt request, the model is dropped and
# lazy-reloaded on the next one. <= 0 disables idle unloading.
STT_IDLE_UNLOAD_S = float(os.environ.get("PHANTOM_VOICE_IDLE_UNLOAD_S", "600"))
# How often the background loop checks for idleness. Kept small relative to
# the unload threshold so a short test override (e.g. 20s) is still honored
# promptly, but never more often than once a second.
STT_IDLE_CHECK_INTERVAL_S = max(1.0, min(5.0, STT_IDLE_UNLOAD_S / 4)) if STT_IDLE_UNLOAD_S > 0 else 5.0

DEFAULT_VOICES = {"es": "ef_dora", "en": "af_heart"}
KOKORO_LANG = {"es": "es", "en": "en-us"}


def _load_codeg_token() -> str:
    """Read CODEG_TOKEN from server.env at startup. Never logged."""
    if not SERVER_ENV_PATH.exists():
        raise RuntimeError(f"cannot start phantom-voice: missing {SERVER_ENV_PATH}")
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


def _gpu_present() -> bool:
    """Best-effort guess for the /health hint shown before the STT model is lazy-loaded."""
    if not shutil.which("nvidia-smi"):
        return False
    try:
        result = subprocess.run(["nvidia-smi", "-L"], capture_output=True, timeout=5, text=True)
        return result.returncode == 0 and "GPU" in result.stdout
    except Exception:
        return False


STT_STATE = {"model": STT_MODEL_NAME, "device": "cuda" if _gpu_present() else "cpu", "loaded": False}


def _now() -> float:
    """Indirection point so tests can fake the clock without real sleeps."""
    return time.monotonic()

# --------------------------------------------------------------------------
# Markdown / text cleanup for TTS
# --------------------------------------------------------------------------

_CODE_BLOCK_RE = re.compile(r"```.*?```", re.DOTALL)
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_INLINE_CODE_RE = re.compile(r"`([^`]+)`")
_BARE_URL_RE = re.compile(r"https?://\S+")
_HEADER_RE = re.compile(r"^\s{0,3}#{1,6}\s*", re.MULTILINE)
_EMPHASIS_RE = re.compile(r"(\*\*\*|\*\*|\*|___|__|_)(.+?)\1")
_BULLET_RE = re.compile(r"^\s*[-*+]\s+", re.MULTILINE)
_NUMBERED_RE = re.compile(r"^\s*\d+[.)]\s+", re.MULTILINE)
_BLOCKQUOTE_RE = re.compile(r"^\s*>\s?", re.MULTILINE)
_WHITESPACE_RE = re.compile(r"[ \t]+")
_BLANKLINES_RE = re.compile(r"\n{3,}")


def strip_markdown_for_tts(text: str, lang: str) -> str:
    """Strip markdown/code fences/URLs so kokoro doesn't try to read them aloud.

    - fenced code blocks -> "(bloque de código)" / "(code block)"
    - inline code keeps its text (backticks removed)
    - markdown/image links keep their label, URL dropped
    - bare URLs are dropped entirely (no readable label)
    """
    code_block_phrase = "(bloque de código)" if lang == "es" else "(code block)"

    out = _CODE_BLOCK_RE.sub(f" {code_block_phrase} ", text)
    out = _IMAGE_RE.sub(lambda m: m.group(1) if m.group(1) else code_block_phrase, out)
    out = _LINK_RE.sub(lambda m: m.group(1), out)
    out = _INLINE_CODE_RE.sub(lambda m: m.group(1), out)
    out = _BARE_URL_RE.sub("", out)
    out = _HEADER_RE.sub("", out)
    out = _BLOCKQUOTE_RE.sub("", out)
    out = _EMPHASIS_RE.sub(lambda m: m.group(2), out)
    out = _BULLET_RE.sub("", out)
    out = _NUMBERED_RE.sub("", out)
    out = _WHITESPACE_RE.sub(" ", out)
    out = _BLANKLINES_RE.sub("\n\n", out)
    return out.strip()


# --------------------------------------------------------------------------
# STT engine (faster-whisper, lazy-loaded, CUDA with CPU int8 fallback,
# idle-unloaded to free VRAM for other GPU use e.g. gaming)
# --------------------------------------------------------------------------

_stt_model = None
_stt_lock = asyncio.Lock()
_stt_last_used: float = 0.0


def _import_whisper_model():
    """Indirection point so tests can substitute a fake model class."""
    from faster_whisper import WhisperModel

    return WhisperModel


def _load_stt_model_sync():
    """Blocking model construction, run while holding _stt_lock."""
    WhisperModel = _import_whisper_model()
    try:
        model = WhisperModel(STT_MODEL_NAME, device="cuda", compute_type="float16")
        STT_STATE.update(model=STT_MODEL_NAME, device="cuda", loaded=True)
        logger.info("STT model '%s' loaded on cuda (float16)", STT_MODEL_NAME)
    except Exception as exc:  # noqa: BLE001 - any CUDA/driver/lib failure should fall back
        logger.warning("CUDA STT init failed (%s); falling back to CPU int8", exc)
        model = WhisperModel(STT_MODEL_NAME, device="cpu", compute_type="int8")
        STT_STATE.update(model=STT_MODEL_NAME, device="cpu", loaded=True)
        logger.info("STT model '%s' loaded on cpu (int8)", STT_MODEL_NAME)
    return model


async def get_stt_model():
    """Lazy-load (and touch the idle clock for) the STT model, guarded by a lock
    so a concurrent idle-unload can never hand back a half-torn-down model."""
    global _stt_model, _stt_last_used
    async with _stt_lock:
        if _stt_model is None:
            _stt_model = _load_stt_model_sync()
        _stt_last_used = _now()
        return _stt_model


async def unload_stt_model(reason: str = "idle") -> bool:
    """Drop the loaded STT model to free VRAM. Returns True if it actually unloaded one.

    ctranslate2 (faster-whisper's backend) frees its CUDA allocations from its
    own destructor, not via torch's caching allocator, so dropping the last
    Python reference + gc.collect() is enough - verified live with nvidia-smi
    (see VOICE.md).
    """
    global _stt_model
    async with _stt_lock:
        if _stt_model is None:
            return False
        del _stt_model
        _stt_model = None
        gc.collect()
        STT_STATE["loaded"] = False
        logger.info("STT model unloaded (%s)", reason)
        return True


async def _maybe_unload_idle_stt() -> bool:
    """Idle check, split out from the polling loop so tests can call it directly
    with a faked clock instead of waiting on a real background task."""
    if STT_IDLE_UNLOAD_S <= 0 or _stt_model is None:
        return False
    idle_for = _now() - _stt_last_used
    if idle_for < STT_IDLE_UNLOAD_S:
        return False
    return await unload_stt_model(reason=f"idle {idle_for:.0f}s >= {STT_IDLE_UNLOAD_S:.0f}s")


async def _idle_unload_loop() -> None:
    while True:
        await asyncio.sleep(STT_IDLE_CHECK_INTERVAL_S)
        try:
            await _maybe_unload_idle_stt()
        except Exception:  # noqa: BLE001 - never let the watchdog die
            logger.exception("idle-unload check failed")


async def transcribe(audio_bytes: bytes, lang: str) -> tuple[str, str, int]:
    """Decode+transcribe raw audio bytes (webm/ogg/wav) via faster-whisper (PyAV under the hood).

    Returns (text, detected_language, audio_duration_ms).
    """
    model = await get_stt_model()
    language = None if lang == "auto" else lang
    segments, info = model.transcribe(
        io.BytesIO(audio_bytes),
        language=language,
        vad_filter=True,
        beam_size=2,
        condition_on_previous_text=False,
    )
    text = "".join(segment.text for segment in segments).strip()
    duration_ms = int(round(info.duration * 1000))
    # Touch the idle clock again after the (possibly slow) transcribe call so
    # idleness is measured from the end of the last request, not its start.
    global _stt_last_used
    _stt_last_used = _now()
    return text, info.language, duration_ms


# --------------------------------------------------------------------------
# TTS engine (kokoro-onnx, lazy-loaded)
# --------------------------------------------------------------------------

_tts_engine = None


def get_tts_engine():
    global _tts_engine
    if _tts_engine is None:
        if not KOKORO_ONNX_PATH.exists() or not KOKORO_VOICES_PATH.exists():
            raise RuntimeError(
                f"kokoro model files missing ({KOKORO_ONNX_PATH}, {KOKORO_VOICES_PATH}); "
                "run scripts/install-voice.sh for instructions"
            )
        from kokoro_onnx import Kokoro

        _tts_engine = Kokoro(str(KOKORO_ONNX_PATH), str(KOKORO_VOICES_PATH))
        logger.info("kokoro TTS engine loaded")
    return _tts_engine


def synthesize(text: str, voice: str, speed: float, lang: str):
    engine = get_tts_engine()
    return engine.create(text, voice=voice, speed=speed, lang=KOKORO_LANG.get(lang, "en-us"))


# --------------------------------------------------------------------------
# FastAPI app
# --------------------------------------------------------------------------

@contextlib.asynccontextmanager
async def _lifespan(app: FastAPI):
    task = asyncio.create_task(_idle_unload_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="phantom-voice", lifespan=_lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


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


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"error": "internal error"})


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "stt": {"model": STT_STATE["model"], "device": STT_STATE["device"], "loaded": STT_STATE["loaded"]},
        "tts": {"engine": "kokoro", "voices": DEFAULT_VOICES},
    }


@app.post("/stt", dependencies=[Depends(require_auth)])
async def stt_endpoint(request: Request, lang: str = Query("auto")) -> dict:
    if lang not in ("es", "en", "auto"):
        raise HTTPException(status_code=400, detail="lang must be 'es', 'en' or 'auto'")

    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > STT_MAX_BYTES:
                raise HTTPException(status_code=413, detail="audio too large (max 20 MB)")
        except ValueError:
            pass

    body = await request.body()
    if len(body) > STT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="audio too large (max 20 MB)")
    if not body:
        raise HTTPException(status_code=400, detail="empty audio body")

    t0 = time.perf_counter()
    try:
        text, detected_lang, duration_ms = await transcribe(body, lang)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("STT decode/transcribe failed")
        raise HTTPException(status_code=422, detail=f"could not decode/transcribe audio: {exc}") from exc
    elapsed_ms = int((time.perf_counter() - t0) * 1000)

    logger.info("stt lang=%s bytes=%d duration_ms=%d elapsed_ms=%d", detected_lang, len(body), duration_ms, elapsed_ms)
    return {
        "text": text,
        "language": detected_lang,
        "duration_ms": duration_ms,
        "elapsed_ms": elapsed_ms,
    }


class TTSRequest(BaseModel):
    text: str
    lang: str
    voice: Optional[str] = None
    speed: Optional[float] = None


@app.post("/tts", dependencies=[Depends(require_auth)])
async def tts_endpoint(payload: TTSRequest) -> Response:
    if payload.lang not in ("es", "en"):
        raise HTTPException(status_code=400, detail="lang must be 'es' or 'en'")
    if len(payload.text) > TTS_MAX_CHARS:
        raise HTTPException(status_code=413, detail=f"text too long (max {TTS_MAX_CHARS} chars)")

    cleaned = strip_markdown_for_tts(payload.text, payload.lang)
    if not cleaned.strip():
        raise HTTPException(status_code=400, detail="text is empty after stripping markdown")

    voice = payload.voice or DEFAULT_VOICES[payload.lang]
    speed = payload.speed if payload.speed else 1.0

    t0 = time.perf_counter()
    try:
        audio, sample_rate = synthesize(cleaned, voice=voice, speed=speed, lang=payload.lang)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("TTS synthesis failed")
        raise HTTPException(status_code=422, detail=f"could not synthesize speech: {exc}") from exc
    elapsed_ms = int((time.perf_counter() - t0) * 1000)

    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV", subtype="PCM_16")
    buf.seek(0)

    logger.info("tts lang=%s voice=%s chars=%d elapsed_ms=%d", payload.lang, voice, len(cleaned), elapsed_ms)
    return Response(content=buf.read(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
