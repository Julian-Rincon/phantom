"""Tests for phantom_voice: markdown stripping, auth/CORS, request limits,
and STT idle-unload (VRAM release).

STT/TTS engines are mocked (no GPU, no model files needed to run these).
Run with the phantom-voice venv:
    ~/.local/share/phantom/voice-venv/bin/python -m pytest voice/test_phantom_voice.py -v
"""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import pytest

# --- point the module at an isolated fake server.env, BEFORE import --------
# phantom_voice reads CODEG_TOKEN at module import time, so the env var must
# be set here at module scope, not inside a fixture (fixtures run too late).
FAKE_TOKEN = "test-token-abc123"
_envdir = tempfile.mkdtemp(prefix="phantom-voice-test-")
_envfile = Path(_envdir) / "server.env"
_envfile.write_text(f"CODEG_TOKEN={FAKE_TOKEN}\nCODEG_PORT=3080\n")
os.environ["PHANTOM_VOICE_SERVER_ENV"] = str(_envfile)

sys.path.insert(0, str(Path(__file__).parent))
import phantom_voice  # noqa: E402  (import after env var is set)

from fastapi.testclient import TestClient  # noqa: E402

AUTH = {"Authorization": f"Bearer {FAKE_TOKEN}"}


def run(coro):
    """Run an async phantom_voice function from a plain (non-async) test."""
    return asyncio.run(coro)


@pytest.fixture()
def client():
    return TestClient(phantom_voice.app)


@pytest.fixture(autouse=True)
def _reset_stt_globals():
    """STT load state is module-global; keep tests from leaking into each other."""
    phantom_voice._stt_model = None
    phantom_voice._stt_last_used = 0.0
    phantom_voice.STT_STATE.update(model=phantom_voice.STT_MODEL_NAME, device="cpu", loaded=False)
    yield
    phantom_voice._stt_model = None
    phantom_voice._stt_last_used = 0.0
    phantom_voice.STT_STATE.update(model=phantom_voice.STT_MODEL_NAME, device="cpu", loaded=False)


class FakeSegment:
    def __init__(self, text):
        self.text = text


class FakeInfo:
    def __init__(self, language="es", duration=1.5):
        self.language = language
        self.duration = duration


class FakeWhisperModel:
    """Stand-in for faster_whisper.WhisperModel: no GPU, no download, no real audio decode."""

    instances = []
    fail_on_cuda = False

    def __init__(self, model_name, device, compute_type):
        if device == "cuda" and FakeWhisperModel.fail_on_cuda:
            raise RuntimeError("fake CUDA init failure")
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.deleted = False
        FakeWhisperModel.instances.append(self)

    def transcribe(self, audio, language=None, vad_filter=True, beam_size=2, condition_on_previous_text=False):
        return [FakeSegment("hola mundo")], FakeInfo(language=language or "es", duration=1.23)

    def __del__(self):
        self.deleted = True


@pytest.fixture(autouse=True)
def _reset_fake_whisper():
    FakeWhisperModel.instances = []
    FakeWhisperModel.fail_on_cuda = False
    yield


# ---------------------------------------------------------------------------
# Markdown / text stripping for TTS
# ---------------------------------------------------------------------------

