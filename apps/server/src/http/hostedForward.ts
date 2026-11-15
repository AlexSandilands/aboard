import type { Hono } from "hono";
import type { CallNames, HostedRunner } from "../hostedRunner.ts";

// Calls on this board that belong to the runner it hosts for another board (hostedRunner.ts): agents on this machine
// call the board's 127.0.0.1 address for both, so the board hands on what names a task the runner holds. They have
// passed this board's guard already; the runner's checks them again as a local request.

/** Request headers a hop sets for itself. */
const HOP_HEADERS = ["host", "connection", "content-length", "origin", "keep-alive", "transfer-encoding"];
/** Response headers that described the bytes fetch has already decoded. */
const DECODED_HEADERS = ["content-encoding", "content-length", "transfer-encoding", "connection"];

/** Sends `request` (with `body`, read already) to the same path on the runner at `base`, and returns its answer. */
export async function forwardToRunner(base: string, request: Request, body?: string): Promise<Response> {
  const from = new URL(request.url);
  const to = new URL(`${from.pathname}${from.search}`, base);
  const headers = new Headers(request.headers);
  for (const name of HOP_HEADERS) headers.delete(name);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const res = await fetch(to, {
    method: request.method,
    headers,
    redirect: "manual",
    ...(hasBody ? { body: body ?? (await request.arrayBuffer()) } : {}),
  });
  const out = new Headers(res.headers);
  for (const name of DECODED_HEADERS) out.delete(name);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

type Args = Record<string, unknown>;

const strings = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];

/** What a tool call's arguments name: the tasks, folders and projects that tell whose it is. */
export function callNames(args: Args): CallNames {
  const session = args.agentSession as { cwd?: unknown } | undefined;
  return {
    tasks: [...strings(args.task), ...strings(args.epic), ...strings(args.tasks)],
    paths: [...strings(args.workspacePath), ...strings(args.moveToWorkspacePath), ...strings(session?.cwd)],
    projectIds: [...strings(args.projectId), ...strings(args.moveToProjectId)],
  };
}

interface JsonRpcCall {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown };
}

/**
 * The answer to a call on this board's `/mcp` that isn't the board's, or null to run it here: a tool call about a
 * task the runner holds goes to the runner; one whose task number names a task on each is refused, with both ids.
 */
export async function routeMcpCall(hosted: HostedRunner, request: Request): Promise<Response | null> {
  if (!hosted.running()) return null;
  const text = await request.clone().text();
  let call: JsonRpcCall;
  try {
    call = JSON.parse(text) as JsonRpcCall;
  } catch {
    return null;
  }
  if (!call || typeof call !== "object" || Array.isArray(call) || call.method !== "tools/call") return null;
  const args = call.params?.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const route = hosted.route(callNames(args as Args));
  if (route.to === "board") return null;
  if (route.to === "runner") return forwardToRunner(route.url, request, text);
  return Response.json({
    jsonrpc: "2.0",
    id: call.id ?? null,
    result: { content: [{ type: "text", text: route.message }], isError: true },
  });
}

/**
 * The REST routes of a task, for a task the runner holds: a script on this machine working for the other board reads
 * and changes it through the board's address as an agent does. Never a browser's: the board's own pages show only
 * its own tasks.
 */
export function registerHostedRunnerForwarding(app: Hono, hosted: HostedRunner): void {
  const forward = async (c: Parameters<Parameters<Hono["use"]>[1]>[0], next: () => Promise<void>) => {
    const ref = c.req.param("ref");
    if (!ref || c.req.header("origin") !== undefined) return next();
    const route = hosted.route({ tasks: [ref], paths: [], projectIds: [] });
    if (route.to !== "runner") return next();
    return forwardToRunner(route.url, c.req.raw);
  };
  app.use("/api/tasks/:ref", forward);
  app.use("/api/tasks/:ref/*", forward);
}
