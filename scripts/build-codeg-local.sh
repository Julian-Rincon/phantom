#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/codeg/src-tauri"
export PATH="$HOME/.cargo/bin:$PATH"

cd "$ROOT"

echo "[1/4] rustfmt check (changed parser/tests)"
rustfmt --edition 2021 --check src/parsers/opencode.rs tests/parsers_snapshot.rs

echo "[2/4] cargo check (server + mcp)"
cargo check --no-default-features --bin codeg-server --bin codeg-mcp

echo "[3/4] parser integration tests"
cargo test --no-default-features --features test-utils --test parsers_snapshot

echo "[4/4] cargo test (server library)"
cargo test --no-default-features --bin codeg-server --lib

echo "BUILD_READY"
