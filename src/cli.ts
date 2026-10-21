#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountEmail, configPath, DEFAULT_LINKS, detectProfiles, loadConfig, saveConfig, type Config } from "./config.js";
import { check, fix, HINT, isFixable, type Finding } from "./doctor.js";
import * as git from "./git.js";
import { expand, tilde } from "./paths.js";
import { hygiene, judgeWorktrees, moveToTrash, staleScratch, trashDir } from "./yard.js";

const HELP = `starling: keep many Claude Code sessions, accounts and worktrees moving as one flock

  starling init [--shared <dir>]        write ~/.starling/config.json from the ~/.claude* folders found
  starling profile ls                   profiles, their account and link health
  starling profile add <name> [--dir]   create a profile that shares everything with the others
  starling run <profile> [-- args]      start claude as that profile
  starling doctor [--fix]               check every profile still points at the shared config
  starling hygiene                      one-line health report (links, memory, worktrees, scratch, handoffs)
  starling gc [--apply]                 merged worktrees and stale scratch; --apply moves them to ~/.starling/trash
  starling hook session-start           for a SessionStart hook: apply safe fixes, report the rest

Config: ${tilde(configPath())} (override with STARLING_CONFIG)`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function describe(f: Finding): string {
  return `  ${f.profile.padEnd(12)} ${tilde(f.path)}: ${HINT[f.status]}`;
}

function init(args: string[]): void {
  if (existsSync(configPath())) throw new Error(`${tilde(configPath())} already exists. Edit it directly.`);
  const shared = flag(args, "--shared") ?? "~/.claude-shared";
  const cfg: Config = {
    shared,
    profiles: detectProfiles(shared),
    link: DEFAULT_LINKS,
    shareMemory: true,
    repos: [],
    scratch: [],
    staleDays: 7,
    limits: { memoryFiles: 30, memoryIndexLines: 50 },
  };
  saveConfig(cfg);
  console.log(`Wrote ${tilde(configPath())} with ${Object.keys(cfg.profiles).length} profiles: ${Object.keys(cfg.profiles).join(", ") || "none"}.`);
  if (!existsSync(expand(shared))) {
    console.log(`\n${shared} does not exist yet. Create it with the settings, CLAUDE.md, hooks, skills and agents`);
    console.log(`every profile should share (copying them from ~/.claude is a good start), then run \`starling doctor\`.`);
  } else {
    console.log("Next: `starling doctor` to see what is linked. Add repos, scratch and handoffs to the config for hygiene and gc.");
  }
}

function profileLs(cfg: Config): void {
  const findings = check(cfg);
  for (const [name, dir] of Object.entries(cfg.profiles)) {
    const mine = findings.filter((f) => f.profile === name);
    const bad = mine.filter((f) => f.status !== "ok").length;
    const health = !existsSync(expand(dir)) ? "missing dir" : bad ? `${bad} issue(s)` : `${mine.length} links ok`;
    console.log(`${name.padEnd(12)} ${tilde(expand(dir)).padEnd(28)} ${(accountEmail(dir) ?? "not logged in").padEnd(32)} ${health}`);
  }
}

function profileAdd(cfg: Config, args: string[]): void {
  const name = args[0];
  if (!name || name.startsWith("-")) throw new Error("Usage: starling profile add <name> [--dir <path>]");
  if (cfg.profiles[name]) throw new Error(`Profile ${name} already exists at ${cfg.profiles[name]}.`);
  const dir = flag(args, "--dir") ?? `~/.claude-${name}`;
  mkdirSync(expand(dir), { recursive: true });
  cfg.profiles[name] = dir;
  saveConfig(cfg);
  const left = fix(check(cfg, name));
  console.log(`Added ${name} at ${dir}, linked to ${cfg.shared}.`);
  for (const f of left) console.log(describe(f));
  console.log(`Log in once with: starling run ${name}`);
}

