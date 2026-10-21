#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountEmail, configPath, DEFAULT_LINKS, detectProfiles, loadConfig, saveConfig, type Config } from "./config.js";
import { check, fix, HINT, isFixable, type Finding } from "./doctor.js";
import * as git from "./git.js";
import { expand, tilde } from "./paths.js";
import { ago, listSessions, record, staleSessionRecords, type HookInput, type Session } from "./sessions.js";
import { attach, getStream, handoffFile, listStreams, saveStream, streamFor, validName, writeHandoff, type Stream } from "./streams.js";
import { hygiene, judgeWorktrees, moveToTrash, staleScratch, trashDir } from "./yard.js";

const HELP = `starling: keep many Claude Code sessions, accounts and worktrees moving as one flock

  starling init [--shared <dir>]        write ~/.starling/config.json from the ~/.claude* folders found
  starling profile ls                   profiles, their account and link health
  starling profile add <name> [--dir]   create a profile that shares everything with the others
  starling run <profile> [-- args]      start claude as that profile

  starling ls [--all] [--hours N]       every session on every profile; the ones waiting on you first
  starling streams                      open streams: a piece of work that outlives sessions and accounts
  starling handoff <stream> [--notes-file <path|->]
                                        write the stream's handoff (notes + live git state); starts the stream
                                        in this folder if it is new
  starling resume <stream> [--profile p]
                                        start claude in the stream's folder with its handoff loaded
  starling close <stream>               close it; the handoff goes to ~/.starling/trash

  starling doctor [--fix]               check every profile still points at the shared config
  starling hygiene                      one-line health report (links, memory, worktrees, scratch, handoffs)
  starling gc [--apply]                 merged worktrees, stale scratch and old session records
  starling hook <event>                 called by the plugin's hooks; reads the hook's JSON on stdin

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

function claudeAs(cfg: Config, profile: string, args: string[], opts: { cwd?: string; stream?: string } = {}): number {
  const dir = cfg.profiles[profile];
  if (!dir) throw new Error(`Unknown profile ${profile}. Profiles: ${Object.keys(cfg.profiles).join(", ")}`);
  const env = { ...process.env };
  // The default ~/.claude keeps its account in ~/.claude.json, which Claude only finds without the variable.
  if (expand(dir) === join(homedir(), ".claude")) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = expand(dir);
  if (opts.stream) env.STARLING_STREAM = opts.stream;
  return spawnSync("claude", args, { stdio: "inherit", env, cwd: opts.cwd }).status ?? 1;
}

function run(cfg: Config, args: string[]): number {
  const [name, ...rest] = args;
  if (!name) throw new Error("Usage: starling run <profile> [-- claude args]");
  return claudeAs(cfg, name, rest[0] === "--" ? rest.slice(1) : rest);
}

const STATE_LABEL: Record<Session["state"], string> = {
  waiting: "WAITING",
  working: "working",
  active: "active",
  idle: "idle",
  ended: "ended",
};

function ls(cfg: Config, args: string[]): void {
  const hours = Number(flag(args, "--hours") ?? 24);
  const all = listSessions(cfg, hours);
  const shown = args.includes("--all") ? all : all.filter((s) => s.state !== "ended");
  if (!shown.length) return console.log(`No sessions in the last ${hours}h.`);
  const rows = shown.map((s) => [
    STATE_LABEL[s.state],
    ago(s.since),
    s.profile,
    tilde(s.cwd).split("/").slice(-1)[0] || tilde(s.cwd),
    s.branch ?? "",
    s.stream ?? "",
    (s.title ?? "").slice(0, 50),
  ]);
  const head = ["STATE", "FOR", "PROFILE", "FOLDER", "BRANCH", "STREAM", "TITLE"];
  const widths = head.map((h, i) => Math.min(32, Math.max(h.length, ...rows.map((r) => r[i].length))));
  const fmt = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.slice(0, widths[i]).padEnd(widths[i]))).join("  ");
  console.log(fmt(head));
  for (const r of rows) console.log(fmt(r));
  const waiting = shown.filter((s) => s.state === "waiting").length;
  if (waiting) console.log(`\n${waiting} waiting on you.`);
}

function streams(): void {
  const open = listStreams().filter((s) => s.status === "open");
  if (!open.length) return console.log("No open streams. Start one with `starling handoff <name>` in the work's folder.");
  for (const s of open) {
    console.log(`${s.name.padEnd(24)} ${ago(s.updated).padStart(4)}  ${(s.profile ?? "").padEnd(12)} ${tilde(s.cwd)}  (${s.sessions.length} session(s))`);
  }
}

function readNotes(args: string[]): string | undefined {
  const src = flag(args, "--notes-file");
  if (!src) return undefined;
  return readFileSync(src === "-" ? 0 : src, "utf8");
}

function handoff(cfg: Config, args: string[]): void {
  const name = validName(args[0]);
  const now = Date.now();
  const s: Stream = getStream(name) ?? { name, cwd: process.cwd(), status: "open", created: now, updated: now, sessions: [] };
  s.status = "open";
  s.updated = now;
  const current = process.env.CLAUDE_CODE_SESSION_ID;
  if (current && !s.sessions.includes(current)) s.sessions.push(current);
  saveStream(s);
  const file = writeHandoff(cfg, s, readNotes(args), listSessions(cfg, 24 * 30));
  console.log(`Handoff for ${name}: ${tilde(file)}\nResume it with: starling resume ${name} [--profile <p>]`);
}

function resume(cfg: Config, args: string[]): number {
  const name = validName(args[0]);
  const s = getStream(name);
  if (!s) throw new Error(`No stream ${name}. Open streams: ${listStreams().map((x) => x.name).join(", ") || "none"}`);
  const profile = flag(args, "--profile") ?? s.profile ?? Object.keys(cfg.profiles)[0];
  // Refresh the git facts so the new session starts from the truth, keeping the notes.
  writeHandoff(cfg, s, undefined, []);
  return claudeAs(cfg, profile, [`Continue the "${name}" stream. Its handoff was loaded at session start; check the State section against git before acting.`], {
    cwd: s.cwd,
    stream: name,
  });
}

function close(cfg: Config, args: string[]): void {
  const name = validName(args[0]);
  const s = getStream(name);
  if (!s) throw new Error(`No stream ${name}.`);
  s.status = "closed";
  s.updated = Date.now();
  saveStream(s);
  const file = handoffFile(cfg, name);
  if (existsSync(file)) console.log(`Closed ${name}. Handoff moved to ${tilde(moveToTrash(file, trashDir()))}.`);
  else console.log(`Closed ${name}.`);
}

/**
 * Every hook event lands here. Must stay quick and must never block a session, so all
 * errors are swallowed. Only SessionStart prints, and what it prints becomes session context.
 */
function hook(event: string): void {
  let cfg: Config | undefined;
  try {
    cfg = loadConfig();
  } catch {}
  let input: HookInput = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {}
  input.hook_event_name ??= event;

  const named = process.env.STARLING_STREAM;
  const stream = named ? getStream(named) : input.cwd ? streamFor(input.cwd) : undefined;
  try {
    const s = record(cfg, input, stream?.name);
    if (s && stream && input.hook_event_name === "SessionStart") attach(stream.name, s);
  } catch {}

  if (input.hook_event_name !== "SessionStart") return;
  if (cfg) {
    try {
      sessionStart(cfg);
    } catch {}
  }
  if (named && stream && cfg) {
    try {
      console.log(`starling: this session continues the "${named}" stream. Its handoff:\n\n${readFileSync(handoffFile(cfg, named), "utf8")}`);
    } catch {}
  }
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
  // Session records are starling's own bookkeeping, so old ones are simply deleted.
  const records = staleSessionRecords(cfg.staleDays);
  if (records.length) console.log(`${apply ? "deleted" : "delete "} ${records.length} session record(s) older than ${cfg.staleDays} days`);
  if (apply) for (const r of records) rmSync(r, { force: true });

  if (!verdicts.length && !scratch.length && !records.length) console.log("Nothing to clean.");
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
    // A hook must never block a session, even with a broken config. The old spelling
    // `hook session-start` is the same as the SessionStart event.
    try {
      hook(args[0] === "session-start" ? "SessionStart" : (args[0] ?? ""));
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
    case "ls":
      return ls(cfg, args), 0;
    case "streams":
      return streams(), 0;
    case "handoff":
      return handoff(cfg, args), 0;
    case "resume":
      return resume(cfg, args);
    case "close":
      return close(cfg, args), 0;
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
