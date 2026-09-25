#!/usr/bin/env bash
# Install Price Track Buddy into the current user's GNOME Shell extensions
# directory and try to enable it.
#
# Usage:  ./install.sh [--system]
set -euo pipefail

EXT_UUID="price-track-buddy@mossaistudio.com"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "--system" ]]; then
    DEST="/usr/share/gnome-shell/extensions/$EXT_UUID"
    echo "Installing to system dir $DEST (may need sudo perms on the parent dir)"
else
    DEST="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
    echo "Installing to user dir $DEST"
fi

mkdir -p "$DEST"
# Ship the extension files but not the dev/test scaffolding. Wipe lib/ and
# schemas/ first: `cp -r src/lib dest/lib` would otherwise nest into
# dest/lib/lib on a re-install and leave the top-level sources stale.
rm -rf "$DEST/lib" "$DEST/schemas"
mkdir -p "$DEST/lib" "$DEST/schemas"
cp "$SRC_DIR/metadata.json" "$SRC_DIR/extension.js" "$SRC_DIR/prefs.js" "$SRC_DIR/stylesheet.css" "$DEST/"
cp "$SRC_DIR"/lib/*.js "$DEST/lib/"
cp "$SRC_DIR/schemas/org.gnome.shell.extensions.price-track-buddy.gschema.xml" "$DEST/schemas/"
if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas "$DEST/schemas"
fi

echo "Installed to $DEST"
echo "Files:"; ls -la "$DEST"

if command -v gnome-extensions >/dev/null 2>&1; then
    echo "Enabling $EXT_UUID (restart the Shell [Alt+F2 → 'r'] or log out/in if it does not appear)..."
    gnome-extensions enable "$EXT_UUID" 2>&1 || true
    gnome-extensions list --enabled 2>/dev/null | grep -q "$EXT_UUID" \
        && echo "✔ enabled" || echo "⚠ not running yet — check with: gnome-extensions info $EXT_UUID"
else
    echo "gnome-extensions not found; enable manually from the Extensions app."
fi