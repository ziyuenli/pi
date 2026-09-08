---
name: update-pi
description: Update this Pi fork to the latest official upstream release tag while preserving the transcript-selection feature patch, then rebuild and push. Use when the user says "update pi", "sync pi", or asks to pull official upstream changes into the local source checkout.
---

# Update Pi

Bring the local Pi source fork up to the newest official release. The fork is
modeled as `official release tag + transcript-selection.patch`, so the update
takes the clean official baseline and re-applies the feature patch on top.

## What this does

1. Fetches the newest upstream release tag.
2. Confirms whether an update is actually available (compares the recorded
   baseline tag in `update-pi.state` against the newest upstream tag).
3. Rebuilds the fork from that official baseline and re-applies
   `transcript-selection.patch`.
4. Installs dependencies (`npm ci --ignore-scripts`) and refreshes the model
   catalog.
5. Commits the result and reports the branch/version, ready to push.

## Invocation

Run from the Pi source checkout:

```bash
cd ~/pi
./update-pi.sh            # update to newest official release tag
./update-pi.sh --check    # report whether an update is available (no changes)
PI_TARGET=v0.86.0 ./update-pi.sh   # pin an explicit target release tag
```

Or, from inside a Pi session, ask the agent to run it:

```text
update pi
```

The agent should run `~/pi/update-pi.sh` (or `--check` first to report status)
and surface the result.

## What the script needs

- Remotes configured:
  - `origin` = the user's fork (`git@github.com:ziyuenli/pi.git`)
  - `upstream` = official (`https://github.com/earendil-works/pi.git`)
- Network access to fetch upstream tags and refresh the model catalog.

## Behavior on conflict

The feature patch is small and centered on a handful of files. Normally it
applies cleanly onto a newer release. If it conflicts, the script uses a 3-way
merge and **stops** so a human or agent can resolve the remaining conflicts
(`git mergetool`, or edit the files), then `git add -A && git commit`. It never
silently drops the feature.

## After the update

The script prints the new branch and version. Push it so other machines can
pull the same result:

```bash
git push origin fork/<target-tag>
```

## Notes

- The script follows **release tags**, not `upstream/main`, so the fork tracks
  officially published Pi versions.
- If nothing is available (the fork is already at the newest tag), the script
  prints `up to date` and exits without changing anything.
