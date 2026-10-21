// End-to-end tests: each test gets a throwaway HOME with fake Claude profiles and real git repos.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "starling-"));
  const shared = join(home, ".claude-shared");
  mkdirSync(join(shared, "skills"), { recursive: true });
  writeFileSync(join(shared, "settings.json"), '{"model":"opus"}\n');
  writeFileSync(join(shared, "CLAUDE.md"), "# rules\n");
  for (const p of [".claude", ".claude-work"]) mkdirSync(join(home, p));
  const run = (...args) => spawnSync("node", [CLI, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  return { home, shared, run };
}

const isLinkTo = (p, target) => lstatSync(p).isSymbolicLink() && readlinkSync(p) === target;

test("init detects profiles and skips the shared folder", () => {
  const { run } = sandbox();
  const r = run("init");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 profiles: default, work/);
});

test("doctor --fix links missing entries in every profile", () => {
  const { home, shared, run } = sandbox();
  run("init");
  assert.equal(run("doctor").status, 1);
  const r = run("doctor", "--fix");
  assert.equal(r.status, 0, r.stdout);
  for (const p of [".claude", ".claude-work"]) {
    assert.ok(isLinkTo(join(home, p, "settings.json"), join(shared, "settings.json")));
    assert.ok(isLinkTo(join(home, p, "skills"), join(shared, "skills")));
  }
});

test("an atomic save that replaced the link with identical content is relinked", () => {
  const { home, shared, run } = sandbox();
  run("init");
  run("doctor", "--fix");
  const p = join(home, ".claude-work", "settings.json");
  // What Claude Code does when it saves a setting: write a temp file, rename it over the link.
  writeFileSync(p + ".tmp", '{"model":"opus"}\n');
  renameSync(p + ".tmp", p);
  assert.ok(!lstatSync(p).isSymbolicLink());
  const r = run("hook", "session-start");
  assert.equal(r.stdout, "");
  assert.ok(isLinkTo(p, join(shared, "settings.json")));
});

test("a changed copy is reported, never overwritten", () => {
  const { home, run } = sandbox();
  run("init");
  run("doctor", "--fix");
  const p = join(home, ".claude-work", "settings.json");
  writeFileSync(p + ".tmp", '{"model":"sonnet"}\n');
  renameSync(p + ".tmp", p);
  const r = run("hook", "session-start");
  assert.match(r.stdout, /drifted[\s\S]*changed in this profile only/);
  assert.ok(!lstatSync(p).isSymbolicLink());
});

test("memory only one profile has moves into the shared store", () => {
  const { home, shared, run } = sandbox();
  run("init");
  const mem = join(home, ".claude-work", "projects", "-repo", "memory");
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, "user.md"), "fact\n");
  run("doctor", "--fix");
  assert.ok(isLinkTo(mem, join(shared, "memory", "-repo")));
  assert.ok(existsSync(join(shared, "memory", "-repo", "user.md")));
});

test("profile add creates a linked profile", () => {
  const { home, shared, run } = sandbox();
  run("init");
  const r = run("profile", "add", "client");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(isLinkTo(join(home, ".claude-client", "CLAUDE.md"), join(shared, "CLAUDE.md")));
});

test("gc removes merged clean worktrees, keeps dirty ones, trashes stale scratch", () => {
  const { home, run } = sandbox();
  const repo = join(home, "repo");
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  mkdirSync(repo);
  g("init", "-q", "-b", "main");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  g("worktree", "add", "-q", join(home, "wt-merged"), "-b", "merged");
  g("worktree", "add", "-q", join(home, "wt-dirty"), "-b", "dirty");
  writeFileSync(join(home, "wt-dirty", "wip.txt"), "x");

  const scratch = join(home, "scratch");
  mkdirSync(join(scratch, "old-task"), { recursive: true });
  mkdirSync(join(scratch, "handoffs"), { recursive: true });
  const old = new Date(Date.now() - 30 * 86_400_000);
  utimesSync(join(scratch, "old-task"), old, old);
  utimesSync(join(scratch, "handoffs"), old, old);

  run("init");
  const cfgPath = join(home, ".starling", "config.json");
  const cfg = JSON.parse(execFileSync("cat", [cfgPath], { encoding: "utf8" }));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, repos: [repo], scratch: [scratch] }));

  const dry = run("gc");
  assert.match(dry.stdout, /remove  worktree .*wt-merged: already in main/);
  assert.match(dry.stdout, /keep    worktree .*wt-dirty: already in main, but has uncommitted changes/);
  assert.match(dry.stdout, /trash   scratch .*old-task/);
  assert.doesNotMatch(dry.stdout, /handoffs/);
  assert.ok(existsSync(join(home, "wt-merged")));

  run("gc", "--apply");
  assert.ok(!existsSync(join(home, "wt-merged")));
  assert.ok(existsSync(join(home, "wt-dirty", "wip.txt")));
  assert.ok(!existsSync(join(scratch, "old-task")));
  const trash = join(home, ".starling", "trash");
  assert.ok(readdirSync(join(trash, readdirSync(trash)[0])).includes("old-task"));
});

test("hygiene reports one line", () => {
  const { run } = sandbox();
  run("init");
  const r = run("hygiene");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^links! \d+ need attention .* · memory: 0 stores within limits$/);
});

test("the session-start hook never fails, even without a config", () => {
  const { run } = sandbox();
  const r = run("hook", "session-start");
  assert.equal(r.status, 0);
});
