import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export interface Worktree {
  path: string;
  branch?: string;
  head?: string;
  main: boolean;
  /** The folder is gone but git still lists it. */
  missing: boolean;
}

export function worktrees(repo: string): Worktree[] {
  const out = git(repo, ["worktree", "list", "--porcelain"]);
  if (out === undefined) return [];
  const list: Worktree[] = [];
  for (const block of out.split("\n\n")) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path) continue;
    list.push({
      path,
      head: lines.find((l) => l.startsWith("HEAD "))?.slice(5),
      branch: lines.find((l) => l.startsWith("branch refs/heads/"))?.slice(18),
      main: list.length === 0,
      missing: !existsSync(path),
    });
  }
  return list;
}

/** origin/HEAD if the remote has one, else a local main or master. */
export function defaultBranch(repo: string): string | undefined {
  const remote = git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remote) return remote;
  for (const b of ["main", "master"]) if (git(repo, ["rev-parse", "--verify", "--quiet", b]) !== undefined) return b;
  return undefined;
}

/** Branches whose upstream was deleted: the usual trace of a squash-merged PR. */
export function goneBranches(repo: string): Set<string> {
  const out = git(repo, ["for-each-ref", "--format=%(refname:short)\t%(upstream:track)", "refs/heads"]) ?? "";
  return new Set(out.split("\n").filter((l) => l.endsWith("[gone]")).map((l) => l.split("\t")[0]));
}

export const isDirty = (wt: string) => (git(wt, ["status", "--porcelain"]) ?? "x") !== "";
export const isAncestor = (repo: string, commit: string, of: string) =>
  git(repo, ["merge-base", "--is-ancestor", commit, of]) !== undefined;
export const lastCommitAt = (wt: string) => Number(git(wt, ["log", "-1", "--format=%ct"]) ?? 0) * 1000;
export const removeWorktree = (repo: string, path: string) => git(repo, ["worktree", "remove", path]) !== undefined;
export const pruneWorktrees = (repo: string) => git(repo, ["worktree", "prune"]) !== undefined;
