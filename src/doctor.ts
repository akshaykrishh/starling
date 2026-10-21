import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config } from "./config.js";
import { expand } from "./paths.js";

/**
 * ok          the entry is a symlink to the shared copy
 * missing     the entry does not exist yet; link it
 * forked      a regular file with the same bytes as the shared copy. Claude Code saves settings
 *             with an atomic write (write a temp file, rename it over the target), which replaces
 *             a symlink with a plain file. Same content means nothing was lost; relink it.
 * diverged    a real file or folder with different content: someone changed one profile only.
 *             Merge the change into the shared copy by hand, then run `starling doctor --fix`.
 * wrong-link  a symlink to somewhere other than the shared copy
 * memory-local  a profile's memory folder that the shared store has never seen; move it there
 * memory-empty  an empty real memory folder; replace it with the link
 */
export type Status = "ok" | "missing" | "forked" | "diverged" | "wrong-link" | "memory-local" | "memory-empty";

export interface Finding {
  profile: string;
  /** The entry inside the profile. */
  path: string;
  /** The shared copy it should point at. */
  target: string;
  status: Status;
}

const FIXABLE: ReadonlySet<Status> = new Set(["missing", "forked", "memory-local", "memory-empty"]);
export const isFixable = (f: Finding) => FIXABLE.has(f.status);

function lstat(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}

function linksTo(p: string, target: string): boolean {
  return resolve(dirname(p), readlinkSync(p)) === target;
}

function sameBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

function checkEntry(profile: string, path: string, target: string, memory: boolean): Finding | undefined {
  const st = lstat(path);
  const tst = lstat(target);
  const f = (status: Status): Finding => ({ profile, path, target, status });
  if (!st) return tst ? f("missing") : undefined;
  if (st.isSymbolicLink()) return f(linksTo(path, target) ? "ok" : "wrong-link");
  if (memory && st.isDirectory()) {
    if (readdirSync(path).length === 0) return f("memory-empty");
    return tst ? f("diverged") : f("memory-local");
  }
  if (!tst) return undefined;
  return st.isFile() && tst.isFile() && sameBytes(path, target) ? f("forked") : f("diverged");
}

export function check(cfg: Config, only?: string): Finding[] {
  const shared = expand(cfg.shared);
  const out: Finding[] = [];
  for (const [name, rawDir] of Object.entries(cfg.profiles)) {
    if (only && name !== only) continue;
    const dir = expand(rawDir);
    if (!lstat(dir)) continue;
    for (const entry of cfg.link) {
      const f = checkEntry(name, join(dir, entry), join(shared, entry), false);
      if (f) out.push(f);
    }
    if (!cfg.shareMemory) continue;
    const projects = join(dir, "projects");
    if (!lstat(projects)) continue;
    for (const key of readdirSync(projects).sort()) {
      if (!lstat(join(projects, key))?.isDirectory()) continue;
      const f = checkEntry(name, join(projects, key, "memory"), join(shared, "memory", key), true);
      if (f) out.push(f);
    }
  }
  return out;
}

/** Apply the safe fixes. Returns the findings that still need a person. */
export function fix(findings: Finding[]): Finding[] {
  const left: Finding[] = [];
  for (const f of findings) {
    if (f.status === "ok") continue;
    if (!isFixable(f)) {
      left.push(f);
      continue;
    }
    try {
      if (f.status === "forked") unlinkSync(f.path);
      if (f.status === "memory-empty") rmdirSync(f.path);
      if (f.status === "memory-local") {
        mkdirSync(dirname(f.target), { recursive: true });
        renameSync(f.path, f.target);
      }
      mkdirSync(dirname(f.path), { recursive: true });
      symlinkSync(f.target, f.path);
    } catch {
      // Another session may have fixed it a moment ago; recheck before reporting.
      const again = checkEntry(f.profile, f.path, f.target, f.status.startsWith("memory"));
      if (again && again.status !== "ok") left.push(again);
    }
  }
  return left;
}

export const HINT: Record<Status, string> = {
  ok: "",
  missing: "not linked yet",
  forked: "a plain copy with identical content (an atomic save replaced the link)",
  diverged: "changed in this profile only; merge the change into the shared copy, then run `starling doctor --fix`",
  "wrong-link": "links somewhere other than the shared copy",
  "memory-local": "memory that only this profile has; --fix moves it into the shared store",
  "memory-empty": "an empty memory folder",
};
