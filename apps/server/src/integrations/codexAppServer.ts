import { StringDecoder } from "node:string_decoder";
import { BRAND } from "@repo/contracts";
import { spawnCli } from "./claudeCli.ts";
import { killTree, liveGroups } from "./processTree.ts";

// Asking Codex for its models over `codex app-server`, the JSON-RPC server Codex's own clients (and T3 Code) list
// models with: one JSON message per line on stdin and stdout. The server answers `initialize`, then `model/list` page by
// page, and doesn't exit on its own once it has, so the process is ended as soon as the last page is in, and on a
// timeout. Checked on codex-cli 0.166.0, which exits at end of stdin before answering a request still queued, so stdin
// stays open until the answers are in. See docs/features/agent-sessions.md.

/** The `result` of each `model/list` page, in order. */
export type CodexModelPages = unknown[];

/** More pages than any model list has: a server that keeps sending cursors is cut off rather than followed forever. */
const MAX_PAGES = 20;

/** How long `codex app-server` gets to exit after SIGTERM before it is killed. */
const FORCE_KILL_MS = 2000;

/**
 * Runs `<exe> app-server`, sends `initialize` and `initialized`, then asks `model/list` (following `nextCursor`) and
 * returns every page's `result`. Rejects when the process can't start, exits early, answers an error or takes longer
 * than `timeoutMs`; the process is always ended.
 */
export function codexModelPages(
  exe: string,
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; args?: readonly string[] },
): Promise<CodexModelPages> {
  const args = [...(opts.args ?? []), "app-server"];
  return new Promise((resolve, reject) => {
    const { child, group } = spawnCli(exe, args, opts);
    // The group stays tracked until the server has really exited, so a server that ignores SIGTERM is still ended
    // with the board; it gets SIGKILL if it outlives the grace period.
    let exited = false;
    let forceKill: NodeJS.Timeout | undefined;
    child.once("exit", () => {
      exited = true;
      clearTimeout(forceKill);
      if (group !== undefined) liveGroups.delete(group);
    });

    const pages: CodexModelPages = [];
    let nextId = 1;
    let pending: { id: number; method: string } | null = null;
    let settled = false;
    let stderr = "";

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (!exited) {
        killTree(child);
        forceKill = setTimeout(() => killTree(child, true), FORCE_KILL_MS);
        forceKill.unref();
      }
      if (error) reject(error);
      else resolve(pages);
    };
    const timer = setTimeout(
      () => finish(new Error(`Codex didn't list its models within ${Math.round(opts.timeoutMs / 1000)} seconds`)),
      opts.timeoutMs,
    );
    const send = (message: Record<string, unknown>) => {
      if (!child.stdin.writable) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method: string, params: Record<string, unknown>) => {
      pending = { id: nextId++, method };
      send({ id: pending.id, method, params });
    };

    const onMessage = (message: Record<string, unknown>) => {
      // Notifications (no id) and requests from the server (id and method) aren't answers to us.
      if (!pending || message.id !== pending.id || "method" in message) return;
      const { method } = pending;
      pending = null;
      if (message.error) {
        const reason = (message.error as { message?: unknown }).message;
        finish(new Error(`Codex refused ${method}: ${typeof reason === "string" ? reason : "no reason given"}`));
        return;
      }
      if (method === "initialize") {
        send({ method: "initialized" });
        request("model/list", {});
        return;
      }
      pages.push(message.result);
      const cursor = (message.result as { nextCursor?: unknown } | null)?.nextCursor;
      if (typeof cursor === "string" && cursor && pages.length < MAX_PAGES) request("model/list", { cursor });
      else finish(null);
    };

    const decoder = new StringDecoder("utf8");
    let partial = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const lines = (partial + decoder.write(chunk)).split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed && typeof parsed === "object") onMessage(parsed as Record<string, unknown>);
        } catch {
          // Not a protocol line (a warning on stdout): ignored.
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-2000)));
    child.on("error", (error) => finish(error));
    child.on("close", (code) =>
      finish(new Error(`codex app-server exited with code ${code}: ${stderr.trim().slice(0, 300) || "no output"}`)),
    );
    // A closed pipe after the process ended is reported by close.
    child.stdin.on("error", () => {});

    request("initialize", { clientInfo: { name: BRAND.id, title: BRAND.name, version: BRAND.version } });
  });
}
