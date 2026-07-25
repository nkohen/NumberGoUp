#!/usr/bin/env bash
#
# Publish the web build of Number Go Up to the GitHub Pages site.
#
# Usage:
#   npm run deploy                 # build + copy + commit + push
#   npm run deploy -- "my message" # same, with a custom commit message
#
# The website repo location defaults to ~/dev/nkohen.github.io but can be
# overridden:
#   NGU_WEBSITE_REPO=/path/to/nkohen.github.io npm run deploy
#
# The game is published to the `number-go-up/` subfolder of that repo, served at
# https://nkohen.github.io/number-go-up/.
#
# Behavior:
#   - Fails fast (set -euo pipefail): a failed typecheck/build aborts before
#     anything is copied or committed, so a broken build is never published.
#   - Replaces the number-go-up/ subfolder wholesale so old hashed JS/CSS assets
#     never linger, and stages ONLY that subfolder — unrelated changes elsewhere
#     in the website repo are left untouched.
#   - No-ops cleanly (no empty commit) when the built output is unchanged.
#
# If the push is rejected, the website repo is behind its remote (e.g. edited
# elsewhere): run `git pull` in it, then re-run this script. The freshly built
# files are already staged, so re-running just finishes the commit + push.

set -euo pipefail

# --- config -----------------------------------------------------------------
GAME_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEBSITE_REPO="${NGU_WEBSITE_REPO:-$HOME/dev/nkohen.github.io}"
SUBDIR="number-go-up"
URL="https://nkohen.github.io/${SUBDIR}/"
MSG="${1:-Update Number Go Up ($(date +%Y-%m-%d\ %H:%M))}"

# --- sanity checks ----------------------------------------------------------
if [ ! -d "$WEBSITE_REPO/.git" ]; then
  echo "✗ Website repo not found at: $WEBSITE_REPO" >&2
  echo "  Set NGU_WEBSITE_REPO to its path, e.g.:" >&2
  echo "    NGU_WEBSITE_REPO=/path/to/nkohen.github.io npm run deploy" >&2
  exit 1
fi

# --- build ------------------------------------------------------------------
echo "▶ Building (typecheck + vite build)…"
cd "$GAME_REPO"
npm run build

# --- copy into the website repo (clean old hashed assets first) -------------
DEST="$WEBSITE_REPO/$SUBDIR"
echo "▶ Copying build → $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$GAME_REPO/dist/." "$DEST/"

# --- commit & push (only the game subfolder) --------------------------------
cd "$WEBSITE_REPO"
git add "$SUBDIR"

if git diff --cached --quiet -- "$SUBDIR"; then
  echo "✔ No changes to publish — the live build is already up to date."
  exit 0
fi

echo "▶ Committing: $MSG"
git commit -q -m "$MSG"

echo "▶ Pushing…"
git push

echo
echo "✅ Published. Live (after GitHub Pages rebuilds, ~30-60s) at:"
echo "   $URL"
