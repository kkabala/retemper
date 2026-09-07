#!/usr/bin/env bash
set -euo pipefail

# retemper has no runtime dependencies (Node built-ins only), so there is
# nothing to npm-install. The one setup step is making its TypeScript sources
# runnable with a bare `node`: the environment's default node (22.14) supports
# type stripping only behind a flag, while the project's scripts and bin
# shebangs invoke `node install.ts`, `node retemper.ts`, and
# `node --test tests/*.test.ts` directly. Export the flag for every login shell
# (and silence the experimental warning) so those commands work as documented.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NODE_OPTS_LINE='export NODE_OPTIONS="--experimental-strip-types --disable-warning=ExperimentalWarning"'
PROFILE="$HOME/.bashrc"

touch "$PROFILE"
if ! grep -qF "$NODE_OPTS_LINE" "$PROFILE"; then
  {
    printf '\n# retemper: run TypeScript sources directly with node\n'
    printf '%s\n' "$NODE_OPTS_LINE"
  } >> "$PROFILE"
fi

# Prove the toolchain can execute the project's TypeScript entrypoint.
eval "$NODE_OPTS_LINE"
node retemper.ts help >/dev/null

echo "retemper environment ready: node $(node --version), direct TypeScript execution enabled."
