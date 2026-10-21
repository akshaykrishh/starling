# starling

**Keep many Claude Code sessions, accounts and worktrees moving as one flock.**

<!-- TODO: 30-second GIF of `starling hygiene` → `starling gc` → `starling doctor --fix` on a demo repo -->

A starling murmuration is thousands of birds turning together without a collision. Running
Claude Code at that kind of scale (several accounts, dozens of worktrees, ten projects)
breaks in quiet ways:

- **Your shared config forks without telling you.** If each account's `settings.json` is a
  symlink to one shared file, Claude Code's atomic save (write a temp file, rename it over the
  target) replaces the symlink with a plain copy. From then on that account drifts on its own.
- **`git stash` is shared by every worktree.** A stash made in one session can be popped by
  another, and work moves silently between branches.
- **Memory silts up.** Every note becomes a new memory file, and only the first part of a long
  index is ever loaded.
- **The yard fills with leftovers.** Merged worktrees, scratch folders, handoff files and
  polling loops from sessions that ended hours ago.

starling is a small CLI and a Claude Code plugin that keeps all of this in shape.

## Install

```sh
npm install -g @akshaykrishh/starling   # the CLI
claude plugin marketplace add akshaykrishh/claude-plugins
claude plugin install starling@akshaykrishh   # the hooks
```

## Use

```sh
starling init                 # finds ~/.claude and every ~/.claude-<name>, writes ~/.starling/config.json
starling profile add client   # a new account that shares settings, CLAUDE.md, hooks, skills, agents, memory
starling run client           # claude, signed in as that profile
starling doctor --fix         # relink anything that drifted; report what needs a person
starling hygiene              # one line: links · memory · worktrees · scratch · handoffs
starling gc                   # dry run; --apply removes merged worktrees and trashes stale scratch
```

```
$ starling hygiene
links: ok across 4 profiles · memory! 2/11 stores over limit (app=77f/77l) · worktrees! 74 (2 merged and removable, 20 stale unmerged) · scratch! 27 folders untouched 7+ days · handoffs: 6 (0 older than 7d)
```

### What it never does

- **Overwrite a change.** A profile file that differs from the shared copy is reported, not replaced.
- **Remove a dirty worktree.** `gc` removes a worktree only when it is clean *and* merged
  (its commit is on the default branch, or its branch was deleted on the remote after a
  squash merge), and it uses `git worktree remove`, which refuses dirty trees on its own.
- **Delete scratch.** It moves it to `~/.starling/trash/<time>/`.

## The plugin's hooks

| Hook | What it does |
|---|---|
| `SessionStart` | Runs `starling hook session-start`: relinks config an atomic save replaced (same content), moves memory only one profile has into the shared store, and tells the session about anything that really diverged. Silent when healthy. |
| `PreToolUse: Bash` | Blocks `git stash` (except `list`/`show`), force-push, `reset --hard`, `clean -f`, `branch -D`, `checkout .`, `restore .`, and polling loops (`until/while … sleep`, `watch -n`). Set `STARLING_ALLOW_POLLING=1` to allow loops. |

The guard needs `jq` (preinstalled on recent macOS); without it, it lets everything through.

## Config

`~/.starling/config.json` (or `STARLING_CONFIG`):

```json
{
  "shared": "~/.claude-shared",
  "profiles": { "default": "~/.claude", "work": "~/.claude-work" },
  "link": ["settings.json", "CLAUDE.md", "hooks", "skills", "agents"],
  "shareMemory": true,
  "repos": ["~/code/app"],
  "scratch": ["~/.agent-scratch"],
  "handoffs": "~/.agent-scratch/handoffs",
  "staleDays": 7,
  "limits": { "memoryFiles": 30, "memoryIndexLines": 50 }
}
```

## On multiple accounts

Profiles are for keeping accounts you legitimately hold separate (work, a client's org,
personal) while sharing one setup. starling does not rotate accounts to get around usage
limits, and won't.

## Roadmap

- `starling ls`: every live session across profiles: project, worktree, profile, and whether it is **waiting on you**
- streams: `starling handoff` / `starling resume <stream>`, so a piece of work survives a session, an account switch or a worktree
- memory lint: duplicates, and memories naming files or flags that no longer exist
- an inbox: queue a task for any stream from anywhere (from [magpie](https://github.com/akshaykrishh/magpie))

## Development

```sh
npm install && npm test   # builds, then runs the end-to-end tests in a throwaway HOME
npm run test:hooks        # guard regression cases
```

MIT licensed.
