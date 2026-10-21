// starling reading magpie through the schema-1 contract (docs/integration.md), with a fake magpie.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** A fake magpie (a shell script, so it starts fast) answering `now` and `sessions` from files. */
function fakeMagpie(dir, answers) {
  writeFileSync(join(dir, "now.json"), JSON.stringify(answers.now ?? {}));
  writeFileSync(join(dir, "sessions.json"), JSON.stringify(answers.sessions ?? {}));
  const bin = join(dir, "magpie");
  writeFileSync(bin, answers.fail ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\ncat "${dir}/$1.json"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

function world(answers) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "starling-magpie-")));
  const repo = join(home, "shop-api");
  mkdirSync(join(home, ".claude-shared"), { recursive: true });
  mkdirSync(join(home, ".claude"));
  mkdirSync(repo);
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "refunds");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const env = { ...process.env, HOME: home, STARLING_MAGPIE_TIMEOUT_MS: "15000" };
  if (answers) env.STARLING_MAGPIE = fakeMagpie(home, answers);
  else env.STARLING_MAGPIE = join(home, "no-such-magpie");
  const run = (args, extra = {}) => spawnSync("node", [CLI, ...args], { encoding: "utf8", ...extra, env: { ...env, ...extra.env } });
  run(["init"]);
  return { home, repo, run };
}

const queue = (lease = null) => ({
  schema: 1,
  project: { id: 3, name: "shop-api" },
  items: [
    { id: 41, title: "Retry webhook should cover partial refunds", branch: null, position: 1, lease },
    { id: 42, title: "Add refund reason codes", branch: "refunds", position: 2, lease: null },
  ],
});

const startSession = (run, repo, pid = process.pid) =>
  run(["hook", "SessionStart"], {
    input: JSON.stringify({ session_id: "s1", cwd: repo, hook_event_name: "SessionStart" }),
    env: { CLAUDE_PID: String(pid) },
  });

test("session start lists what magpie has queued for the repo and branch", () => {
  const { repo, run } = world({ now: queue(), sessions: { schema: 1, sessions: [] } });
  const out = startSession(run, repo).stdout;
  assert.match(out, /magpie: 2 queued for shop-api on `refunds` \(2 not taken\)/);
  assert.match(out, /#41 Retry webhook should cover partial refunds/);
});

test("ls shows the queue and what a session has taken, matched through the parent pid", async () => {
  // A child of this test process stands in for magpie's MCP server; this process is "claude".
  const server = spawn("sleep", ["30"]);
  try {
    const lease = { session: "m1", pid: server.pid, at: "2026-10-21T10:00:00Z" };
    const { repo, run } = world({
      now: queue(lease),
      sessions: { schema: 1, sessions: [{ id: "m1", pid: server.pid, leased: { id: 41, title: "Retry webhook should cover partial refunds" } }] },
    });
    startSession(run, repo);
    run(["hook", "UserPromptSubmit"], { input: JSON.stringify({ session_id: "s1", cwd: repo, hook_event_name: "UserPromptSubmit" }), env: { CLAUDE_PID: String(process.pid) } });
    const out = run(["ls"]).stdout;
    assert.match(out, /QUEUE/);
    assert.match(out, /working .* 1 +▸ Retry webhook should cover partial refunds/);
  } finally {
    server.kill();
  }
});

test("handoff includes the queue and close warns about open items", () => {
  const { home, repo, run } = world({ now: queue(), sessions: { schema: 1, sessions: [] } });
  run(["handoff", "billing-retry"], { cwd: repo });
  const handoff = readFileSync(join(home, ".starling", "handoffs", "billing-retry.md"), "utf8");
  assert.match(handoff, /magpie: 2 queued for shop-api on `refunds`/);
  assert.match(run(["close", "billing-retry"]).stdout, /magpie still has 2 open item\(s\)/);
});

test("without magpie, or with a broken or newer one, nothing changes", () => {
  for (const answers of [undefined, { fail: true }, { now: { ...queue(), schema: 2 }, sessions: { schema: 2, sessions: [] } }]) {
    const { repo, run } = world(answers);
    assert.equal(startSession(run, repo).stdout, "");
    assert.doesNotMatch(run(["ls"]).stdout, /QUEUE/);
  }
});

test("ls --json and streams --json follow schema 1", () => {
  const { repo, run } = world();
  startSession(run, repo);
  const ls = JSON.parse(run(["ls", "--json"]).stdout);
  assert.equal(ls.schema, 1);
  assert.deepEqual(Object.keys(ls.sessions[0]).sort(), ["branch", "cwd", "id", "pid", "profile", "since", "state", "updated"].sort());
  run(["handoff", "billing-retry"], { cwd: repo });
  const streams = JSON.parse(run(["streams", "--json"]).stdout);
  assert.equal(streams.schema, 1);
  assert.equal(streams.streams[0].name, "billing-retry");
  assert.equal(streams.streams[0].cwd, repo);
});
