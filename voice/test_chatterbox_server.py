"""Tests for chatterbox_server: auth, reference dir guard, length limit,
lazy ModelHolder lifecycle (single load, idle unload).

The real Chatterbox/torch stack is never imported: tests inject a fake
model_factory. Run with the phantom-voice venv:
    ~/.local/share/phantom/voice-venv/bin/python -m pytest test_chatterbox_server.py -q
"""
import asyncio
import os
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import pytest

# --- point the module at an isolated fake server.env, BEFORE import --------
FAKE_TOKEN = "test-token-abc123"
_envdir = tempfile.mkdtemp(prefix="chatterbox-test-")
_envfile = Path(_envdir) / "server.env"
_envfile.write_text(f"CODEG_TOKEN={FAKE_TOKEN}\n")
os.environ["PHANTOM_CHATTERBOX_SERVER_ENV"] = str(_envfile)

sys.path.insert(0, str(Path(__file__).parent))
import chatterbox_server  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

AUTH = {"Authorization": f"Bearer {FAKE_TOKEN}"}


class FakeChatterboxModel:
    """Stand-in for the Chatterbox wrapper: no GPU, no torch, no download."""

    def __init__(self):
        self.calls = []
        self.active = 0
        self.max_active = 0

    def generate(self, text, reference, exaggeration, cfg_weight, lang):
        if not isinstance(text, str) or not text:
            raise AssertionError("unexpected text")
        if exaggeration is None or cfg_weight is None:
            raise AssertionError("unexpected params")
        if lang not in ("es", "en"):
            raise AssertionError("unexpected lang")
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        import time as _t
        _t.sleep(0.05)
        self.active -= 1
        self.calls.append(
            {"text": text, "reference": reference, "lang": lang,
             "exaggeration": exaggeration, "cfg_weight": cfg_weight}
        )
        return np.zeros(2400, dtype=np.float32), 24000


class FakeFactory:
    def __init__(self):
        self.model = FakeChatterboxModel()
        self.builds = 0

    def __call__(self):
        self.builds += 1
        return self.model


@pytest.fixture()
def refs_dir(tmp_path, monkeypatch):
    refs = tmp_path / "refs"
    refs.mkdir()
    (refs / "nexus.wav").write_bytes(b"RIFFfake")
    monkeypatch.setattr(chatterbox_server, "REFS_DIR", refs)
    return refs


@pytest.fixture()
def factory():
    f = FakeFactory()
    chatterbox_server._holder = chatterbox_server.ModelHolder(f)
    yield f
    chatterbox_server._holder = None


@pytest.fixture()
def client(factory, refs_dir):
    return TestClient(chatterbox_server.app)


def test_requires_auth(client):
    resp = client.post("/tts", json={"text": "hola", "lang": "es"})
    assert resp.status_code == 401


def test_health_ok(client):
    body = client.get("/health").json()
    assert body == {"ok": True, "loaded": False}


def test_reference_outside_refs_rejected(client):
    resp = client.post(
        "/tts",
        json={"text": "hola", "lang": "es", "reference": "/etc/passwd"},
        headers=AUTH,
    )
    assert resp.status_code == 400
    resp = client.post(
        "/tts",
        json={"text": "hola", "lang": "es", "reference": "../secret.wav"},
        headers=AUTH,
    )
    assert resp.status_code == 400


def test_text_over_600_chars_rejected(client):
    resp = client.post("/tts", json={"text": "a" * 601, "lang": "es"}, headers=AUTH)
    assert resp.status_code == 413


def test_tts_success_and_single_load_across_two_requests(client, factory):
    body = {"text": "hola", "lang": "es", "reference": "nexus.wav"}
    r1 = client.post("/tts", json=body, headers=AUTH)
    r2 = client.post("/tts", json=body, headers=AUTH)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.headers["content-type"] == "audio/wav"
    assert r1.content[:4] == b"RIFF"
    assert factory.builds == 1
    assert len(factory.model.calls) == 2
    assert factory.model.calls[0]["reference"].endswith("nexus.wav")
    assert client.get("/health").json()["loaded"] is True


def test_unload_if_idle_unloads_and_refreshes_clock(client, factory):
    holder = chatterbox_server._holder
    holder.get()
    holder.touch()
    assert holder.unload_if_idle(time.monotonic() + 601, 600) is True
    assert holder.loaded is False
    assert client.get("/health").json()["loaded"] is False
    # A fresh get() after unload rebuilds exactly one more model.
    holder.get()
    assert factory.builds == 2


def test_unload_if_idle_noop_before_threshold(client, factory):
    holder = chatterbox_server._holder
    holder.get()
    assert holder.unload_if_idle(time.monotonic() + 10, 600) is False
    assert holder.loaded is True


def test_lang_is_forwarded_to_model(client, factory):
    resp = client.post("/tts", json={"text": "hola", "lang": "es", "reference": "nexus.wav"}, headers=AUTH)
    assert resp.status_code == 200
    assert factory.model.calls[-1]["lang"] == "es"


def test_concurrent_requests_are_serialized(factory, refs_dir):
    import asyncio
    import httpx

    async def run():
        transport = httpx.ASGITransport(app=chatterbox_server.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            body = {"text": "hola", "lang": "es", "reference": "nexus.wav"}
            rs = await asyncio.gather(*[c.post("/tts", json=body, headers=AUTH) for _ in range(3)])
        return [r.status_code for r in rs]

    assert asyncio.run(run()) == [200, 200, 200]
    assert factory.model.max_active == 1
    assert factory.builds == 1
