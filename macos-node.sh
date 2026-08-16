#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

candidates=()
if [[ -n "${FEISHU_CODEX_BRIDGE_NODE:-}" ]]; then
  candidates+=("$FEISHU_CODEX_BRIDGE_NODE")
fi
candidates+=(
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
  "/Applications/Codex.app/Contents/Resources/cua_node/bin/node"
  "/opt/homebrew/bin/node"
  "/usr/local/bin/node"
)
if command -v node >/dev/null 2>&1; then
  candidates+=("$(command -v node)")
fi

for candidate in "${candidates[@]}"; do
  if [[ -x "$candidate" ]]; then
    version="$($candidate --version 2>/dev/null || true)"
    if [[ "$version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
      node_major="${BASH_REMATCH[1]}"
      node_minor="${BASH_REMATCH[2]}"
      if (( node_major > 22 || (node_major == 22 && node_minor >= 13) )); then
        exec "$candidate" "$SCRIPT_DIR/macos-admin.mjs" "$@"
      fi
    fi
  fi
done

echo "Node.js 22.13 or newer was not found. Install Node.js or Codex Desktop, then retry." >&2
exit 1
