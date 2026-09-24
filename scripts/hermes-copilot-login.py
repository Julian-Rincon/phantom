#!/usr/bin/env python3
"""Run Hermes' native Copilot device login without printing the token."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path.home() / ".hermes" / "hermes-agent"
sys.path.insert(0, str(ROOT))

from hermes_cli.config import save_env_value  # noqa: E402
from hermes_cli.copilot_auth import copilot_device_code_login  # noqa: E402


def main() -> int:
    print("Hermes Copilot OAuth device login", flush=True)
    print("Authorize in the browser using the URL/code below.", flush=True)
    token = copilot_device_code_login(timeout_seconds=300)
    if not token:
        print("LOGIN_FAILED", flush=True)
        return 1
    save_env_value("COPILOT_GITHUB_TOKEN", token)
    print("LOGIN_READY: Copilot credential saved securely.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
