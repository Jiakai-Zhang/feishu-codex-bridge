#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
admin_args=("$@")

candidates=()
if [[ -n "${FEISHU_CODEX_BRIDGE_NODE:-}" ]]; then
  candidates+=("$FEISHU_CODEX_BRIDGE_NODE")
fi
candidates+=("/opt/homebrew/bin/node" "/usr/local/bin/node")
if command -v node >/dev/null 2>&1; then
  candidates+=("$(command -v node)")
fi

launch_with_candidates() {
  for candidate in "$@"; do
    if [[ -x "$candidate" ]]; then
      version="$($candidate --version 2>/dev/null || true)"
      if [[ "$version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
        node_major="${BASH_REMATCH[1]}"
        node_minor="${BASH_REMATCH[2]}"
        if (( node_major > 22 || (node_major == 22 && node_minor >= 13) )); then
          exec "$candidate" "$SCRIPT_DIR/src/runtime/platform/macos/admin-cli.mjs" "${admin_args[@]}"
        fi
      fi
    fi
  done
}

launch_with_candidates "${candidates[@]}"

bundles=(
  "/Applications/ChatGPT.app"
  "/Applications/Codex.app"
  "$HOME/Applications/ChatGPT.app"
  "$HOME/Applications/Codex.app"
)
while IFS= read -r bundle_path; do
  [[ -n "$bundle_path" ]] && bundles+=("$bundle_path")
done < <(/usr/bin/mdfind "kMDItemCFBundleIdentifier == 'com.openai.codex' || kMDItemCFBundleIdentifier == 'com.openai.chatgpt'" 2>/dev/null || true)
for bundle_path in "${bundles[@]}"; do
  [[ -d "$bundle_path" ]] || continue
  if /usr/bin/codesign --verify --deep --strict "$bundle_path" >/dev/null 2>&1 \
    && /usr/bin/codesign -dv --verbose=4 "$bundle_path" 2>&1 \
      | /usr/bin/grep -q '^TeamIdentifier=2DC432GLL2$'; then
    candidates=("$bundle_path/Contents/Resources/cua_node/bin/node")
    launch_with_candidates "${candidates[@]}"
  fi
done

echo "Node.js 22.13 or newer was not found. Install Node.js or Codex Desktop, then retry." >&2
exit 1
