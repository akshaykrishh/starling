# Builds the README demo world in a throwaway HOME: three accounts sharing one config, a repo
# with worktrees, a few live sessions and a memory store with problems. Source it, then record
# demo.tape. Everything here is made up.
set -e
STARLING_BIN="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/dist/cli.js"
DEMO="$(cd "$(mktemp -d /tmp/starling-demo.XXXX)" && pwd -P)"
export HOME="$DEMO" GIT_AUTHOR_NAME=demo GIT_AUTHOR_EMAIL=demo@example.com GIT_COMMITTER_NAME=demo GIT_COMMITTER_EMAIL=demo@example.com
starling() { node "$STARLING_BIN" "$@"; }

shared="$HOME/.claude-shared"
mkdir -p "$shared/hooks" "$shared/skills" "$shared/agents" "$HOME/.claude" "$HOME/.claude-work" "$HOME/.claude-client"
echo '{"model":"opus"}' > "$shared/settings.json"
echo '# how we work' > "$shared/CLAUDE.md"

code="$HOME/code"; repo="$code/shop-api"
mkdir -p "$repo"; cd "$repo"
git init -q -b main; git commit -q --allow-empty -m init
git worktree add -q "$code/wt-refunds" -b refunds
git worktree add -q "$code/wt-tax-fix" -b tax-fix
git worktree add -q "$code/wt-search" -b search
git worktree add -q "$code/wt-coupons" -b coupons
(cd "$code/wt-search" && git commit -q --allow-empty -m "search: index" )
echo wip > "$code/wt-tax-fix/notes.txt"
mkdir -p "$HOME/scratch/old-load-test" "$HOME/scratch/pr-418-body"
touch -t 202601010000 "$HOME/scratch/old-load-test" "$HOME/scratch/pr-418-body"
cd "$HOME"

# Sessions on three accounts.
session() { # profile-dir id cwd branch title event
  key=$(printf %s "$3" | sed 's/[^a-zA-Z0-9]/-/g'); dir="$1/projects/$key"; mkdir -p "$dir"
  printf '{"type":"user","cwd":"%s","gitBranch":"%s"}\n{"type":"ai-title","aiTitle":"%s"}\n' "$3" "$4" "$5" > "$dir/$2.jsonl"
  printf '{"session_id":"%s","transcript_path":"%s","cwd":"%s","hook_event_name":"%s"}' "$2" "$dir/$2.jsonl" "$3" "$6" \
    | CLAUDE_PID=$$ starling hook "$6"
}
session "$HOME/.claude-work"   s1 "$code/wt-refunds" refunds "Partial refunds for split payments" Stop
session "$HOME/.claude-client" s2 "$code/wt-search"  search  "Search index rebuild"             UserPromptSubmit
session "$HOME/.claude"        s3 "$repo"            main    "Review the tax-fix PR"            UserPromptSubmit

# Memory with problems.
mem="$shared/memory/$(printf %s "$repo" | sed 's/[^a-zA-Z0-9]/-/g')"; mkdir -p "$mem"
printf -- '---\nname: test-db\ndescription: Integration tests need their own database\nmetadata:\n  type: reference\n---\nRun `scripts/test-db.sh` first.\n' > "$mem/test-db.md"
printf -- '---\nname: refunds-status\ndescription: Where the refunds work stands\nmetadata:\n  type: project\n---\nHalf done.\n' > "$mem/refunds-status.md"
printf -- '- [test-db](test-db.md) — own database\n- [refunds-status](refunds-status.md) — where it stands\n' > "$mem/MEMORY.md"
starling init >/dev/null
node -e '
const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f,"utf8"));
c.repos=[process.argv[2]];c.scratch=[process.argv[3]];
require("fs").writeFileSync(f,JSON.stringify(c,null,2));' "$HOME/.starling/config.json" "$repo" "$HOME/scratch"
starling doctor --fix >/dev/null

# Drift to find: a save that replaced the link, and a link to a link.
cp "$shared/settings.json" "$HOME/.claude-work/settings.json.tmp" && mv "$HOME/.claude-work/settings.json.tmp" "$HOME/.claude-work/settings.json"
rm "$HOME/.claude-client/CLAUDE.md" && ln -s "$HOME/.claude/CLAUDE.md" "$HOME/.claude-client/CLAUDE.md"

cd "$HOME"; set +e; clear 2>/dev/null
