#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
POINTER="$HOME/Library/Application Support/FeishuCodexBridge/bootstrap/installation.json"
NODE_PATH="${FEISHU_CODEX_BRIDGE_NODE:-}"

if [[ -z "$NODE_PATH" && -f "$POINTER" ]]; then
  NODE_PATH="$(/usr/bin/plutil -extract nodeExecutable raw -o - "$POINTER" 2>/dev/null || true)"
fi
if [[ -z "$NODE_PATH" ]]; then
  for candidate in \
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
    "/Applications/Codex.app/Contents/Resources/cua_node/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"; do
    if [[ -x "$candidate" ]]; then
      NODE_PATH="$candidate"
      break
    fi
  done
fi
if [[ ! -x "$NODE_PATH" ]]; then
  echo '{"ok":false,"error":{"code":"binding_request_unavailable","message":"The Bridge Node.js runtime is unavailable.","missingScopes":[]}}'
  exit 1
fi

exec "$NODE_PATH" "$SCRIPT_DIR/request-binding.mjs"
