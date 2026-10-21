import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import type { Config } from "./config.js";
import { expand, tilde } from "./paths.js";
import { projectName } from "./yard.js";

/**
 * over-limit   more files or index lines than the limits; only the start of the index loads
 * unindexed    a memory file MEMORY.md does not list, so it never loads
 * dangling     an index entry for a file that is gone
 * no-header    no name/description frontmatter, so recall cannot judge relevance
 * status       a name that records work in progress; that belongs in an issue, PR or handoff
 * stale-path   names a file in the repo (or home folder) that no longer exists
 * overlap      two memories describe nearly the same thing; merge them
 */
export type Kind = "over-limit" | "unindexed" | "dangling" | "no-header" | "status" | "stale-path" | "overlap";

export interface Issue {
  kind: Kind;
  file?: string;
  detail: string;
}

export interface StoreReport {
  dir: string;
  project: string;
  /** The folder the project's sessions ran in, if a transcript says so. */
  root?: string;
  files: number;
  indexLines: number;
  issues: Issue[];
}

/** Only as the last word: "release-pending" records status, "empty-state-ui" and "no-status-guard" are topics. */
const STATUS_WORDS = new Set(["state", "status", "pending", "progress", "todo", "wip", "handoff", "next", "blocked"]);

interface Memory {
  file: string;
  name?: string;
  description?: string;
  body: string;
}

function parse(path: string): Memory {
  // Files written on Windows (or by tools that use CRLF) must parse the same way.
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  const head = m?.[1] ?? "";
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(head)?.[1].trim();
  return { file: basename(path), name: field("name"), description: field("description"), body: m ? m[2] : text };
}

/** Claude Code names a project folder after its cwd with every non-alphanumeric turned into "-". */
const keyOf = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** The project's own folder, read from one of its transcripts. */
function rootFor(cfg: Config, key: string): string | undefined {
  for (const dir of Object.values(cfg.profiles)) {
    const projects = join(expand(dir), "projects", key);
    let names: string[];
    try {
      names = readdirSync(projects).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of names) {
      const buf = Buffer.alloc(65_536);
      let n = 0;
      try {
        const fd = openSync(join(projects, f), "r");
        n = readSync(fd, buf, 0, buf.length, 0);
        closeSync(fd);
      } catch {
        continue;
      }
      for (const m of buf.subarray(0, n).toString("utf8").matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
        const cwd = JSON.parse(`"${m[1]}"`) as string;
        if (keyOf(cwd) === key) return cwd;
      }
    }
  }
  return undefined;
}

/**
 * Backticked text that is plainly a file path. Relative paths count only when their first folder
 * exists in the project, so API routes and module names are not mistaken for files.
 */
function pathsIn(body: string, root: string | undefined): string[] {
  const out = new Set<string>();
  for (const [, span] of body.matchAll(/`([^`\s]+)`/g)) {
    // ./x and ../x are relative to whichever file mentions them, not to the project root.
    if (!span.includes("/") || span.includes("...") || span.startsWith("./") || span.startsWith("../") || /[?=*<>$|{}():@]/.test(span)) continue;
    if (span.startsWith("~/") || span.startsWith(homedir() + "/")) out.add(expand(span));
    else if (!isAbsolute(span) && root && existsSync(join(root, span.split("/")[0]))) out.add(join(root, span));
  }
  return [...out];
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));

function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

export function lintStore(cfg: Config, dir: string): StoreReport {
  // A shared store is named after the project; a profile's own is projects/<key>/memory.
  const key = basename(dir) === "memory" ? basename(dirname(dir)) : basename(dir);
  const root = rootFor(cfg, key);
  const names = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").sort();
  let index = "";
  try {
    index = readFileSync(join(dir, "MEMORY.md"), "utf8");
  } catch {}
  const indexLines = index.split("\n").filter(Boolean).length;
  const issues: Issue[] = [];
  const { memoryFiles, memoryIndexLines } = cfg.limits;

  if (names.length > memoryFiles) issues.push({ kind: "over-limit", detail: `${names.length} files (limit ${memoryFiles})` });
  if (indexLines > memoryIndexLines)
    issues.push({ kind: "over-limit", detail: `MEMORY.md has ${indexLines} lines (limit ${memoryIndexLines}); later ones never load` });

  const linked = new Set([...index.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]));
  for (const f of linked) if (!names.includes(f)) issues.push({ kind: "dangling", file: "MEMORY.md", detail: `lists ${f}, which is gone` });

  const mems = names.map((f) => parse(join(dir, f)));
  for (const m of mems) {
    if (!linked.has(m.file)) issues.push({ kind: "unindexed", file: m.file, detail: "not in MEMORY.md, so it never loads" });
    if (!m.name || !m.description) issues.push({ kind: "no-header", file: m.file, detail: "no name/description frontmatter" });
    const slug = (m.name ?? m.file.replace(/\.md$/, "")).toLowerCase().split(/[^a-z0-9]+/);
    const last = slug.filter(Boolean).at(-1) ?? "";
    const hit = STATUS_WORDS.has(last) ? last : undefined;
    if (hit) issues.push({ kind: "status", file: m.file, detail: `"${hit}" in the name: work in progress belongs in an issue, PR or handoff` });
    for (const p of pathsIn(m.body, root)) {
      if (!existsSync(p)) issues.push({ kind: "stale-path", file: m.file, detail: `names ${root && !relative(root, p).startsWith("..") ? relative(root, p) : tilde(p)}, which no longer exists` });
    }
  }

  const sets = mems.map((m) => words(`${m.name ?? ""} ${m.description ?? ""}`));
  for (let i = 0; i < mems.length; i++) {
    for (let j = i + 1; j < mems.length; j++) {
      if (similarity(sets[i], sets[j]) >= 0.5)
        issues.push({ kind: "overlap", file: mems[i].file, detail: `may cover the same ground as ${mems[j].file}; merge them if so` });
    }
  }

  return { dir, project: projectName(key), root, files: names.length, indexLines, issues };
}

/** Every memory store: the shared ones, plus any profile's own that is not a link into them. */
export function memoryStores(cfg: Config): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (d: string) => {
    try {
      const real = realpathSync(d);
      if (seen.has(real)) return;
      seen.add(real);
      out.push(d);
    } catch {}
  };
  const subdirs = (p: string) => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => join(p, d.name));
    } catch {
      return [];
    }
  };
  if (cfg.shareMemory) for (const d of subdirs(join(expand(cfg.shared), "memory"))) add(d);
  for (const dir of Object.values(cfg.profiles)) {
    for (const p of subdirs(join(expand(dir), "projects"))) if (existsSync(join(p, "memory"))) add(join(p, "memory"));
  }
  return out.sort();
}
