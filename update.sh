#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ "${1:-}" == "--foreground" ]]; then
  shift
  exec "$SCRIPT_DIR/src/runtime/platform/macos/update-with-desktop-restart.sh" "$@"
fi
exec "$SCRIPT_DIR/macos-node.sh" update "$@"
