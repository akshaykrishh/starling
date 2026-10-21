# starling

[![ci](https://github.com/akshaykrishh/starling/actions/workflows/ci.yml/badge.svg)](https://github.com/akshaykrishh/starling/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@akshaykrishh/starling)](https://www.npmjs.com/package/@akshaykrishh/starling)

**Keep many Claude Code sessions, accounts and worktrees moving as one flock.**

<!-- TODO: 30-second GIF of `starling hygiene` → `starling gc` → `starling doctor --fix` on a demo repo -->

A starling murmuration is thousands of birds turning together without a collision. Running
Claude Code at that kind of scale (several accounts, dozens of worktrees, ten projects)
breaks in quiet ways:

- **Your shared config forks without telling you.** Claude Code's atomic save (write a temp
  file, rename it over the target) follows a symlink only one hop. If an account's
  `settings.json` reaches the shared file through two links, the save replaces the middle link
  with a plain copy, and from then on that account drifts on its own
  ([anthropics/claude-code#78162](https://github.com/anthropics/claude-code/issues/78162)).
- **`git stash` is shared by every worktree.** A stash made in one session can be popped by
  another, and work moves silently between branches.
- **Memory silts up.** Every note becomes a new memory file, and only the first part of a long
  index is ever loaded.
- **The yard fills with leftovers.** Merged worktrees, scratch folders, handoff files and
  polling loops from sessions that ended hours ago.

- **You lose track.** Which of twelve sessions is waiting on you? Which account was the
  billing fix on, and where did it stop when the usage limit hit?

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

### See every session at once

```
$ starling ls
STATE    FOR  PROFILE   FOLDER     BRANCH         STREAM  TITLE
WAITING  4m   work      app-retry  feat/retry     retry   Retry failed webhooks with backoff
WAITING  1m   client    portal     main                   Fix invoice PDF fonts
working  now  work      app        fix/gst-round          GST rounding on credit notes
idle     27m  personal  blog       main                   Draft post on worktree guards

2 waiting on you.
```

Every session on every profile, the ones waiting on you first. With the plugin installed,
hooks record when a turn ends or Claude asks for permission, and a session whose process
died shows as ended. Without them, starling still finds sessions from their transcripts.

### Streams: work that outlives a session

A stream is one piece of work: a folder, a handoff and every session (on any profile)
that worked on it.

```sh
starling handoff retry                   # in the work's folder; the starling:handoff skill writes the notes
starling resume retry --profile client   # a fresh session, any account, handoff loaded at start
starling streams                         # what is open
starling close retry                     # done; the handoff goes to the trash
```

The handoff has two parts: **Notes** that the session writes (goal, done, next, decisions,
traps) and a **State** section starling regenerates from git each time (branch, commits
ahead, uncommitted files, the PR), so the next session never starts from a stale summary.

```
$ starling hygiene
links: ok across 4 profiles · memory! 2/11 stores over limit (app=77f/77l) · worktrees! 74 (2 merged and removable, 20 stale unmerged) · scratch! 27 folders untouched 7+ days · handoffs: 6 (0 older than 7d)
```

### Keep memory worth loading

Claude Code loads only the start of a project's `MEMORY.md`, so memory that grows without
pruning quietly stops working. `starling memory lint [project]` reports, without changing
anything:

```
my-app (59 files, 59 index lines)
  over-limit 59 files (limit 30)
  status     review-queue-state.md: "state" in the name: work in progress belongs in an issue, PR or handoff
  stale-path dev-setup.md: names scripts/demo.sh, which no longer exists
  overlap    auth-plan.md: may cover the same ground as permissions-plan.md; merge them if so
```

It also reports memories missing from the index (they never load), index entries whose file
is gone, and files without the `name`/`description` header. Paths are checked against the
project folder recorded in the project's own transcripts.

### What it never does

- **Overwrite a change.** A profile file that differs from the shared copy is reported, not replaced.
- **Remove a dirty worktree.** `gc` removes a worktree only when it is clean *and* merged
  (its commit is on the default branch, or its branch was deleted on the remote after a
  squash merge), and it uses `git worktree remove`, which refuses dirty trees on its own.
- **Delete scratch.** It moves it to `~/.starling/trash/<time>/`.

## The plugin's hooks

| Hook | What it does |
|---|---|
| `SessionStart` | Relinks config an atomic save replaced (same content), moves memory only one profile has into the shared store, and tells the session about anything that really diverged, and loads the stream's handoff for `starling resume`. Silent when healthy. |
| `UserPromptSubmit`, `Stop`, `Notification`, `SessionEnd` | Record each session's state for `starling ls` (working, waiting on you, ended). |
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

- an inbox: queue a task for any stream from anywhere (from [magpie](https://github.com/akshaykrishh/magpie))

## Development

```sh
npm install && npm test   # builds, then runs the end-to-end tests in a throwaway HOME
npm run test:hooks        # guard regression cases
```

Releases: bump `version` in `package.json` and `.claude-plugin/plugin.json`, commit, then
`git tag v<version> && git push --tags`. The release workflow is meant to publish to npm with
provenance, but npm currently rejects trusted publishing from repos created after July 2026
([npm/cli#9969](https://github.com/npm/cli/issues/9969)). Until that is fixed, publish by hand
with `npm publish` from an interactive terminal (passkey approval).

MIT licensed.
