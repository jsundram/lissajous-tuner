#!/usr/bin/env bash
# Deploy: verify, commit code, then bump the cache generation and restamp the build id together.
#
# The two failure modes this exists to prevent, both of which cost a full round trip: shipping a fix
# that never reaches the phone because V wasn't bumped, and reading a bug report against a build
# nobody can identify. So V ALWAYS moves and build.js is ALWAYS restamped.
#
# ORDER MATTERS, and it is not the obvious one. build.js records the SHA of the commit holding the
# code, which cannot be known until that commit exists — so the code lands first and the stamp
# follows. But build.js is itself a precached SHELL file, so a stamp commit that changed it while V
# had already moved in the PREVIOUS commit tripped sw-lint on every single deploy ("changes
# precached shell files but V is still ..."). A lint that cries wolf every time stops being read.
# So the V bump rides in the SAME commit as the stamp: one commit that changes build.js and bumps V
# together, which is exactly the invariant sw-lint is checking for.
#
#   ./scripts/deploy.sh ["commit message"]
#   ./scripts/deploy.sh --dry            verify only; touches nothing
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
[ "${1:-}" = "--dry" ] && DRY=1

# --- verify FIRST, on the tree as it stands -------------------------------------
echo "--- tests ---"
node --test tests/*.test.mjs
node scripts/sw.test.mjs > /dev/null && echo "sw tests ok"
node --check sw.js && node --check app.js && node --check tuner.js && node --check tuner-worklet.js
echo "--- ok ---"

if [ "$DRY" = "1" ]; then echo "dry run: nothing changed"; exit 0; fi

# --- 1. the code commit ----------------------------------------------------------
git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "${1:-Deploy}"
  echo "committed code: $(git rev-parse --short HEAD)"
else
  echo "no code changes to commit"
fi

# --- 2. bump V + stamp, in ONE commit --------------------------------------------
# The stem is free; the NUMERIC TAIL is load-bearing (it orders cache generations for sw.js's
# collect and app.js's checkVer ranking). sw-lint.py rejects a V without digits.
cur="$(grep -o 'const V = "[^"]*"' sw.js | head -1 | sed 's/.*"\(.*\)"/\1/')"
stem="$(printf '%s' "$cur" | sed 's/[0-9]*$//')"
num="$(printf '%s' "$cur" | grep -o '[0-9]*$')"
next="${stem}$((num + 1))"
sed -i '' "s/const V = \"${cur}\"/const V = \"${next}\"/" sw.js
# Keep app.js's VER_PREFIX in agreement with the stem — sw-lint checks this too.
sed -i '' "s/^const VER_PREFIX = \"[^\"]*\";/const VER_PREFIX = \"${stem}\";/" app.js
echo "V: ${cur} -> ${next}"

./scripts/stamp-build.sh --deploy

git add -A
echo "--- sw-lint (V bumped and build.js stamped in the same commit) ---"
python3 scripts/sw-lint.py
git commit -q -m "Deploy ${next} (build $(grep -o 'sha: "[^"]*"' build.js | sed 's/.*"\(.*\)"/\1/'))"

git push -q origin main
echo
echo "pushed ${next}. Pages rebuilds in a minute or two."
echo "Open the URL ONLINE once to prime the service-worker cache before testing offline."
