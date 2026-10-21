import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { expand, tilde } from "./paths.js";

export interface Config {
  /** The one real copy of settings, CLAUDE.md, hooks, skills, agents and memory. */
  shared: string;
  /** Profile name -> Claude config dir (what CLAUDE_CONFIG_DIR points at). */
  profiles: Record<string, string>;
  /** Entries in each profile that should be symlinks into `shared`. */
  link: string[];
  /** Link every profile's projects/<key>/memory to shared/memory/<key>. */
  shareMemory: boolean;
  /** Git repos whose worktrees starling reports on and cleans. */
  repos: string[];
  /** Folders whose subfolders are per-task scratch space. */
  scratch: string[];
  /** Folder of stream handoff files, if you use them. */
  handoffs?: string;
  /** Untouched for this many days counts as stale. */
  staleDays: number;
  limits: { memoryFiles: number; memoryIndexLines: number };
}

export const DEFAULT_LINKS = ["settings.json", "CLAUDE.md", "hooks", "skills", "agents"];

export function configPath(): string {
  const env = process.env.STARLING_CONFIG;
  return env ? expand(env) : join(homedir(), ".starling", "config.json");
}

export function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) {
    throw new Error(`No config at ${tilde(p)}. Run \`starling init\` first.`);
  }
  const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Config>;
  return {
    shared: raw.shared ?? "~/.claude-shared",
    profiles: raw.profiles ?? {},
    link: raw.link ?? DEFAULT_LINKS,
    shareMemory: raw.shareMemory ?? true,
    repos: raw.repos ?? [],
    scratch: raw.scratch ?? [],
    handoffs: raw.handoffs,
    staleDays: raw.staleDays ?? 7,
    limits: { memoryFiles: 30, memoryIndexLines: 50, ...raw.limits },
  };
}

export function saveConfig(cfg: Config): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}

/**
 * Every ~/.claude and ~/.claude-<name> folder is a profile, except the shared folder itself.
 * ~/.claude is named "default"; ~/.claude-work is named "work".
 */
export function detectProfiles(shared: string): Record<string, string> {
  const home = homedir();
  const sharedAbs = expand(shared);
  const out: Record<string, string> = {};
  for (const name of readdirSync(home).sort()) {
    if (name !== ".claude" && !name.startsWith(".claude-")) continue;
    const full = join(home, name);
    if (full === sharedAbs || !statSync(full).isDirectory()) continue;
    out[name === ".claude" ? "default" : name.slice(".claude-".length)] = tilde(full);
  }
  return out;
}

/** The default profile keeps its account file at ~/.claude.json, the others inside their dir. */
export function accountFile(profileDir: string): string {
  const dir = expand(profileDir);
  return dir === join(homedir(), ".claude") ? join(homedir(), ".claude.json") : join(dir, ".claude.json");
}

export function accountEmail(profileDir: string): string | undefined {
  try {
    const j = JSON.parse(readFileSync(accountFile(profileDir), "utf8"));
    return j?.oauthAccount?.emailAddress;
  } catch {
    return undefined;
  }
}