function run(cfg: Config, args: string[]): number {
  const [name, ...rest] = args;
  const dir = name && cfg.profiles[name];
  if (!dir) throw new Error(`Unknown profile ${name ?? ""}. Profiles: ${Object.keys(cfg.profiles).join(", ")}`);
  const passthrough = rest[0] === "--" ? rest.slice(1) : rest;
  const env = { ...process.env };
  // The default ~/.claude keeps its account in ~/.claude.json, which Claude only finds without the variable.
  if (expand(dir) === join(homedir(), ".claude")) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = expand(dir);
  return spawnSync("claude", passthrough, { stdio: "inherit", env }).status ?? 1;
}

function doctor(cfg: Config, args: string[]): number {
  let findings = check(cfg).filter((f) => f.status !== "ok");
  if (args.includes("--fix")) {
    const before = findings.length;
    findings = fix(findings);
    console.log(`Fixed ${before - findings.length}.`);
  }
  if (!findings.length) {
    console.log(`All ${Object.keys(cfg.profiles).length} profiles point at ${cfg.shared}.`);
    return 0;
  }
  for (const f of findings) console.log(describe(f));
  if (findings.some(isFixable)) console.log("\nRun `starling doctor --fix` to apply the safe fixes.");
  return 1;
}

function gc(cfg: Config, args: string[]): void {
  const apply = args.includes("--apply");
  const { verdicts } = judgeWorktrees(cfg);
  const scratch = staleScratch(cfg);
  const trash = trashDir();
  let moved = 0;

  for (const v of verdicts) {
    const mark = v.removable ? (apply ? "removed" : "remove ") : "keep   ";
    console.log(`${mark} worktree ${tilde(v.wt.path)}: ${v.reason}`);
    if (!apply || !v.removable) continue;
    // git worktree remove refuses a dirty tree on its own, so this never loses work.
    if (v.wt.missing) git.pruneWorktrees(v.repo);
    else if (!git.removeWorktree(v.repo, v.wt.path)) console.log(`  git refused to remove ${tilde(v.wt.path)}; left in place`);
  }
  for (const d of scratch) {
    if (apply) {
      moveToTrash(d, trash);
      moved++;
    }
    console.log(`${apply ? "trashed" : "trash  "} scratch  ${tilde(d)}: untouched ${cfg.staleDays}+ days`);
  }

  if (!verdicts.length && !scratch.length) console.log("Nothing to clean.");
  else if (!apply) console.log("\nDry run. `starling gc --apply` removes merged worktrees (git refuses dirty ones) and moves scratch to the trash.");
  else if (moved) console.log(`\nScratch moved to ${tilde(trash)}. Delete that folder once you are sure.`);
}

/** SessionStart hook: silent when healthy; stdout is added to the session's context. */
function sessionStart(cfg: Config): void {
  const left = fix(check(cfg).filter((f) => f.status !== "ok"));
  if (!left.length) return;
  console.log(
    `starling: shared Claude config has drifted.\n${left.map(describe).join("\n")}\n` +
      `Merge each change into ${cfg.shared}, then run \`starling doctor --fix\`, before other work.`,
  );
}

function main(argv: string[]): number {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return console.log(HELP), 0;
  if (cmd === "--version" || cmd === "-v") {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return console.log(pkg.version), 0;
  }
  if (cmd === "init") return init(args), 0;
  if (cmd === "hook") {
    // A hook must never block a session, even with a broken config.
    try {
      if (args[0] === "session-start") sessionStart(loadConfig());
    } catch {}
    return 0;
  }

  const cfg = loadConfig();
  switch (cmd) {
    case "profile":
    case "profiles":
      if (args[0] === "add") return profileAdd(cfg, args.slice(1)), 0;
      return profileLs(cfg), 0;
    case "run":
      return run(cfg, args);
    case "doctor":
      return doctor(cfg, args);
    case "hygiene":
      return console.log(hygiene(cfg)), 0;
    case "gc":
      return gc(cfg, args), 0;
    default:
      console.error(`Unknown command ${cmd}.\n\n${HELP}`);
      return 2;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
