import { execFileSync } from "node:child_process";

/**
 * magpie (github.com/akshaykrishh/magpie) holds the work queued for agents; starling only reads
 * it, through magpie's CLI and the schema-1 contract in docs/integration.md. Anything other
 * than a clean, schema-1 answer means "not installed": callers show nothing extra.
 */

export interface MagpieItem {
  id: number;
  title: string;
  branch: string | null;
  position: number;
  lease: { session: string; pid: number; at: string } | null;
}

export interface MagpieQueue {
  project: { id: number; name: string } | null;
  items: MagpieItem[];
}

interface MagpieSession {
  pid: number;
  leased: { id: number; title: string } | null;
}

const bin = () => process.env.STARLING_MAGPIE || "magpie";
/** Hooks must stay quick; STARLING_MAGPIE_TIMEOUT_MS raises the limit on a slow machine. */
const timeout = () => Number(process.env.STARLING_MAGPIE_TIMEOUT_MS) || 2000;

/** Set once magpie is found missing, so one command doesn't look for it again per session. */
let missing = false;

function call<T>(args: string[]): T | undefined {
  if (missing) return undefined;
  try {
    const out = execFileSync(bin(), args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: timeout() });
    const j = JSON.parse(out);
    return j?.schema === 1 ? (j as T) : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") missing = true;
    return undefined;
  }
}

const queues = new Map<string, MagpieQueue | undefined>();

/** The items magpie has queued for this folder's project, limited to the branch when given. */
export function queueFor(cwd: string, branch?: string): MagpieQueue | undefined {
  const key = `${cwd}\0${branch ?? ""}`;
  if (!queues.has(key)) {
    const args = ["now", "--json", "--project", cwd, ...(branch ? ["--branch", branch] : [])];
    queues.set(key, call<MagpieQueue>(args));
  }
  return queues.get(key);
}

/** Items nobody has taken yet. */
export const open = (q: MagpieQueue | undefined) => (q?.items ?? []).filter((i) => !i.lease);

/**
 * What each Claude session is working on in magpie, keyed by the claude pid. magpie's MCP
 * server is a child of claude, so its parent pid is the pid starling records.
 */
export function leasesByClaudePid(): Map<number, string> {
  const out = new Map<number, string>();
  const live = call<{ sessions: MagpieSession[] }>(["sessions", "--json", "--live"])?.sessions ?? [];
  const leased = live.filter((s) => s.leased && s.pid);
  if (!leased.length) return out;
  let ps = "";
  try {
    ps = execFileSync("ps", ["-o", "pid=,ppid=", "-p", leased.map((s) => s.pid).join(",")], { encoding: "utf8", timeout: 2000 });
  } catch (e) {
    // ps exits 1 when some pids are gone but still prints the rest.
    ps = (e as { stdout?: string }).stdout ?? "";
  }
  const parent = new Map(ps.trim().split("\n").filter(Boolean).map((l) => l.trim().split(/\s+/).map(Number) as [number, number]));
  for (const s of leased) {
    const ppid = parent.get(s.pid);
    if (ppid) out.set(ppid, s.leased!.title);
  }
  return out;
}

/** Lines for a session's context or a handoff; empty when magpie has nothing (or isn't there). */
export function queueLines(cwd: string, branch?: string, max = 5): string[] {
  const q = queueFor(cwd, branch);
  if (!q?.project || !q.items.length) return [];
  const where = branch ? `${q.project.name} on \`${branch}\`` : q.project.name;
  const lines = [`- magpie: ${q.items.length} queued for ${where} (${open(q).length} not taken):`];
  for (const i of q.items.slice(0, max)) lines.push(`  - #${i.id} ${i.title}${i.lease ? " (taken by another session)" : ""}`);
  if (q.items.length > max) lines.push(`  - …and ${q.items.length - max} more (\`magpie list --now\`)`);
  return lines;
}
