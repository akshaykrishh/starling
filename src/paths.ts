import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Expand a leading ~ and make the path absolute. */
export function expand(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

/** Shorten a path under the home folder back to ~ for display and storage. */
export function tilde(p: string): string {
  const h = homedir();
  if (p === h) return "~";
  return p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}
