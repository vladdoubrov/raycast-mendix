#!/usr/bin/env bash
#
# mx-postclone.sh — make a plain `git clone` of a Mendix Team Server app look
# like one made with Studio Pro's "Download from Version Control Server".
#
# Usage (Git Bash):
#   git clone https://git.api.mendix.com/<AppID>.git MyApp
#   mx-postclone.sh MyApp              # or: cd MyApp && mx-postclone.sh
#   mx-postclone.sh MyApp --dry-run    # show what would change, change nothing
#
# Run it with the app CLOSED in Studio Pro. Safe to run more than once.
#
# What Studio Pro does on download that a plain clone does not:
#
#   1. [mendix] sprintr-project-id = <AppID>
#      The marker Studio Pro uses to recognise a Team Server app. Without it,
#      the app shows up as "Private server": no cloud deploy, no package
#      builds, no Portal integration.
#
#   2. core.autocrlf = false + a one-time "line-ending reset"
#      Git for Windows defaults autocrlf to true, so every LF file in the repo
#      is checked out as CRLF. Studio Pro turns autocrlf off and re-checks those
#      files out exactly as stored, then records [mendix] lineEndingResetDone.
#
#   3. Fetch all branches (+refs/heads/*:refs/remotes/origin/*)
#      `git clone --single-branch` / `-b` restricts this, and Studio Pro's
#      branch-line list needs all of them.
#
#   4. [notes] rewriteRef = refs/notes/mx_metadata (+ rewrite.rebase, overwrite)
#      Studio Pro keeps per-commit metadata (changed units, Modeler version,
#      branch) in git notes. This keeps a note attached when a local commit is
#      amended or rebased.
#
#   5. Fetch refs/notes/mx_metadata
#      A clone does not fetch notes. Without them the history shows "(unknown)"
#      for every commit, and checking the version of a revision does not work.
#
#   6. core.longpaths = true
#      Mendix projects (javasource, node_modules in widgets) easily exceed
#      Windows' 260-character path limit.

set -euo pipefail

DRY_RUN=0
REPO="."
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    -h|--help)    sed -n '2,13p' "$0"; exit 0 ;;
    *)            REPO="$arg" ;;
  esac
done

cd "$REPO"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not a git repository: $REPO" >&2; exit 1; }
cd "$(git rev-parse --show-toplevel)"

# Print a command; run it unless this is a dry run.
run() {
  echo "  + $*"
  [ "$DRY_RUN" -eq 1 ] || "$@"
}

# Studio Pro holds <App>.mpr.lock while the app is open. Rewriting files under
# it would confuse its change tracking.
if ls ./*.mpr.lock >/dev/null 2>&1 && [ "$DRY_RUN" -eq 0 ]; then
  echo "The app is open in Studio Pro (*.mpr.lock exists). Close it first." >&2
  exit 1
fi
ls ./*.mpr >/dev/null 2>&1 || echo "Warning: no .mpr in $(pwd) — is this a Mendix app?" >&2

# --- 1. Team Server project id -------------------------------------------------
# The AppID is the UUID in the Team Server URL: https://git.api.mendix.com/<AppID>.git
url="$(git remote get-url origin)"
app_id="$(printf '%s' "$url" | grep -oiE 'git\.api\.mendix\.com/[0-9a-f-]{36}' | cut -d/ -f2 || true)"
echo "1. Team Server project id"
if [ -n "$app_id" ]; then
  # Studio Pro uses Uri.IsBaseOf to select the app for temporary Git credentials.
  # Without the trailing slash, it can match another app on the same host.
  if [[ "$url" != */ ]]; then
    run git remote set-url origin "$url/"
  fi
  run git config mendix.sprintr-project-id "$app_id"
else
  echo "  origin ($url) is not a Team Server URL; skipped (Studio Pro will call this a private server)."
fi

# --- 6. Long paths (do this before any checkout) ----------------------------------
echo "6. Long paths"
run git config core.longpaths true

# --- 4. Keep notes attached when rewriting local commits -------------------------
echo "4. Notes rewrite config"
run git config notes.rewriteRef refs/notes/mx_metadata
run git config notes.rewriteMode overwrite
run git config notes.rewrite.rebase true

# --- 3. Fetch all branches ------------------------------------------------------
echo "3. Fetch refspec: all branches"
run git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'

# --- 2. Line endings ------------------------------------------------------------
echo "2. Line endings"
if [ "$(git config --bool mendix.lineEndingResetDone || echo false)" = "true" ] \
   && [ "$(git config --bool core.autocrlf || echo false)" = "false" ]; then
  echo "  already done."
else
  # Files with real changes against HEAD are left alone. While autocrlf is
  # still on, a file that only differs by CRLF does not show up here.
  mapfile -d '' changed < <(git -c core.safecrlf=false diff --name-only -z --no-renames HEAD)
  declare -A skip=()
  for p in "${changed[@]}"; do skip["$p"]=1; done

  # Files stored as LF but checked out as CRLF: the ones autocrlf converted.
  # `git ls-files --eol` prints "i/<index> w/<worktree> attr/<attr>\t<path>".
  reset_list="$(mktemp)"
  count=0
  while IFS= read -r -d '' rec; do
    info="${rec%%$'\t'*}"; path="${rec#*$'\t'}"
    read -r i w _ <<< "$info"
    if [ "$i" = "i/lf" ] && [ "$w" = "w/crlf" ] && [ -z "${skip[$path]+x}" ]; then
      printf '%s\0' "$path" >> "$reset_list"
      count=$((count + 1))
    fi
  done < <(git ls-files --eol -z)
  echo "  $count file(s) checked out with CRLF that are LF in the repo; ${#changed[@]} changed file(s) skipped."

  run git config core.autocrlf false
  if [ "$count" -gt 0 ]; then
    # Git considers these files up to date (same stat info), so a plain
    # checkout would skip them: remove them, then restore them from the index.
    # Literal pathspecs so names with * or ? are not treated as globs.
    echo "  + rm + git checkout -- <$count files>"
    if [ "$DRY_RUN" -eq 0 ]; then
      xargs -0 rm -f -- < "$reset_list"
      GIT_LITERAL_PATHSPECS=1 git checkout --pathspec-from-file="$reset_list" --pathspec-file-nul --
    fi
  fi
  rm -f "$reset_list"
  run git config mendix.lineEndingResetDone True
fi

# --- 3 + 5. Fetch branches and Studio Pro's commit metadata ------------------------
echo "3/5. Fetch all branches and refs/notes/mx_metadata (can take a few minutes)"
run git fetch origin
run git fetch origin '+refs/notes/mx_metadata:refs/notes/mx_metadata'

# --- Checks ----------------------------------------------------------------------
echo
echo "Checks:"
branch="$(git symbolic-ref --short -q HEAD || echo '(detached)')"
if git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' >/dev/null 2>&1; then
  echo "  branch $branch tracks $(git rev-parse --abbrev-ref '@{upstream}')"
else
  echo "  WARNING: branch $branch has no upstream. Studio Pro expects branches to exist on"
  echo "  Team Server: create it there (Manage Branch Lines) or 'git push -u origin $branch'."
fi
if [ "$DRY_RUN" -eq 0 ]; then
  echo "  git status (should only list changes you made yourself):"
  git status --short | sed 's/^/    /' | head -20
fi
echo
[ "$DRY_RUN" -eq 1 ] && echo "Dry run: nothing was changed." || echo "Done. Open the .mpr in Studio Pro (Open App > Locally on disk)."
