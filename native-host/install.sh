#!/bin/bash
# Registers wocoo_launcher.py with Chrome as a native messaging host, so the
# extension's "Investigate Interest" button can start the local Interest
# Validation tool. Run once; re-run if you move the repo or Chrome profile.
set -euo pipefail

HOST_NAME="com.wealthsimple.wocoo_launcher"
EXT_ID="pdmbcpaejdbacemeegajigebhkjalkkj"

DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$DIR/wocoo_launcher.py"

if [ ! -f "$HOST_PATH" ]; then
  echo "❌  wocoo_launcher.py not found next to this script ($DIR)"
  exit 1
fi
chmod +x "$HOST_PATH"

# Chrome, Chrome Beta and Chromium each read their own directory; install into
# whichever profiles exist on this machine.
INSTALLED=0
for BASE in \
  "$HOME/Library/Application Support/Google/Chrome" \
  "$HOME/Library/Application Support/Google/Chrome Beta" \
  "$HOME/Library/Application Support/Chromium"
do
  [ -d "$BASE" ] || continue
  TARGET_DIR="$BASE/NativeMessagingHosts"
  mkdir -p "$TARGET_DIR"
  cat > "$TARGET_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Launches local tools for the WOCOO Triager extension",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
  echo "✓  Registered in $TARGET_DIR"
  INSTALLED=$((INSTALLED + 1))
done

if [ "$INSTALLED" -eq 0 ]; then
  echo "❌  No Chrome profile directory found under ~/Library/Application Support"
  exit 1
fi

echo ""
echo "Host script: $HOST_PATH"
echo "Extension:   $EXT_ID"
echo ""
echo "Restart Chrome (fully quit, not just close the window) for it to pick this up."
