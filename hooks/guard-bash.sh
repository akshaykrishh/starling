#!/bin/bash
# PreToolUse guard for Bash, for running many Claude Code sessions in parallel worktrees.
#
# 1. git stash is one stack shared by every worktree of a repo: a stash in one session can be
#    popped by another, and work quietly moves between branches. `stash list` and `stash show`
#    stay allowed.
# 2. Operations that destroy work: force-push, reset --hard, clean -f, branch -D, checkout .,
#    restore . A plain `git push` stays allowed.
# 3. Polling loops (`until/while ... sleep`, `watch -n`). Claude Code notifies the agent when a
#    background command finishes, so a polling loop only burns time and tokens, and loops left
#    behind by ended sessions keep running.
#
# Only the command text before any heredoc body is inspected, so a script that merely contains
# these words (like this file) can still be written. Set STARLING_ALLOW_POLLING=1 to skip 3.

command -v jq >/dev/null 2>&1 || exit 0

COMMAND=$(jq -r '.tool_input.command // empty')
[ -z "$COMMAND" ] && exit 0

# Drop heredoc bodies: keep each line up to and including a `<<WORD` opener, skip until WORD.
COMMAND=$(printf '%s\n' "$COMMAND" | awk '
  skipping { if ($0 == term) { skipping = 0 } ; next }
  {
    print
    if (match($0, /<<-?[[:space:]]*["\047]?[A-Za-z_][A-Za-z0-9_]*["\047]?/)) {
      t = substr($0, RSTART, RLENGTH); sub(/^<<-?[[:space:]]*/, "", t); gsub(/["\047]/, "", t)
      term = t; skipping = 1
    }
  }')

refuse() {
  printf 'BLOCKED by starling guard-bash: %s\n' "$1" >&2
  exit 2
}

if printf '%s' "$COMMAND" | grep -qE '(^|[^[:alnum:]_-])git[[:space:]]+stash'; then
  if ! printf '%s' "$COMMAND" | grep -qE '(^|[^[:alnum:]_-])git[[:space:]]+stash[[:space:]]+(list|show)([[:space:]]|$)'; then
    refuse "git stash is shared by every worktree, so another session can pop it. Commit WIP on your own branch, or use 'git show <ref>:<path>'."
  fi
fi

# Flags must be whole words: a branch named 'fix/foo-f' is not a force push.
GIT_PATTERNS=(
  'git[[:space:]]+push([[:space:]]+[^;&|]*)?[[:space:]](--force|--force-with-lease|-f)([[:space:]=]|$)'
  'git[[:space:]]+push[[:space:]]+[^;&|]*[[:space:]]\+[^[:space:]]+'
  'git[[:space:]]+reset[[:space:]]+([^;&|]*[[:space:]])?--hard'
  'git[[:space:]]+clean[[:space:]]+([^;&|]*[[:space:]])?-[a-zA-Z]*f'
  'git[[:space:]]+branch[[:space:]]+([^;&|]*[[:space:]])?-D([[:space:]]|$)'
  'git[[:space:]]+checkout[[:space:]]+\.([[:space:]]|$)'
  'git[[:space:]]+restore[[:space:]]+([^;&|]*[[:space:]])?\.([[:space:]]|$)'
)
for p in "${GIT_PATTERNS[@]}"; do
  if printf '%s' "$COMMAND" | grep -qE -- "$p"; then
    refuse "destructive git operation (pattern: $p). Use a safe alternative: a fresh branch instead of reset --hard, 'git worktree remove' without --force, a normal push."
  fi
done

[ "$STARLING_ALLOW_POLLING" = 1 ] && exit 0
if printf '%s' "$COMMAND" | grep -qE '(^|[;&|[:space:]({])(until|while)[[:space:]].*(;|[[:space:]])do([[:space:]].*)?[[:space:]]sleep[[:space:]]'; then
  refuse "polling loop. Run the command in the foreground, or in the background and wait for the completion notification. Read a finished log once instead of watching it."
fi
if printf '%s' "$COMMAND" | grep -qE '(^|[;&|[:space:]])watch[[:space:]]+-n'; then
  refuse "polling with watch. Use a foreground or background run instead."
fi

exit 0
