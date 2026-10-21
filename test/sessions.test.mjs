// Session board and streams, end to end in a throwaway HOME.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "starling-"));
  mkdirSync(join(home, ".claude-shared"));
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".claude-work"));
  const run = (args, { input, cwd, env = {} } = {}) =>
    spawnSync("node", [CLI, ...args], {
      env: { ...process.env, HOME: home, CLAUDE_PID: "", CLAUDE_CODE_SESSION_ID: "", STARLING_STREAM: "", ...env },
      encoding: "utf8",
      input,
      cwd,
    });
  run(["init"]);
  const repo = join(home, "app");
  mkdirSync(repo);
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  g("checkout", "-q", "-b", "feat/retry");
  return { home, repo, run };
}

const hookInput = (home, id, event, cwd) =>
  JSON.stringify({ session_id: id, hook_event_name: event, cwd, transcript_path: join(home, ".claude-work", "projects", "-app", `${id}.jsonl`) });

test("hook events drive the board, and sessions waiting on you come first", () => {
  const { home, repo, run } = sandbox();
  const live = { env: { CLAUDE_PID: String(process.pid) } };
  run(["hook", "SessionStart"], { input: hookInput(home, "aaa", "SessionStart", repo), ...live });
  run(["hook", "UserPromptSubmit"], { input: hookInput(home, "aaa", "UserPromptSubmit", repo), ...live });
  run(["hook", "SessionStart"], { input: hookInput(home, "bbb", "SessionStart", repo), ...live });
  run(["hook", "UserPromptSubmit"], { input: hookInput(home, "bbb", "UserPromptSubmit", repo), ...live });
  run(["hook", "Stop"], { input: hookInput(home, "bbb", "Stop", repo), ...live });

  const out = run(["ls"]).stdout.split("\n");
  assert.match(out[0], /^STATE\s+FOR\s+PROFILE/);
  assert.match(out[1], /^WAITING .* work .* app .* feat\/retry/);
  assert.match(out[2], /^working /);
  assert.match(out.join("\n"), /1 waiting on you/);
});

test("a session whose process died shows as ended, not working", () => {
  const { home, repo, run } = sandbox();
  const dead = { env: { CLAUDE_PID: "999999" } };
  run(["hook", "UserPromptSubmit"], { input: hookInput(home, "ccc", "UserPromptSubmit", repo), ...dead });
  assert.match(run(["ls"]).stdout, /No sessions/);
  assert.match(run(["ls", "--all"]).stdout, /^ended /m);
});

test("sessions without hooks are found from their transcripts, with Claude's title", () => {
  const { home, run } = sandbox();
  const dir = join(home, ".claude", "projects", "-app");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "ddd.jsonl"),
    [
      { type: "user", cwd: "/work/app", gitBranch: "fix/x", message: { content: "hi" } },
      { type: "ai-title", aiTitle: "Fix the retry loop" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  assert.match(run(["ls"]).stdout, /^active .* default .* app .* fix\/x .* Fix the retry loop/m);
});

test("handoff writes notes and live git state, and keeps notes on refresh", () => {
  const { home, repo, run } = sandbox();
  writeFileSync(join(repo, "wip.ts"), "x");
  const r = run(["handoff", "retry", "--notes-file", "-"], { input: "**Goal:** retries survive restarts.\n", cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  const file = join(home, ".starling", "handoffs", "retry.md");
  let text = readFileSync(file, "utf8");
  assert.match(text, /^# Stream: retry/);
  assert.match(text, /\*\*Goal:\*\* retries survive restarts\./);
  assert.match(text, /Branch: `feat\/retry`, 0 commit\(s\) ahead of `main`/);
  assert.match(text, /Uncommitted: 1 file/);

  run(["handoff", "retry"], { cwd: repo });
  text = readFileSync(file, "utf8");
  assert.match(text, /\*\*Goal:\*\* retries survive restarts\./);
  assert.match(run(["streams"]).stdout, /^retry .*\/app {2}\(0 session\(s\)\)/m);
});

test("a session started for a stream gets its handoff and joins the stream", () => {
  const { home, repo, run } = sandbox();
  run(["handoff", "retry", "--notes-file", "-"], { input: "**Next:** add jitter.\n", cwd: repo });
  const r = run(["hook", "SessionStart"], { input: hookInput(home, "eee", "SessionStart", repo), env: { STARLING_STREAM: "retry" } });
  assert.match(r.stdout, /continues the "retry" stream[\s\S]*add jitter/);
  const stream = JSON.parse(readFileSync(join(home, ".starling", "streams", "retry.json"), "utf8"));
  assert.deepEqual(stream.sessions, ["eee"]);
  assert.equal(stream.profile, "work");
});

test("a session in a stream's folder joins it without being told", () => {
  const { home, repo, run } = sandbox();
  run(["handoff", "retry"], { cwd: repo });
  run(["hook", "SessionStart"], { input: hookInput(home, "fff", "SessionStart", repo) });
  assert.match(run(["ls"]).stdout, /retry/);
});

test("close moves the handoff to the trash", () => {
  const { home, repo, run } = sandbox();
  run(["handoff", "retry"], { cwd: repo });
  run(["close", "retry"]);
  assert.ok(!existsSync(join(home, ".starling", "handoffs", "retry.md")));
  const trash = join(home, ".starling", "trash");
  assert.ok(readdirSync(join(trash, readdirSync(trash)[0])).includes("retry.md"));
  assert.match(run(["streams"]).stdout, /No open streams/);
});

test("stream names are checked", () => {
  const { run } = sandbox();
  const r = run(["handoff", "../escape"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stream name is letters/);
});
