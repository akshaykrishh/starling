import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.js";
import * as git from "./git.js";
import { queueLines } from "./magpie.js";
import { expand, tilde } from "./paths.js";
import type { Session } from "./sessions.js";

/**
 * A stream is one piece of work that outlives any single session: it keeps its worktree,
 * its handoff and the list of sessions (on any profile) that worked on it.
 */
export interface Stream {
  name: string;
  cwd: string;
  profile?: string;
  status: "open" | "closed";
  created: number;
  updated: number;
  sessions: string[];
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export const streamsDir = () => join(homedir(), ".starling", "streams");
const streamFile = (name: string) => join(streamsDir(), `${name}.json`);
export const handoffFile = (cfg: Config, name: string) =>
  join(cfg.handoffs ? expand(cfg.handoffs) : join(homedir(), ".starling", "handoffs"), `${name}.md`);

export function validName(name: string | undefined): string {
  if (!name || !NAME.test(name)) throw new Error("A stream name is letters, digits, dots, dashes or underscores (for example: billing-retry).");
  return name;
}

export function getStream(name: string): Stream | undefined {
  try {
    return JSON.parse(readFileSync(streamFile(name), "utf8")) as Stream;
  } catch {
    return undefined;
  }
}

export function saveStream(s: Stream): void {
  mkdirSync(streamsDir(), { recursive: true });
  writeFileSync(streamFile(s.name), JSON.stringify(s, null, 2) + "\n");
}

export function listStreams(): Stream[] {
  if (!existsSync(streamsDir())) return [];
  return readdirSync(streamsDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => getStream(f.slice(0, -5)))
    .filter((s): s is Stream => !!s)
    .sort((a, b) => b.updated - a.updated);
}

/** The open stream working in this folder, if any. */
export function streamFor(cwd: string): Stream | undefined {
  return listStreams().find((s) => s.status === "open" && s.cwd === cwd);
}

export function attach(name: string, session: Session): void {
  const s = getStream(name);
  if (!s) return;
  if (!s.sessions.includes(session.id)) s.sessions.push(session.id);
  s.profile = session.profile;
  s.updated = Date.now();
  saveStream(s);
}

function sh(cmd: string, args: string[], cwd: string): string | undefined {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }).trim();
  } catch {
    return undefined;
  }
}

/** Facts about the stream's worktree that are true right now, so the next session need not trust a summary. */
function gitFacts(cwd: string): string[] {
  const out: string[] = [];
  const branch = sh("git", ["branch", "--show-current"], cwd);
  if (branch === undefined) return [`- Folder: ${tilde(cwd)} (not a git repository)`];
  const base = git.defaultBranch(cwd);
  const ahead = base ? sh("git", ["rev-list", "--count", `${base}..HEAD`], cwd) : undefined;
  out.push(`- Branch: \`${branch || "(detached)"}\`${ahead ? `, ${ahead} commit(s) ahead of \`${base}\`` : ""}`);
  const pr = sh("gh", ["pr", "view", "--json", "number,title,state,url", "--jq", '"#\\(.number) \\(.title) (\\(.state)) \\(.url)"'], cwd);
  if (pr) out.push(`- PR: ${pr}`);
  const status = (sh("git", ["status", "--short"], cwd) ?? "").split("\n").filter(Boolean);
  out.push(`- Uncommitted: ${status.length ? `${status.length} file(s)` : "none"}`);
  for (const l of status.slice(0, 20)) out.push(`  - \`${l}\``);
  if (status.length > 20) out.push(`  - …and ${status.length - 20} more`);
  const log = base ? (sh("git", ["log", "--oneline", "-10", `${base}..HEAD`], cwd) ?? "").split("\n").filter(Boolean) : [];
  if (log.length) {
    out.push("- Commits on this branch (newest first):");
    for (const l of log) out.push(`  - ${l}`);
  }
  out.push(...queueLines(cwd, branch || undefined));
  return out;
}

const NOTES_START = "## Notes\n";
const NOTES_END = "\n## State";

function previousNotes(file: string): string | undefined {
  try {
    const text = readFileSync(file, "utf8");
    const a = text.indexOf(NOTES_START);
    const b = text.indexOf(NOTES_END, a);
    return a >= 0 && b > a ? text.slice(a + NOTES_START.length, b).trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Overwrite the stream's handoff: the notes (written by the session that knows the intent)
 * and a State section regenerated from git every time. Without new notes, the previous ones
 * are kept, so refreshing the facts never loses the narrative.
 */
export function writeHandoff(cfg: Config, s: Stream, notes: string | undefined, sessions: Session[]): string {
  const file = handoffFile(cfg, s.name);
  const body = notes?.trim() || previousNotes(file) || "_No notes yet. Run the starling:handoff skill in the session that did the work._";
  const mine = sessions.filter((x) => s.sessions.includes(x.id));
  const lines = [
    `# Stream: ${s.name}`,
    "",
    `Updated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · ${tilde(s.cwd)}${s.profile ? ` · last profile: ${s.profile}` : ""}`,
    "",
    NOTES_START + body,
    "",
    "## State (generated by starling from git; true at the time above)",
    "",
    ...gitFacts(s.cwd),
  ];
  if (mine.length) {
    lines.push("- Sessions on this stream:");
    for (const x of mine.slice(0, 10)) lines.push(`  - ${x.profile} · ${x.title ?? x.id.slice(0, 8)} · ${x.state}`);
  }
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}
