#!/bin/bash
# Make a fresh clone match what CLAUDE.md assumes.
#
# Two things this repo needs are per-clone state that git does not carry: the push
# guard has to be switched on by hand, and node_modules has to exist. A cloud session
# is a brand new clone every time, so both were missing on every phone session.
set -euo pipefail

repo="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$repo"

# The push guard. core.hooksPath is local config that is never committed, so every
# clone starts without it and git silently pushes unguarded. Cheap and idempotent,
# so it runs on desktop too, not just on the web.
git config core.hooksPath .githooks

# Everything below is only needed on a fresh cloud VM.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Node's built-in fetch does not read HTTPS_PROXY, so the suites bypass the sandbox
# proxy and get a plaintext refusal that they try to JSON.parse. The refusal reads
# "Host not in allowlist: api.hyperliquid.xyz" even when that host IS allowlisted,
# which is a convincing way to waste an hour in the environment settings.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export NODE_USE_ENV_PROXY=1' >> "$CLAUDE_ENV_FILE"
fi

# npm install, not npm ci: the filesystem is snapshotted after this runs, and install
# reuses what the snapshot already has. --no-save because the cloud image ships an
# older npm than the one that wrote package-lock.json, and a plain install strips
# the lockfile's libc metadata, leaving every session with a dirty tree.
npm install --no-save --no-audit --no-fund