class TestStripMarkdown:
    def test_fenced_code_block_es(self):
        out = phantom_voice.strip_markdown_for_tts("mira esto:\n```py\nprint(1)\n```\nok", "es")
        assert "(bloque de código)" in out
        assert "print(1)" not in out

    def test_fenced_code_block_en(self):
        out = phantom_voice.strip_markdown_for_tts("look:\n```py\nprint(1)\n```\nok", "en")
        assert "(code block)" in out
        assert "print(1)" not in out

    def test_inline_code_keeps_text(self):
        out = phantom_voice.strip_markdown_for_tts("run `npm install` first", "en")
        assert "npm install" in out
        assert "`" not in out

    def test_markdown_link_keeps_label_drops_url(self):
        out = phantom_voice.strip_markdown_for_tts("see [the docs](https://example.com/x)", "en")
        assert "the docs" in out
        assert "example.com" not in out
        assert "http" not in out

    def test_image_keeps_alt_text(self):
        out = phantom_voice.strip_markdown_for_tts("![a diagram](https://example.com/x.png)", "en")
        assert "a diagram" in out
        assert "example.com" not in out

    def test_bare_url_is_dropped(self):
        out = phantom_voice.strip_markdown_for_tts("check https://example.com/path?q=1 now", "en")
        assert "example.com" not in out
        assert "http" not in out
        assert "check" in out and "now" in out

    def test_headers_stripped(self):
        out = phantom_voice.strip_markdown_for_tts("# Title\nbody text", "en")
        assert "#" not in out
        assert "Title" in out

    def test_bold_italic_stripped(self):
        out = phantom_voice.strip_markdown_for_tts("this is **very** important and *urgent*", "en")
        assert "*" not in out
        assert "very" in out and "urgent" in out

    def test_bullets_stripped(self):
        out = phantom_voice.strip_markdown_for_tts("- first\n- second", "en")
        assert "first" in out and "second" in out
        assert not out.strip().startswith("-")

    def test_plain_text_unchanged_content(self):
        out = phantom_voice.strip_markdown_for_tts("Hola, todo bien por aquí.", "es")
        assert "Hola" in out and "todo bien" in out

    def test_empty_string(self):
        assert phantom_voice.strip_markdown_for_tts("", "en") == ""


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

