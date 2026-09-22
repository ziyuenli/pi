#!/usr/bin/env bash
#
# update-pi.sh — sync this Pi fork to the latest official upstream RELEASE tag
# while preserving the transcript-selection feature patch.
#
# Model:  fork = official release tag  +  transcript-selection.patch
#
# The patch is generated the first time from the feature commits and then
# re-applied on top of every newer official release. Conflicts that cannot be
# auto-resolved STOP the script and ask you (or an agent) to resolve them with
# `git mergetool` (or manually), then `git add -A && git commit`.
#
# Requires: the same remotes as a working dev checkout:
#   origin   = your fork (git@github.com:ziyuenli/pi.git)
#   upstream = official (https://github.com/earendil-works/pi.git)
#
# Usage:
#   ./update-pi.sh            update to the newest upstream release tag
#   ./update-pi.sh --check    only report whether an update is available
#   PI_TARGET=v0.86.0 ./update-pi.sh   pin an explicit target tag

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_FILE="$REPO/transcript-selection.patch"
STATE_FILE="$REPO/update-pi.state"

# Remote with official tags. If upstream is missing, fall back to origin.
UP_REMOTE=upstream
if ! git -C "$REPO" remote get-url "$UP_REMOTE" >/dev/null 2>&1; then
	UP_REMOTE=origin
fi

log() { printf '\033[1;34m[update-pi]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[update-pi]\033[0m %s\n' "$*" >&2; exit 1; }

# After a successful update, sync Pi's changelog/telemetry marker to the version
# just installed. This is user-machine config (not repo code) and is written per
# machine via the Pi config dir.
sync_last_changelog_version() {
	local version="$1"
	# Drop a leading 'v' (e.g. v0.85.1 -> 0.85.1) so it matches npm semver.
	local bare="${version#v}"
	local cfg_dir="${PI_CONFIG_DIR:-$HOME/.pi/agent}"
	local settings="$cfg_dir/settings.json"
	if [[ ! -f "$settings" ]]; then
		log "No Pi settings at $settings — skipping lastChangelogVersion update."
		return 0
	fi
	if ! node -e "
		const fs = require('fs');
		const p = process.argv[1];
		const d = JSON.parse(fs.readFileSync(p, 'utf8'));
		d.lastChangelogVersion = process.argv[2];
		fs.writeFileSync(p, JSON.stringify(d, null, 2));
	" "$settings" "$bare"; then
		log "Warning: could not update lastChangelogVersion in $settings."
		return 1
	fi
	log "Updated lastChangelogVersion -> $bare in $settings."
}



########################################
# 1. Determine the current upstream tag this fork is based on.
########################################
current_tag() {
	local saved
	saved="$(cat "$STATE_FILE" 2>/dev/null || true)"
	if [[ -n "$saved" ]]; then
		echo "$saved"
		return
	fi
	# Fallback: the tag described by HEAD, or the coding-agent version.
	git -C "$REPO" describe --tags --exact-match HEAD 2>/dev/null \
		|| git -C "$REPO" describe --tags --abbrev=0 HEAD 2>/dev/null \
		|| node -e "console.log(require('$REPO/packages/coding-agent/package.json').version)"
}

latest_upstream_tag() {
	git -C "$REPO" tag --list 'v*' --sort=-version:refname \
		| grep -v '^v0\.0\.' | head -1
}

########################################
# 2. Fetch latest state from upstream.
########################################
log "Fetching latest official tags from '$UP_REMOTE'..."
git -C "$REPO" fetch --tags "$UP_REMOTE"

TARGET="${PI_TARGET:-$(latest_upstream_tag)}"
[[ -n "$TARGET" ]] || die "Could not determine the latest upstream release tag."
CURRENT="$(current_tag)"

log "Current fork baseline: $CURRENT"
log "Target upstream tag:   $TARGET"

if [[ "$TARGET" == "$CURRENT" ]]; then
	if [[ "${1:-}" == "--check" ]]; then
		echo "up to date ($CURRENT)"
	else
		log "Already at $CURRENT — nothing to do."
	fi
	exit 0
fi

if [[ "${1:-}" == "--check" ]]; then
	echo "update available: $CURRENT -> $TARGET"
	exit 0
fi

