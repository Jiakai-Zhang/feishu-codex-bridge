#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This foreground updater supports macOS only." >&2
  exit 1
fi

VERSION=""
REMOTE="origin"
while (($# > 0)); do
  case "$1" in
    --version)
      (($# >= 2)) || { echo "--version requires a value." >&2; exit 1; }
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#*=}"
      shift
      ;;
    --remote)
      (($# >= 2)) || { echo "--remote requires a value." >&2; exit 1; }
      REMOTE="$2"
      shift 2
      ;;
    --remote=*)
      REMOTE="${1#*=}"
      shift
      ;;
    *)
      echo "Unknown foreground update option." >&2
      exit 1
      ;;
  esac
done

if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$ ]]; then
  echo "--version must be an explicit semantic release tag." >&2
  exit 1
fi
if [[ "$REMOTE" != "origin" && "$REMOTE" != "private" ]]; then
  echo "--remote must be either origin or private." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if /usr/bin/git -C "$SCRIPT_DIR" rev-parse --show-toplevel >/dev/null 2>&1; then
  INSTALL_ROOT="$(/usr/bin/git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
else
  INSTALL_ROOT="$(pwd -P)"
fi
if ! /usr/bin/git -C "$INSTALL_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Run this updater from the existing Feishu Codex Bridge Git checkout." >&2
  exit 1
fi

REMOTE_URL="$(/usr/bin/git -C "$INSTALL_ROOT" remote get-url "$REMOTE")"
if [[ ! "$REMOTE_URL" =~ ^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)((ninmon|Jiakai-Zhang)/feishu-codex-bridge|ninmon/feishu-codex-bridge-private)(\.git)?/?$ ]]; then
  echo "The selected update remote is not an approved Feishu Codex Bridge repository." >&2
  exit 1
fi

/usr/bin/git -C "$INSTALL_ROOT" fetch --quiet "$REMOTE" "refs/tags/$VERSION:refs/tags/$VERSION"
TARGET_COMMIT="$(/usr/bin/git -C "$INSTALL_ROOT" rev-parse --verify "refs/tags/$VERSION^{commit}")"
TEMPORARY_ROOT="$(/usr/bin/mktemp -d -t feishu-bridge-macos-foreground-)"
HANDOFF_COMPLETE=0
cleanup() {
  if (( HANDOFF_COMPLETE == 0 )) && [[ -d "$TEMPORARY_ROOT" ]] \
    && [[ "$(/usr/bin/basename "$TEMPORARY_ROOT")" == feishu-bridge-macos-foreground-* ]] \
    && [[ ! -f "$TEMPORARY_ROOT/.foreground-worker-opened" ]]; then
    /bin/rm -rf -- "$TEMPORARY_ROOT"
  fi
}
trap cleanup EXIT

/usr/bin/git -C "$INSTALL_ROOT" archive "$TARGET_COMMIT" src/runtime | /usr/bin/tar -x -C "$TEMPORARY_ROOT"
FOREGROUND_MODULE="$TEMPORARY_ROOT/src/runtime/platform/macos/foreground-update.mjs"
TARGET_UPDATER="$TEMPORARY_ROOT/src/runtime/platform/macos/update.mjs"
if [[ ! -f "$FOREGROUND_MODULE" ]] || [[ ! -f "$TARGET_UPDATER" ]] \
  || ! /usr/bin/grep -q 'preflight-only' "$TARGET_UPDATER"; then
  echo "The requested release does not support the macOS foreground update contract." >&2
  exit 1
fi

NODE_CANDIDATES=()
if [[ -n "${FEISHU_CODEX_BRIDGE_NODE:-}" ]]; then
  NODE_CANDIDATES+=("$FEISHU_CODEX_BRIDGE_NODE")
fi
NODE_CANDIDATES+=(
  "/opt/homebrew/bin/node"
  "/usr/local/bin/node"
)
if command -v node >/dev/null 2>&1; then
  NODE_CANDIDATES+=("$(command -v node)")
fi
BUNDLE_CANDIDATES=(
  "/Applications/ChatGPT.app"
  "/Applications/Codex.app"
  "$HOME/Applications/ChatGPT.app"
  "$HOME/Applications/Codex.app"
)
while IFS= read -r bundle_path; do
  [[ -n "$bundle_path" ]] && BUNDLE_CANDIDATES+=("$bundle_path")
done < <(/usr/bin/mdfind "kMDItemCFBundleIdentifier == 'com.openai.codex' || kMDItemCFBundleIdentifier == 'com.openai.chatgpt'" 2>/dev/null || true)
for bundle_path in "${BUNDLE_CANDIDATES[@]}"; do
  [[ -d "$bundle_path" ]] || continue
  if /usr/bin/codesign --verify --deep --strict "$bundle_path" >/dev/null 2>&1 \
    && /usr/bin/codesign -dv --verbose=4 "$bundle_path" 2>&1 \
      | /usr/bin/grep -q '^TeamIdentifier=2DC432GLL2$'; then
    NODE_CANDIDATES+=("$bundle_path/Contents/Resources/cua_node/bin/node")
  fi
done

NODE_EXECUTABLE=""
for candidate in "${NODE_CANDIDATES[@]}"; do
  if [[ -x "$candidate" ]]; then
    node_version="$($candidate --version 2>/dev/null || true)"
    if [[ "$node_version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
      node_major="${BASH_REMATCH[1]}"
      node_minor="${BASH_REMATCH[2]}"
      if (( node_major > 22 || (node_major == 22 && node_minor >= 13) )); then
        NODE_EXECUTABLE="$candidate"
        break
      fi
    fi
  fi
done
if [[ -z "$NODE_EXECUTABLE" ]]; then
  echo "Node.js 22.13 or newer was not found. Install Node.js or Codex Desktop, then retry." >&2
  exit 1
fi

(
  cd -- "$INSTALL_ROOT"
  "$NODE_EXECUTABLE" "$FOREGROUND_MODULE" --version "$VERSION" --remote "$REMOTE"
)
HANDOFF_COMPLETE=1