class TestAuth:
    def test_health_requires_no_auth(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert "stt" in body and "tts" in body

    def test_stt_requires_auth(self, client):
        resp = client.post("/stt", content=b"fake-audio-bytes")
        assert resp.status_code == 401
        assert resp.json() == {"error": "unauthorized"}

    def test_tts_requires_auth(self, client):
        resp = client.post("/tts", json={"text": "hola", "lang": "es"})
        assert resp.status_code == 401
        assert resp.json() == {"error": "unauthorized"}

    def test_wrong_token_rejected(self, client):
        resp = client.post("/tts", json={"text": "hola", "lang": "es"}, headers={"Authorization": "Bearer nope"})
        assert resp.status_code == 401

    def test_malformed_auth_header_rejected(self, client):
        resp = client.post("/tts", json={"text": "hola", "lang": "es"}, headers={"Authorization": FAKE_TOKEN})
        assert resp.status_code == 401

    def test_correct_token_accepted(self, client, monkeypatch):
        monkeypatch.setattr(phantom_voice, "synthesize", lambda *a, **k: (np.zeros(2400, dtype=np.float32), 24000))
        resp = client.post("/tts", json={"text": "hola", "lang": "es"}, headers=AUTH)
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------

class TestCORS:
    def test_preflight_allowed_origin(self, client):
        resp = client.options(
            "/tts",
            headers={
                "Origin": "http://127.0.0.1:3080",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Authorization,Content-Type",
            },
        )
        assert resp.status_code in (200, 204)
        assert resp.headers.get("access-control-allow-origin") == "http://127.0.0.1:3080"

    def test_preflight_localhost_origin_allowed(self, client):
        resp = client.options(
            "/tts",
            headers={
                "Origin": "http://localhost:3080",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert resp.status_code in (200, 204)
        assert resp.headers.get("access-control-allow-origin") == "http://localhost:3080"

    def test_disallowed_origin_not_echoed(self, client):
        resp = client.options(
            "/tts",
            headers={
                "Origin": "http://evil.example.com",
                "Access-Control-Request-Method": "POST",
            },
        )
        assert resp.headers.get("access-control-allow-origin") != "http://evil.example.com"

    def test_actual_request_from_allowed_origin_has_cors_header(self, client, monkeypatch):
        monkeypatch.setattr(phantom_voice, "synthesize", lambda *a, **k: (np.zeros(100, dtype=np.float32), 24000))
        resp = client.post(
            "/tts",
            json={"text": "hola", "lang": "es"},
            headers={**AUTH, "Origin": "http://127.0.0.1:3080"},
        )
        assert resp.headers.get("access-control-allow-origin") == "http://127.0.0.1:3080"


# ---------------------------------------------------------------------------
# Request limits
# ---------------------------------------------------------------------------

class TestLimits:
    def test_stt_over_20mb_rejected(self, client):
        big = b"x" * (20 * 1024 * 1024 + 1)
        resp = client.post(
            "/stt",
            content=big,
            headers={**AUTH, "Content-Type": "audio/wav", "Content-Length": str(len(big))},
        )
        assert resp.status_code == 413
        assert "error" in resp.json()

    def test_stt_empty_body_rejected(self, client):
        resp = client.post("/stt", content=b"", headers=AUTH)
        assert resp.status_code == 400

    def test_stt_invalid_lang_rejected(self, client):
        resp = client.post("/stt?lang=fr", content=b"abc", headers=AUTH)
        assert resp.status_code == 400

    def test_tts_over_4000_chars_rejected(self, client):
        resp = client.post("/tts", json={"text": "a" * 4001, "lang": "es"}, headers=AUTH)
        assert resp.status_code == 413

    def test_tts_at_4000_chars_ok(self, client, monkeypatch):
        monkeypatch.setattr(phantom_voice, "synthesize", lambda *a, **k: (np.zeros(100, dtype=np.float32), 24000))
        resp = client.post("/tts", json={"text": "a" * 4000, "lang": "es"}, headers=AUTH)
        assert resp.status_code == 200

    def test_tts_invalid_lang_rejected(self, client):
        resp = client.post("/tts", json={"text": "hola", "lang": "fr"}, headers=AUTH)
        assert resp.status_code == 400

    def test_tts_missing_text_field_422(self, client):
        resp = client.post("/tts", json={"lang": "es"}, headers=AUTH)
        assert resp.status_code == 422
        assert "error" in resp.json()


# ---------------------------------------------------------------------------
# Endpoint behaviour with mocked engines
# ---------------------------------------------------------------------------

class TestSTTEndpoint:
    def test_stt_success_returns_expected_shape(self, client, monkeypatch):
        async def fake_transcribe(body, lang):
            return "hola mundo", "es", 1234

        monkeypatch.setattr(phantom_voice, "transcribe", fake_transcribe)
        resp = client.post("/stt", content=b"fake-audio", headers={**AUTH, "Content-Type": "audio/webm"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["text"] == "hola mundo"
        assert body["language"] == "es"
        assert body["duration_ms"] == 1234
        assert isinstance(body["elapsed_ms"], int)

    def test_stt_transcribe_failure_returns_422(self, client, monkeypatch):
        async def boom(body, lang):
            raise RuntimeError("bad audio")

        monkeypatch.setattr(phantom_voice, "transcribe", boom)
        resp = client.post("/stt", content=b"not-audio", headers=AUTH)
        assert resp.status_code == 422
        assert "error" in resp.json()


class TestTTSEndpoint:
    def test_tts_success_returns_wav_bytes(self, client, monkeypatch):
        monkeypatch.setattr(phantom_voice, "synthesize", lambda *a, **k: (np.zeros(2400, dtype=np.float32), 24000))
        resp = client.post("/tts", json={"text": "hola mundo", "lang": "es"}, headers=AUTH)
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "audio/wav"
        assert resp.content[:4] == b"RIFF"

    def test_tts_default_voice_used(self, client, monkeypatch):
        seen = {}

        def fake_synth(text, voice, speed, lang):
            seen["voice"] = voice
            return np.zeros(100, dtype=np.float32), 24000

        monkeypatch.setattr(phantom_voice, "synthesize", fake_synth)
        client.post("/tts", json={"text": "hola", "lang": "es"}, headers=AUTH)
        assert seen["voice"] == phantom_voice.DEFAULT_VOICES["es"]

    def test_tts_explicit_voice_overrides_default(self, client, monkeypatch):
        seen = {}

        def fake_synth(text, voice, speed, lang):
            seen["voice"] = voice
            return np.zeros(100, dtype=np.float32), 24000

        monkeypatch.setattr(phantom_voice, "synthesize", fake_synth)
        client.post("/tts", json={"text": "hola", "lang": "es", "voice": "em_alex"}, headers=AUTH)
        assert seen["voice"] == "em_alex"

    def test_tts_strips_code_block_before_synth(self, client, monkeypatch):
        seen = {}

        def fake_synth(text, voice, speed, lang):
            seen["text"] = text
            return np.zeros(100, dtype=np.float32), 24000

        monkeypatch.setattr(phantom_voice, "synthesize", fake_synth)
        client.post("/tts", json={"text": "before ```code``` after", "lang": "en"}, headers=AUTH)
        assert "(code block)" in seen["text"]

    def test_tts_synthesis_failure_returns_422(self, client, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("engine exploded")

        monkeypatch.setattr(phantom_voice, "synthesize", boom)
        resp = client.post("/tts", json={"text": "hola", "lang": "es"}, headers=AUTH)
        assert resp.status_code == 422
        assert "error" in resp.json()


# ---------------------------------------------------------------------------
# STT lifecycle: lazy load, CUDA->CPU fallback, idle unload (VRAM release)
# ---------------------------------------------------------------------------

class TestSTTLifecycle:
    def test_lazy_load_is_deferred(self, monkeypatch):
        monkeypatch.setattr(phantom_voice, "_import_whisper_model", lambda: FakeWhisperModel)
        assert phantom_voice.STT_STATE["loaded"] is False
        assert len(FakeWhisperModel.instances) == 0

    def test_get_stt_model_loads_on_cuda_and_marks_loaded(self, monkeypatch):
        monkeypatch.setattr(phantom_voice, "_import_whisper_model", lambda: FakeWhisperModel)
        model = run(phantom_voice.get_stt_model())
        assert model.device == "cuda"
        assert phantom_voice.STT_STATE["loaded"] is True
        assert phantom_voice.STT_STATE["device"] == "cuda"
        assert len(FakeWhisperModel.instances) == 1

    def test_get_stt_model_falls_back_to_cpu_on_cuda_failure(self, monkeypatch):
        FakeWhisperModel.fail_on_cuda = True
        monkeypatch.setattr(phantom_voice, "_import_whisper_model", lambda: FakeWhisperModel)
        model = run(phantom_voice.get_stt_model())
        assert model.device == "cpu"
        assert phantom_voice.STT_STATE["device"] == "cpu"
        assert phantom_voice.STT_STATE["loaded"] is True

    def test_get_stt_model_is_cached_across_calls(self, monkeypatch):
        monkeypatch.setattr(phantom_voice, "_import_whisper_model", lambda: FakeWhisperModel)
        run(phantom_voice.get_stt_model())
        run(phantom_voice.get_stt_model())
        assert len(FakeWhisperModel.instances) == 1

    def test_concurrent_get_stt_model_loads_only_once(self, monkeypatch):
        # The lock must serialize two in-flight loads so we never end up with
        # two half-initialized models (or a race on STT_STATE).
        monkeypatch.setattr(phantom_voice, "_import_whisper_model", lambda: FakeWhisperModel)

        async def scenario():
            return await asyncio.gather(phantom_voice.get_stt_model(), phantom_voice.get_stt_model())

        m1, m2 = run(scenario())
        assert m1 is m2
        assert len(FakeWhisperModel.instances) == 1

    def test_unload_when_nothing_loaded_is_a_safe_noop(self):
        unloaded = run(phantom_voice.unload_stt_model())
        assert unloaded is False

    def test_unload_after_load_clears_state(self, monkeypatch):
        monkeypatch.setattr(phantom_voice, "_import_whisper_model", lambda: FakeWhisperModel)
        run(phantom_voice.get_stt_model())
        assert phantom_voice.STT_STATE["loaded"] is True

        unloaded = run(phantom_voice.unload_stt_model(reason="test"))
        assert unloaded is True
        assert phantom_voice.STT_STATE["loaded"] is False
        assert phantom_voice._stt_model is None

    def test_transcribe_reloads_after_unload(self, monkeypatch):
        monkeypatch.setattr(phantom_voice, "_import_whisper_model", lambda: FakeWhisperModel)
        run(phantom_voice.get_stt_model())
        run(phantom_voice.unload_stt_model())
        assert phantom_voice.STT_STATE["loaded"] is False

        text, lang, duration_ms = run(phantom_voice.transcribe(b"fake-bytes", "es"))
        assert text == "hola mundo"
        assert phantom_voice.STT_STATE["loaded"] is True
        # unload + reload -> a second underlying model instance
        assert len(FakeWhisperModel.instances) == 2

    def test_maybe_unload_idle_noop_when_not_loaded(self, monkeypatch):
        monkeypatch.setattr(phantom_voice, "STT_IDLE_UNLOAD_S", 20.0)
        assert run(phantom_voice._maybe_unload_idle_stt()) is False

    def test_maybe_unload_idle_noop_before_threshold(self, monkeypatch):
        monkeypatch.setattr(phantom_voice, "_import_whisper_model", lambda: FakeWhisperModel)
        monkeypatch.setattr(phantom_voice, "STT_IDLE_UNLOAD_S", 20.0)
        fake_clock = {"t": 1000.0}
        monkeypatch.setattr(phantom_voice, "_now", lambda: fake_clock["t"])

        run(phantom_voice.get_stt_model())  # last_used = 1000.0
        fake_clock["t"] = 1010.0  # only 10s idle, threshold is 20s

        assert run(phantom_voice._maybe_unload_idle_stt()) is False
        assert phantom_voice.STT_STATE["loaded"] is True

    def test_maybe_unload_idle_unloads_past_threshold(self, monkeypatch):
        monkeypatch.setattr(phantom_voice, "_import_whisper_model", lambda: FakeWhisperModel)
        monkeypatch.setattr(phantom_voice, "STT_IDLE_UNLOAD_S", 20.0)
        fake_clock = {"t": 1000.0}
        monkeypatch.setattr(phantom_voice, "_now", lambda: fake_clock["t"])

        run(phantom_voice.get_stt_model())  # last_used = 1000.0
        fake_clock["t"] = 1025.0  # 25s idle, past the 20s threshold

        assert run(phantom_voice._maybe_unload_idle_stt()) is True
        assert phantom_voice.STT_STATE["loaded"] is False
        assert phantom_voice._stt_model is None

    def test_maybe_unload_idle_disabled_when_zero(self, monkeypatch):
        monkeypatch.setattr(phantom_voice, "_import_whisper_model", lambda: FakeWhisperModel)
        monkeypatch.setattr(phantom_voice, "STT_IDLE_UNLOAD_S", 0)
        fake_clock = {"t": 1000.0}
        monkeypatch.setattr(phantom_voice, "_now", lambda: fake_clock["t"])

        run(phantom_voice.get_stt_model())
        fake_clock["t"] = 1_000_000.0  # absurdly idle, still disabled

        assert run(phantom_voice._maybe_unload_idle_stt()) is False
        assert phantom_voice.STT_STATE["loaded"] is True

    def test_transcribe_refreshes_idle_clock(self, monkeypatch):
        monkeypatch.setattr(phantom_voice, "_import_whisper_model", lambda: FakeWhisperModel)
        fake_clock = {"t": 1000.0}
        monkeypatch.setattr(phantom_voice, "_now", lambda: fake_clock["t"])

        run(phantom_voice.transcribe(b"fake-bytes", "es"))
        assert phantom_voice._stt_last_used == 1000.0

        fake_clock["t"] = 1005.0
        run(phantom_voice.transcribe(b"fake-bytes", "es"))
        assert phantom_voice._stt_last_used == 1005.0


class TestHealthReportsLoadedFlag:
    def test_loaded_false_before_first_use(self, client):
        body = client.get("/health").json()
        assert body["stt"]["loaded"] is False

    def test_loaded_true_after_stt_load(self, client, monkeypatch):
        monkeypatch.setattr(phantom_voice, "_import_whisper_model", lambda: FakeWhisperModel)
        run(phantom_voice.get_stt_model())
        body = client.get("/health").json()
        assert body["stt"]["loaded"] is True

    def test_loaded_false_again_after_unload(self, client, monkeypatch):
        monkeypatch.setattr(phantom_voice, "_import_whisper_model", lambda: FakeWhisperModel)
        run(phantom_voice.get_stt_model())
        run(phantom_voice.unload_stt_model())
        body = client.get("/health").json()
        assert body["stt"]["loaded"] is False