########################################
# 3. Ensure feature patch exists.
########################################
if [[ ! -s "$PATCH_FILE" ]]; then
	log "Generating transcript-selection.patch from $CURRENT..HEAD ..."
	git -C "$REPO" diff "$CURRENT" HEAD > "$PATCH_FILE" \
		|| die "Could not generate feature patch."
fi

########################################
# 4. Reset to the clean official baseline and re-apply the feature patch.
########################################
log "Checking out latest official baseline: $TARGET ..."

# Stash any uncommitted work before we move the working tree.
if [[ -n "$(git -C "$REPO" status --porcelain)" ]]; then
	log "Stashing uncommitted changes..."
	git -C "$REPO" stash push -u -m "update-pi: pre-${TARGET}" || true
fi

# Resolve FEATURE branch name (the branch that carries the feature commits).
FEATURE_BRANCH="$(git -C "$REPO" branch --show-current)"
[[ -n "$FEATURE_BRANCH" ]] || FEATURE_BRANCH="transcript-selection-hooks"

# Create a fresh branch from the official baseline.
BASE_BRANCH="fork/${TARGET}"
if git -C "$REPO" rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1; then
	git -C "$REPO" branch -D "$BASE_BRANCH" >/dev/null 2>&1 || true
fi
git -C "$REPO" checkout -b "$BASE_BRANCH" "$TARGET" \
	|| die "Could not create $BASE_BRANCH from $TARGET."

log "Applying transcript-selection.patch onto $TARGET ..."
if ! git -C "$REPO" apply --check "$PATCH_FILE" 2>/dev/null; then
	log "Patch does not apply cleanly — trying 3-way merge..."
	if ! git -C "$REPO" apply --3way "$PATCH_FILE"; then
		cat <<'EOF'

  ⚠  The feature patch conflicts with upstream $TARGET.
  Resolve the remaining conflicts (git mergetool / edit the files), then:
      git add -A
      git commit -m "apply transcript-selection patch on $TARGET"
  After committing, run ./update-pi.sh again to complete build + push.
EOF
		die "Patch conflicts — manual resolution required."
	fi
else
	git -C "$REPO" apply "$PATCH_FILE"
fi

log "Feature patch applied."

########################################
# 5. Install deps, align model data, version, commit.
########################################
log "Installing dependencies (npm ci --ignore-scripts)..."
npm --prefix "$REPO" ci --ignore-scripts >/dev/null 2>&1 \
	|| die "npm ci failed."

# The version is already set to $TARGET by checking out the official baseline.
NEW_VERSION="$(node -e "console.log(require('$REPO/packages/coding-agent/package.json').version)")"
log "Base version after checkout: $NEW_VERSION"

# Model data (packages/ai/src/providers/data/*.json) is a build artifact and is
# NOT tracked by git (upstream gitignores it), so on a fresh clone the data
# directory is empty and must be regenerated. generate:models regenerates BOTH
# the JSON data and the .models.ts type shards from the same model sources, so
# the runtime data and the compile-time types stay in sync (avoids the
# data-vs-type drift that otherwise makes type checks fail on a fresh clone).
# It needs network access.
log "Generating model catalog (data + type shards) for $NEW_VERSION ..."
if ! npm --prefix "$REPO" run generate:models >/dev/null 2>&1; then
	log "Model gen (data + types) failed — falling back to data-only hydration."
	npm --prefix "$REPO" run hydrate:model-data >/dev/null 2>&1 \
		|| die "Model hydration failed. Check network access to the model sources."
fi

git -C "$REPO" add -A
git -C "$REPO" commit -m "feat: transcript-selection on $TARGET" \
	|| log "(nothing new to commit)"

# Remember the baseline so the next run compares against it.
echo "$TARGET" > "$STATE_FILE"

# Keep the user's Pi changelog marker accurate for this machine.
sync_last_changelog_version "$NEW_VERSION"

cat <<EOF

  ✓ Updated fork to official $TARGET.

  Branch:    $BASE_BRANCH
  Version:   $NEW_VERSION
  Installed: npm ci + model catalog refreshed.

  Next: push this branch to origin so other machines can pull it:
      git push origin "$BASE_BRANCH"

  To keep `$FEATURE_BRANCH` as the working branch, if desired:
      git switch "$FEATURE_BRANCH"
      git merge "$BASE_BRANCH" --no-edit
EOF
