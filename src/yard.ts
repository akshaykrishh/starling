import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Config } from "./config.js";
import { check } from "./doctor.js";
import * as git from "./git.js";
import { expand } from "./paths.js";

const DAY = 86_400_000;

function dirs(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(p, d.name));
  } catch {
    return [];
  }
}

function files(p: string, ext = ""): string[] {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(ext)).map((d) => join(p, d.name));
  } catch {
    return [];
  }
}

const olderThan = (p: string, days: number) => Date.now() - statSync(p).mtimeMs > days * DAY;

/** Scratch folders that hold handoffs or locks are infrastructure, not task scratch. */
const RESERVED = new Set(["handoffs", "locks"]);

export function staleScratch(cfg: Config): string[] {
  return cfg.scratch.flatMap((root) =>
    dirs(expand(root)).filter((d) => !RESERVED.has(basename(d)) && olderThan(d, cfg.staleDays)),
  );
}

export interface WorktreeVerdict {
  repo: string;
  wt: git.Worktree;
  /** Why it can go, or why it stays. */
  reason: string;
  removable: boolean;
}

/**
 * A worktree can go when it is clean and its work has landed: its commit is on the default
 * branch, or its branch's upstream was deleted (a squash-merged PR). Anything dirty or
 * unmerged stays, however old. `git status` is by far the slowest check on a large repo, so
 * it only runs on worktrees that have already passed the merge checks.
 */
export function judgeWorktrees(cfg: Config): { verdicts: WorktreeVerdict[]; total: number } {
  const verdicts: WorktreeVerdict[] = [];
  let total = 0;
  for (const raw of cfg.repos) {
    const repo = expand(raw);
    const base = git.defaultBranch(repo);
    const gone = git.goneBranches(repo);
    for (const wt of git.worktrees(repo)) {
      if (wt.main) continue;
      total++;
      const v = (removable: boolean, reason: string) => verdicts.push({ repo, wt, removable, reason });
      if (wt.missing) {
        v(true, "folder already deleted; prune the record");
        continue;
      }
      const merged =
        wt.branch && gone.has(wt.branch)
          ? "branch deleted on the remote (merged)"
          : base && wt.head && git.isAncestor(repo, wt.head, base)
            ? `already in ${base}`
            : undefined;
      if (merged) {
        const dirty = git.isDirty(wt.path);
        v(!dirty, dirty ? `${merged}, but has uncommitted changes` : merged);
      }
      else if (Date.now() - git.lastCommitAt(wt.path) > cfg.staleDays * DAY) v(false, `unmerged, no commits for ${cfg.staleDays}+ days`);
    }
  }
  return { verdicts, total };
}

/** Moves go to ~/.starling/trash/<timestamp>/ so a cleanup can always be undone. */
export function trashDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(homedir(), ".starling", "trash", stamp);
}

export function moveToTrash(p: string, trash: string): string {
  mkdirSync(trash, { recursive: true });
  let dest = join(trash, basename(p));
  for (let i = 1; existsSync(dest); i++) dest = join(trash, `${basename(p)}-${i}`);
  try {
    renameSync(p, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(p, dest, { recursive: true });
    rmSync(p, { recursive: true });
  }
  return dest;
}

/** Claude names a project's store after its path with / turned into -; drop the home part. */
function projectName(key: string): string {
  const prefix = homedir().replace(/\//g, "-") + "-";
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function lineCount(p: string): number {
  try {
    return readFileSync(p, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * One line, every number with its limit; anything over the limit is marked "!" so drift
 * shows up in a report you already read. Reports only, never changes anything.
 */
export function hygiene(cfg: Config): string {
  const parts: string[] = [];
  const shared = expand(cfg.shared);

  const findings = check(cfg).filter((f) => f.status !== "ok");
  const profiles = Object.keys(cfg.profiles).length;
  parts.push(findings.length ? `links! ${findings.length} need attention (starling doctor)` : `links: ok across ${profiles} profiles`);

  const over: string[] = [];
  const stores = dirs(join(shared, "memory"));
  for (const d of stores) {
    const n = files(d, ".md").filter((f) => basename(f) !== "MEMORY.md").length;
    const l = lineCount(join(d, "MEMORY.md"));
    if (n > cfg.limits.memoryFiles || l > cfg.limits.memoryIndexLines) over.push(`${projectName(basename(d))}=${n}f/${l}l`);
  }
  parts.push(over.length ? `memory! ${over.length}/${stores.length} stores over limit (${over.join(", ")})` : `memory: ${stores.length} stores within limits`);

  if (cfg.repos.length) {
    const { verdicts, total } = judgeWorktrees(cfg);
    const done = verdicts.filter((v) => v.removable).length;
    const stale = verdicts.length - done;
    parts.push(`worktrees${done ? "!" : ":"} ${total} (${done} merged and removable, ${stale} stale unmerged)`);
  }

  if (cfg.scratch.length) {
    const n = staleScratch(cfg).length;
    parts.push(`scratch${n ? "!" : ":"} ${n} folders untouched ${cfg.staleDays}+ days`);
  }

  if (cfg.handoffs) {
    const all = files(expand(cfg.handoffs), ".md");
    const old = all.filter((f) => olderThan(f, cfg.staleDays)).length;
    parts.push(`handoffs${old ? "!" : ":"} ${all.length} (${old} older than ${cfg.staleDays}d)`);
  }

  return parts.join(" · ");
}
