# Working with magpie

[magpie](https://github.com/akshaykrishh/magpie) collects the work you want agents to do and
hands it to them; starling keeps the sessions doing that work running safely. Each is complete
on its own. When both are installed they find each other with no configuration and each shows
the other's half.

## What lights up

| Where | With magpie installed |
|---|---|
| Session start | Under the stream's handoff: the magpie items queued for this repo and branch |
| `starling ls` | A QUEUE column (open items for each session's repo and branch) and, for a session whose agent has taken an item, that item's title |
| `starling handoff` | The generated state lists the open magpie items |
| `starling close` | Warns when magpie still has open items for the stream's branch |

## The contract (schema 1)

Each side only **reads** the other's JSON output. A missing binary, a non-zero exit, output that
is not JSON, or a `schema` other than 1 all mean "not installed": the feature is silently
absent, never an error. Calls time out after 2 seconds.

### starling provides

`starling ls --json [--all] [--hours N]`

```json
{ "schema": 1,
  "sessions": [
    { "id": "…", "profile": "work", "cwd": "/abs/path", "branch": "refunds",
      "title": "Partial refunds", "state": "waiting", "since": 1730000000000,
      "updated": 1730000000000, "pid": 4242, "stream": "billing-retry" } ] }
```

`state` is one of `working`, `waiting`, `idle`, `active`, `ended`. `pid` is the `claude`
process (absent when unknown). Times are epoch milliseconds.

`starling streams --json`

```json
{ "schema": 1,
  "streams": [
    { "name": "billing-retry", "cwd": "/abs/path", "profile": "work", "status": "open",
      "created": 1730000000000, "updated": 1730000000000 } ] }
```

### magpie provides

`magpie now --json [--project <dir>] [--branch <name>]`

```json
{ "schema": 1,
  "project": { "id": 3, "name": "shop-api" },
  "items": [
    { "id": 41, "title": "Retry webhook should cover partial refunds", "branch": null,
      "position": 1, "lease": { "session": "…", "pid": 5151, "at": "2026-10-21T10:00:00Z" } } ] }
```

- `--project <dir>` resolves the folder to a magpie project exactly as the MCP server does
  for its spawn directory (git remote URL, else the common git dir). An unknown project gives
  `"project": null, "items": []`.
  A folder that is not a git repository gives the same empty answer; with no `--project`,
  the answer is magpie's Inbox.
- `--branch <name>` keeps items whose `branch` is null or equal to `name`.
- `title` is the first line of the item; `lease` is null when nobody has taken it, and its
  `pid` is null when it was not recorded.
- `position` is the item's 1-based rank in the project's whole Now queue; it does not
  renumber when `--branch` filters items out.
- `--json` is required on both magpie commands. Timestamps are RFC 3339 (magpie writes them
  with sub-second precision).
- Reads never write: no database or folder is created when none exists. A read that meets a
  write in progress can wait on SQLite's busy timeout, longer than starling's 2 seconds;
  starling then treats magpie as absent for that one call.

`magpie sessions --json [--live]`

```json
{ "schema": 1,
  "sessions": [
    { "id": "…", "client": "claude-code", "pid": 5151,
      "project": { "id": 3, "name": "shop-api" }, "branch": "refunds",
      "started_at": "2026-10-21T09:58:00Z", "ended_at": null,
      "leased": { "id": 41, "title": "Retry webhook should cover partial refunds" } } ] }
```

`--live` keeps sessions with `ended_at` null. `pid` is magpie's MCP server process.

### Matching sessions

magpie's MCP server is a child of the `claude` process. starling records the `claude` pid, so a
magpie session belongs to the starling session whose pid is the parent of magpie's `pid`
(`ps -o ppid= -p <pid>`). Same machine only; no ids are exchanged.
