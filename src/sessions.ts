import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Config } from "./config.js";
import { expand } from "./paths.js";

/**
 * working   the session is on a turn (a prompt was submitted)
 * waiting   the turn ended, or Claude asked for permission or input: it needs you
 * ended     the session exited
 * active    seen only from its transcript (no hooks yet), written to in the last 2 minutes
 * idle      seen only from its transcript, quiet for longer
 */
export type State = "working" | "waiting" | "ended" | "active" | "idle";

export interface Session {
  id: string;
  profile: string;
  cwd: string;
  branch?: string;
  title?: string;
  state: State;
  /** When the session entered its current state. */
  since: number;
  updated: number;
  transcript?: string;
  stream?: string;
  /** The claude process (CLAUDE_PID, which hooks inherit), to tell a crash from a quiet session. */
  pid?: number;
}

const MIN = 60_000;

export const sessionsDir = () => join(homedir(), ".starling", "sessions");

function readJson<T>(p: string): T | undefined {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Which profile a transcript belongs to: the configured dir it lives under, else the dir's name. */
export function profileOf(cfg: Config | undefined, transcript: string | undefined): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  // Without a transcript, the profile folder itself (the trailing / keeps the prefix match exact).
  const path = transcript ?? dir.replace(/\/$/, "") + "/";
  for (const [name, d] of Object.entries(cfg?.profiles ?? {})) if (path.startsWith(expand(d) + "/")) return name;
  const root = path.split("/projects/")[0];
  const b = basename(root);
  return b === ".claude" ? "default" : b.replace(/^\.claude-/, "");
}

function branchOf(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The last bytes of a file: enough for the latest transcript entries without reading megabytes. */
function tail(p: string, bytes = 256 * 1024): string {
  const fd = openSync(p, "r");
  try {
    const size = statSync(p).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

interface Entry {
  type?: string;
  cwd?: string;
  gitBranch?: string;
  aiTitle?: string;
}

/** The session's working folder, branch and title from the end of its transcript. */
export function readTranscript(p: string): { cwd?: string; branch?: string; title?: string } {
  const out: { cwd?: string; branch?: string; title?: string } = {};
  let text: string;
  try {
    text = tail(p);
  } catch {
    return out;
  }
  for (const line of text.split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    let e: Entry;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!out.title && e.type === "ai-title" && e.aiTitle) out.title = e.aiTitle;
    if (!out.cwd && e.cwd) {
      out.cwd = e.cwd;
      out.branch = e.gitBranch || undefined;
    }
    if (out.cwd && out.title) break;
  }
  return out;
}

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
}

const EVENT_STATE: Record<string, State> = {
  SessionStart: "waiting",
  UserPromptSubmit: "working",
  Stop: "waiting",
  Notification: "waiting",
  SessionEnd: "ended",
};

/** Record a hook event. Called on every prompt and turn end, so it does as little as it can. */
export function record(cfg: Config | undefined, input: HookInput, stream?: string): Session | undefined {
  const event = input.hook_event_name ?? "";
  const state = EVENT_STATE[event];
  if (!input.session_id || !state) return undefined;
  mkdirSync(sessionsDir(), { recursive: true });
  const file = join(sessionsDir(), `${input.session_id}.json`);
  const prev = readJson<Session>(file);
  const now = Date.now();
  const cwd = input.cwd ?? prev?.cwd ?? process.cwd();
  const s: Session = {
    id: input.session_id,
    profile: prev?.profile ?? profileOf(cfg, input.transcript_path),
    cwd,
    branch: event === "SessionStart" || event === "UserPromptSubmit" || !prev ? branchOf(cwd) : prev.branch,
    state,
    since: prev?.state === state ? prev.since : now,
    updated: now,
    transcript: input.transcript_path ?? prev?.transcript,
    stream: stream ?? prev?.stream,
    pid: Number(process.env.CLAUDE_PID) || prev?.pid,
  };
  writeFileSync(file, JSON.stringify(s) + "\n");
  return s;
}

/**
 * Every session from the last `hours`: hook records first, then any transcript that has no
 * record (sessions started before the plugin was installed).
 */
export function listSessions(cfg: Config, hours = 24): Session[] {
  const cutoff = Date.now() - hours * 60 * MIN;
  const byId = new Map<string, Session>();
  if (existsSync(sessionsDir())) {
    for (const f of readdirSync(sessionsDir())) {
      if (!f.endsWith(".json")) continue;
      const s = readJson<Session>(join(sessionsDir(), f));
      if (!s || s.updated < cutoff) continue;
      if (s.state !== "ended" && s.pid && !alive(s.pid)) s.state = "ended";
      byId.set(s.id, s);
    }
  }
  for (const [profile, dir] of Object.entries(cfg.profiles)) {
    const projects = join(expand(dir), "projects");
    let keys: string[] = [];
    try {
      keys = readdirSync(projects);
    } catch {
      continue;
    }
    for (const key of keys) {
      let files: string[] = [];
      try {
        files = readdirSync(join(projects, key)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        const path = join(projects, key, f);
        const mtime = statSync(path).mtimeMs;
        if (mtime < cutoff) continue;
        const id = f.slice(0, -".jsonl".length);
        const t = readTranscript(path);
        const known = byId.get(id);
        if (known) {
          known.title = t.title ?? known.title;
          // A crash skips SessionEnd; a "working" session whose transcript went quiet is not working.
          if (known.state === "working" && Date.now() - mtime > 30 * MIN) known.state = "idle";
          continue;
        }
        if (!t.cwd) continue;
        const recent = Date.now() - mtime < 2 * MIN;
        byId.set(id, { id, profile, cwd: t.cwd, branch: t.branch, title: t.title, state: recent ? "active" : "idle", since: mtime, updated: mtime, transcript: path });
      }
    }
  }
  const order: Record<State, number> = { waiting: 0, working: 1, active: 2, idle: 3, ended: 4 };
  return [...byId.values()].sort((a, b) => order[a.state] - order[b.state] || b.updated - a.updated);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / MIN);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** Session records for sessions that ended or went silent long ago. */
export function staleSessionRecords(days: number): string[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - days * 24 * 60 * MIN;
  return readdirSync(dir)
    .map((f) => join(dir, f))
    .filter((p) => (readJson<Session>(p)?.updated ?? 0) < cutoff);
}
