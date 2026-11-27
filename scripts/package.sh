#!/usr/bin/env bash
# Builds the Chrome Web Store upload: dist/sub-assist-<version>.zip
#
# Only what the extension runs is packed (an allowlist, not a denylist), so
# README, tests, .lavish, .git and anything local never reach the store.
# The packed files are then scanned for anything that looks like a key or
# personal data; a hit aborts the build.
set -euo pipefail

cd "$(dirname "$0")/.."

INCLUDE=(manifest.json src icons)

version=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
out="dist/sub-assist-${version}.zip"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

# Manifest must parse and every file it names must be in the package.
python3 - <<'EOF'
import json, os, sys
m = json.load(open("manifest.json"))
paths = [m["background"]["service_worker"], m["options_page"], m["action"]["default_popup"]]
paths += list(m.get("icons", {}).values()) + list(m["action"].get("default_icon", {}).values())
for cs in m.get("content_scripts", []):
    paths += cs.get("js", []) + cs.get("css", [])
missing = [p for p in paths if not os.path.isfile(p)]
if "128" not in m.get("icons", {}):
    sys.exit("manifest: a 128px icon is required by the Chrome Web Store")
if missing:
    sys.exit(f"manifest references missing files: {missing}")
EOF

cp -R "${INCLUDE[@]}" "$stage/"
find "$stage" \( -name '.DS_Store' -o -name '*.map' -o -name '*.test.js' -o -name '.env*' \) -delete

# Secret / personal-data scan over exactly what will ship.
patterns=(
  'sk-[A-Za-z0-9_-]{20,}'                 # OpenAI keys
  'AIza[0-9A-Za-z_-]{30,}'                # Google API keys
  'Bearer [A-Za-z0-9._-]{20,}'            # hard-coded bearer tokens
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'   # e-mail addresses
  '/Users/[A-Za-z0-9_-]+'                 # local paths
  'localhost|127\.0\.0\.1'
)
fail=0
for p in "${patterns[@]}"; do
  if hits=$(grep -rInE -- "$p" "$stage" 2>/dev/null); then
    echo "!! possible secret ($p):"; echo "${hits//$stage\//}"; fail=1
  fi
done
[ "$fail" -eq 0 ] || { echo "Aborted: review the hits above."; exit 1; }

mkdir -p dist
rm -f "$out"
(cd "$stage" && zip -qrX "$OLDPWD/$out" . -x '.*')
echo "Built $out"
unzip -l "$out"
