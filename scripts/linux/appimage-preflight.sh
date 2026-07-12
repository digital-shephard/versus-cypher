#!/usr/bin/env bash
set -Eeuo pipefail

APPIMAGE_INPUT="${1:-}"
REPORT_PATH="${VERSUS_LINUX_PREFLIGHT_REPORT:-}"
LAUNCH_SECONDS="${VERSUS_LINUX_PREFLIGHT_LAUNCH_SECONDS:-10}"

if [[ -z "$APPIMAGE_INPUT" ]]; then
  echo "usage: $0 PATH_TO_APPIMAGE" >&2
  exit 64
fi

APPIMAGE="$(readlink -f "$APPIMAGE_INPUT")"
if [[ ! -f "$APPIMAGE" ]]; then
  echo "AppImage not found: $APPIMAGE" >&2
  exit 66
fi
if [[ ! -x "$APPIMAGE" ]]; then
  echo "AppImage is not executable: $APPIMAGE" >&2
  exit 77
fi

for command in file desktop-file-validate node sha256sum xvfb-run; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "missing preflight dependency: $command" >&2
    exit 69
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PET_ROOT="$REPO_ROOT/apps/pet"
WORK_ROOT="$(mktemp -d)"
EXTRACT_ROOT="$WORK_ROOT/extracted"
PROFILE_ROOT="$WORK_ROOT/profile"
LOG_ROOT="$WORK_ROOT/logs"
mkdir -p "$EXTRACT_ROOT" "$PROFILE_ROOT" "$LOG_ROOT"

cleanup() {
  rm -rf "$WORK_ROOT"
}
trap cleanup EXIT

FILE_DESCRIPTION="$(file -b "$APPIMAGE")"
if [[ "$FILE_DESCRIPTION" != *"ELF 64-bit"* ]]; then
  echo "unexpected AppImage file type: $FILE_DESCRIPTION" >&2
  exit 65
fi
SHA256="$(sha256sum "$APPIMAGE" | awk '{print $1}')"

(
  cd "$EXTRACT_ROOT"
  "$APPIMAGE" --appimage-extract >/dev/null
)
APPDIR="$EXTRACT_ROOT/squashfs-root"
[[ -x "$APPDIR/AppRun" ]] || { echo "AppRun is missing or not executable" >&2; exit 65; }

DESKTOP_FILE="$(find "$APPDIR" -maxdepth 2 -type f -name '*.desktop' -print -quit)"
[[ -n "$DESKTOP_FILE" ]] || { echo "embedded desktop file is missing" >&2; exit 65; }
desktop-file-validate "$DESKTOP_FILE"
grep -Eq '^Name=Versus Cypher$' "$DESKTOP_FILE" || { echo "desktop product name is incorrect" >&2; exit 65; }
grep -Eq '^Exec=AppRun( |$)' "$DESKTOP_FILE" || { echo "desktop executable is incorrect" >&2; exit 65; }
ICON_NAME="$(sed -n 's/^Icon=//p' "$DESKTOP_FILE" | head -n 1)"
[[ -n "$ICON_NAME" ]] || { echo "desktop icon name is missing" >&2; exit 65; }
ICON_FILE="$(find "$APPDIR" -type f \( -name "$ICON_NAME.png" -o -name 'v_gem.png' -o -name 'versus-cypher.png' \) -print -quit)"
[[ -n "$ICON_FILE" ]] || { echo "V-gem desktop icon is missing" >&2; exit 65; }

ASAR_PATH="$APPDIR/resources/app.asar"
[[ -f "$ASAR_PATH" ]] || { echo "packaged app.asar is missing" >&2; exit 65; }
PACKAGE_RESULT="$(
  cd "$PET_ROOT"
  node - "$ASAR_PATH" "$(node -p "require('./package.json').version")" <<'NODE'
const asar = require("@electron/asar");
const archive = process.argv[2];
const expectedVersion = process.argv[3];
const pkg = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
if (pkg.name !== "versus-cypher") throw new Error(`unexpected package name: ${pkg.name}`);
if (pkg.version !== expectedVersion) throw new Error(`unexpected package version: ${pkg.version}`);
if (pkg.versusSignedUpdates !== false) throw new Error("Linux updater metadata is not fail-closed");
process.stdout.write(`${pkg.name}@${pkg.version};updates=off`);
NODE
)"

run_launch() {
  local run_number="$1"
  local log_file="$LOG_ROOT/launch-$run_number.log"
  mkdir -p \
    "$PROFILE_ROOT/home" \
    "$PROFILE_ROOT/config" \
    "$PROFILE_ROOT/cache" \
    "$PROFILE_ROOT/data" \
    "$PROFILE_ROOT/runtime"
  chmod 700 "$PROFILE_ROOT/runtime"

  setsid env \
    HOME="$PROFILE_ROOT/home" \
    XDG_CONFIG_HOME="$PROFILE_ROOT/config" \
    XDG_CACHE_HOME="$PROFILE_ROOT/cache" \
    XDG_DATA_HOME="$PROFILE_ROOT/data" \
    XDG_RUNTIME_DIR="$PROFILE_ROOT/runtime" \
    VERSUS_DISABLE_UPDATES=1 \
    APPIMAGE_EXTRACT_AND_RUN=1 \
    xvfb-run -a "$APPIMAGE" >"$log_file" 2>&1 &
  local launch_pid=$!
  sleep "$LAUNCH_SECONDS"
  if ! kill -0 "$launch_pid" 2>/dev/null; then
    cat "$log_file" >&2
    echo "packaged launch $run_number exited before the smoke window elapsed" >&2
    exit 70
  fi
  kill -TERM -- "-$launch_pid" 2>/dev/null || true
  wait "$launch_pid" 2>/dev/null || true

  if grep -Eqi 'segmentation fault|fatal error|trace/breakpoint trap|uncaught exception' "$log_file"; then
    cat "$log_file" >&2
    echo "packaged launch $run_number logged a fatal error" >&2
    exit 70
  fi
}

run_launch 1
USER_DATA_DIR="$(find "$PROFILE_ROOT/config" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[[ -n "$USER_DATA_DIR" ]] || { echo "first launch did not create a persistent application profile" >&2; exit 70; }
PROFILE_NAME="$(basename "$USER_DATA_DIR")"
printf 'linux-preflight\n' > "$USER_DATA_DIR/.versus-preflight-sentinel"
run_launch 2
[[ -f "$USER_DATA_DIR/.versus-preflight-sentinel" ]] || { echo "second launch did not preserve the application profile" >&2; exit 70; }

if [[ -z "$REPORT_PATH" ]]; then
  REPORT_PATH="$REPO_ROOT/research/package-smoke/linux-appimage-preflight.txt"
fi
mkdir -p "$(dirname "$REPORT_PATH")"
cat > "$REPORT_PATH" <<EOF
Versus Cypher Linux AppImage preflight
appimage=$(basename "$APPIMAGE")
sha256=$SHA256
file=$FILE_DESCRIPTION
desktop=$(basename "$DESKTOP_FILE")
icon=$(basename "$ICON_FILE")
package=$PACKAGE_RESULT
profile=$PROFILE_NAME
launches=2
result=pass
EOF

echo "Linux AppImage preflight passed"
cat "$REPORT_PATH"
