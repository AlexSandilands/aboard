import { BRAND, Health } from "@repo/contracts";

/** True when a `/api/health` body comes from our server, not some other app holding the port. */
export function isOwnHealth(body: unknown): boolean {
  const parsed = Health.safeParse(body);
  return parsed.success && parsed.data.id === BRAND.id;
}

/** Schemes we hand to the OS. Anything else (file:, javascript:, ms-* handlers…) is dropped. */
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "t3code:"]);

export type NavigationDecision = "allow" | "external" | "block";

/** Board pages stay in the window; links elsewhere (PRs, Jira, T3 Code threads) go to the OS. */
export function decideNavigation(target: string, boardUrl: string): NavigationDecision {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "block";
  }
  if (url.origin === new URL(boardUrl).origin) return "allow";
  return EXTERNAL_PROTOCOLS.has(url.protocol) ? "external" : "block";
}

/** Keeps the last `max` lines of a stream of output chunks, for error reports. */
export class LogTail {
  private lines: string[] = [];
  private partial = "";

  constructor(private readonly max = 40) {}

  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    this.lines.push(...parts);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }

  toString(): string {
    return [...this.lines, this.partial].filter(Boolean).join("\n");
  }
}
