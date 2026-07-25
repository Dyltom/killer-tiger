#!/usr/bin/env bash
# Rebuild the screenshot rig from a pinned copy of the tree.
#
# The repo is shared with other agents at the moment, and a half-written module
# that only runs at import time will hang the page with no error at all — which
# is indistinguishable, from the outside, from "your change broke the game". So
# the rig builds out of /tmp/kt-view, a worktree pinned at HEAD, with only the
# files this task actually touches copied over the top of it.
#
# usage: scripts/view.sh [file ...]   (defaults to the model + movement files)
set -euo pipefail
VIEW=/tmp/kt-view
PORT=5190
FILES=("$@")
if [ ${#FILES[@]} -eq 0 ]; then
  FILES=(src/config.ts src/entities/tiger.ts src/entities/human.ts)
fi

for f in "${FILES[@]}"; do cp "$f" "$VIEW/$f"; done
(cd "$VIEW" && npx vite build --logLevel error >/dev/null)

if ! lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  (cd "$VIEW/dist" && nohup python3 -m http.server "$PORT" >/tmp/kt-view.log 2>&1 &)
  sleep 1
fi
echo "serving $VIEW/dist on http://localhost:$PORT/"
