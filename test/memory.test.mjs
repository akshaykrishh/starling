// memory lint: a throwaway HOME with one shared memory store and a transcript naming the project folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const mem = (name, description, body = "") => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project\n---\n\n${body}\n`;

function sandbox(memories, index) {
  const home = mkdtempSync(join(tmpdir(), "starling-mem-"));
  const repo = join(home, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "kept.ts"), "");
  const key = repo.replace(/[^a-zA-Z0-9]/g, "-");
  const store = join(home, ".claude-shared", "memory", key);
  mkdirSync(store, { recursive: true });
  for (const [f, text] of Object.entries(memories)) writeFileSync(join(store, f), text);
  writeFileSync(join(store, "MEMORY.md"), index ?? Object.keys(memories).map((f) => `- [${f}](${f}) — x`).join("\n") + "\n");
  const transcripts = join(home, ".claude", "projects", key);
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(join(transcripts, "s.jsonl"), JSON.stringify({ type: "user", cwd: repo }) + "\n");
  const run = (...args) => spawnSync("node", [CLI, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  run("init");
  return run;
}

test("a clean store passes", () => {
  const run = sandbox({ "build.md": mem("build", "How the build runs", "See `src/kept.ts`.") });
  const r = run("memory", "lint");
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /Memory is clean/);
});

test("a path that no longer exists in the project is reported; routes and missing folders are not", () => {
  const run = sandbox({ "build.md": mem("build", "How the build runs", "`src/gone.ts`, `src/kept.ts`, `/api/orders`, `lib/x.ts`") });
  const r = run("memory", "lint");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /stale-path build\.md: names src\/gone\.ts/);
  assert.doesNotMatch(r.stdout, /kept\.ts|api\/orders|lib\/x/);
});

test("unindexed, dangling and headerless memories are reported", () => {
  const run = sandbox({ "a.md": mem("a", "alpha fact"), "b.md": "no header\n" }, "- [a](a.md)\n- [c](c.md)\n");
  const out = run("memory", "lint").stdout;
  assert.match(out, /unindexed  b\.md/);
  assert.match(out, /no-header  b\.md/);
  assert.match(out, /dangling   MEMORY\.md: lists c\.md/);
});

test("status-style names are flagged, topics that merely contain the word are not", () => {
  const run = sandbox({
    "corpus-state.md": mem("corpus-state", "where the corpus work stands"),
    "release-pending.md": mem("release-pending", "what the release waits on"),
    "empty-state-ui.md": mem("empty-state-ui", "what screens show before data exists"),
    "no-status-guard.md": mem("no-status-guard", "accept must check the suggestion is still open"),
  });
  const out = run("memory", "lint").stdout;
  assert.match(out, /status     corpus-state\.md/);
  assert.match(out, /status     release-pending\.md/);
  assert.doesNotMatch(out, /status     (empty-state-ui|no-status-guard)/);
});

test("near-duplicate memories and limits are reported", () => {
  const files = {
    "deploy-one.md": mem("deploy-rules", "staging deploys need approval from the owner first"),
    "deploy-two.md": mem("deploy-approval", "staging deploys need owner approval first"),
  };
  for (let i = 0; i < 31; i++) files[`f${i}.md`] = mem(`f${i}`, `topic ${i}`);
  const out = sandbox(files)("memory", "lint").stdout;
  assert.match(out, /overlap    deploy-one\.md: may cover the same ground as deploy-two\.md/);
  assert.match(out, /over-limit 33 files \(limit 30\)/);
});
