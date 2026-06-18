#!/usr/bin/env bash
# Aurora installer — build the agent + harness and put `aurora` on your PATH. Idempotent.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

command -v node >/dev/null 2>&1 || { echo "ERROR: node not found. Aurora needs Node >= 22." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "ERROR: Node >= 22 required (found $(node --version))." >&2; exit 1
fi

echo "Aurora — installing"
echo "  1/3  npm install"
npm install
echo "  2/3  build (tui · ai · agent · coding-agent)"
npm run build
echo "  3/3  link the 'aurora' command"
( cd packages/coding-agent && npm link )

cat <<'EOF'

Done. Aurora is installed.
  aurora login     # one-time: authenticate (OAuth — uses your Claude subscription)
  aurora           # start  (the harness is built in: spawn_agent / spawn_agents / run_team)

Config lives in ~/.aurora/. Switch themes with `aurora themes <name>` (default: aurora).
EOF
