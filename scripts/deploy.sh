#!/usr/bin/env bash
# Deploy: bump the cache generation, restamp the build id, verify, push.
#
# The two failure modes this exists to prevent, both of which cost a full round trip when they
# happen: shipping a fix that never reaches the phone because V wasn't bumped, and reading a bug
# report against a build nobody can identify. So V ALWAYS moves and build.js is ALWAYS restamped.
#
#   ./scripts/deploy.sh            bump, verify, commit, push
#   ./scripts/deploy.sh --dry      everything except the commit and push
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
[ "${1:-}" = "--dry" ] && DRY=1

# --- bump V -------------------------------------------------------------------
# The stem is free; the NUMERIC TAIL is load-bearing (it orders cache generations for sw.js's
# collect and app.js's checkVer ranking). sw-lint.py rejects a V without digits.
cur="$(grep -o 'const V = "[^"]*"' sw.js | head -1 | sed 's/.*"\(.*\)"/\1/')"
stem="$(printf '%s' "$cur" | sed 's/[0-9]*$//')"
num="$(printf '%s' "$cur" | grep -o '[0-9]*$')"
next="${stem}$((num + 1))"
sed -i '' "s/const V = \"${cur}\"/const V = \"${next}\"/" sw.js
echo "V: ${cur} -> ${next}"

# Keep app.js's VER_PREFIX in agreement with the stem — sw-lint checks this, but fixing it here
# means the check never fires in the first place.
sed -i '' "s/^const VER_PREFIX = \"[^\"]*\";/const VER_PREFIX = \"${stem}\";/" app.js

# --- verify BEFORE committing --------------------------------------------------
echo "--- tests ---"
node --test tests/*.test.mjs
node scripts/sw.test.mjs > /dev/null && echo "sw tests ok"
python3 scripts/sw-lint.py
node --check sw.js && node --check app.js && node --check tuner.js && node --check tuner-worklet.js
echo "--- ok ---"

if [ "$DRY" = "1" ]; then
  echo "dry run: not committing"
  ./scripts/stamp-build.sh
  exit 0
fi

# --- commit, stamp, push --------------------------------------------------------
# Two commits on purpose. build.js records the SHA of the commit holding the code, which cannot be
# known until that commit exists — so the code lands first, then the stamp. build.js is generated
# and contains no logic, so the SHA on screen always identifies the code you are running.
git add -A
git commit -q -m "${1:-Deploy: ${next}}" || echo "(nothing to commit)"
./scripts/stamp-build.sh
git add build.js
git commit -q -m "Stamp build $(git rev-parse --short HEAD) / ${next}" || echo "(build.js unchanged)"
git push -q origin main
echo "pushed. Pages will rebuild in a minute or two."
echo "Open the URL ONLINE once to prime the service-worker cache before testing offline."
