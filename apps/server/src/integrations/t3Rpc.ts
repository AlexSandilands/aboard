import { z } from "zod";
import { messageOf } from "./github.ts";
import type { FetchFn } from "./t3.ts";

// A one-shot client for T3 Code's WebSocket RPC (Effect RPC with JSON serialization). T3 has no HTTP
// endpoint for writes, so starting a thread has to go through the socket its own web client uses.
// This is not a public API; see docs/features/agent-handoff.md.

const REQUEST_TIMEOUT_MS = 30_000;
const TICKET_TIMEOUT_MS = 5_000;

/** The subset of the WHATWG WebSocket this client needs; a seam for tests. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}
export type OpenSocket = (url: string) => SocketLike;

const defaultOpenSocket: OpenSocket = (url) => new WebSocket(url);

export type T3RpcErrorKind = "unreachable" | "unauthorized" | "forbidden" | "failed" | "protocol";

export class T3RpcError extends Error {
  constructor(
    readonly kind: T3RpcErrorKind,
    message: string,
    /** The typed error T3 returned, e.g. `{_tag: "EnvironmentAuthorizationError", requiredScope}`. */
    readonly error?: unknown,
  ) {
    super(message);
  }
}

// Effect tags its unions with `_tag`; the schemas rename it to `tag` on parse.
const Exit = z
  .object({
    _tag: z.literal("Exit"),
    requestId: z.union([z.string(), z.number()]).transform(String),
    exit: z.object({
      _tag: z.enum(["Success", "Failure"]),
      value: z.unknown().optional(),
      cause: z.unknown().optional(),
    }),
  })
  .transform(({ requestId, exit: { _tag: tag, value, cause } }) => ({ requestId, exit: { tag, value, cause } }));

const FailureCause = z.array(
  z
    .object({ _tag: z.string(), error: z.unknown().optional(), defect: z.unknown().optional() })
    .transform(({ _tag: tag, error, defect }) => ({ tag, error, defect })),
);

/** Session-level failures (no requestId): every pending request is dead. */
const SessionFailure = z
  .object({
    _tag: z.enum(["Defect", "ClientProtocolError"]),
    defect: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .transform(({ defect, error }) => defect ?? error);

const TaggedError = z
  .object({ _tag: z.string(), message: z.string().optional(), requiredScope: z.unknown().optional() })
  .transform(({ _tag: tag, message, requiredScope }) => ({ tag, message, requiredScope }));

/** Turns an Exit failure cause into an error: typed failures keep their payload, defects are protocol errors. */
export function failureToError(cause: unknown): T3RpcError {
  const parts = FailureCause.safeParse(cause);
  const items = parts.success ? parts.data : [];
  const fail = items.find((item) => item.tag === "Fail");
  if (fail) {
    const tagged = TaggedError.safeParse(fail.error);
    if (tagged.success && tagged.data.tag === "EnvironmentAuthorizationError") {
      const scope = tagged.data.requiredScope;
      return new T3RpcError(
        "forbidden",
        typeof scope === "string"
          ? `The T3 Code token lacks the ${scope} scope`
          : "The T3 Code token isn't allowed to do this",
        fail.error,
      );
    }
    return new T3RpcError(
      "failed",
      tagged.success ? (tagged.data.message ?? tagged.data.tag) : "T3 Code refused the request",
      fail.error,
    );
  }
  const die = items.find((item) => item.tag === "Die");
  const detail = die ? (typeof die.defect === "string" ? die.defect : JSON.stringify(die.defect)) : "unknown failure";
  return new T3RpcError("protocol", `T3 Code rejected the request (its protocol may have changed): ${detail}`);
}

export interface T3RpcSession {
  request<T = unknown>(tag: string, payload: unknown): Promise<T>;
  close(): void;
}

/** Exchanges the bearer token for a short-lived WebSocket ticket. */
async function fetchTicket(origin: string, token: string, fetchFn: FetchFn): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(`${origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
      signal: AbortSignal.timeout(TICKET_TIMEOUT_MS),
    });
  } catch (error) {
    throw new T3RpcError("unreachable", `T3 Code unreachable: ${messageOf(error)}`);
  }
  if (response.status === 401) throw new T3RpcError("unauthorized", "T3 Code rejected the token");
  if (!response.ok) throw new T3RpcError("protocol", `T3 Code returned HTTP ${response.status} for a WebSocket ticket`);
  const body = z.object({ ticket: z.string().min(1) }).safeParse(await response.json().catch(() => null));
  if (!body.success) throw new T3RpcError("protocol", "Unexpected WebSocket ticket response from T3 Code");
  return body.data.ticket;
}

/** Opens an authenticated RPC session. Requests are sent one frame each and resolve on their Exit frame. */
export async function openT3Rpc(opts: {
  origin: string;
  token: string;
  fetch: FetchFn;
  openSocket?: OpenSocket;
  timeoutMs?: number;
}): Promise<T3RpcSession> {
  const ticket = await fetchTicket(opts.origin, opts.token, opts.fetch);
  const url = `${opts.origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`;
  const socket = (opts.openSocket ?? defaultOpenSocket)(url);
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let closed: T3RpcError | null = null;
  let nextId = 1;

  const failAll = (error: T3RpcError) => {
    closed ??= error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  const closeSocket = () => {
    try {
      socket.close();
    } catch {
      // Already closing.
    }
  };

  await new Promise<void>((resolve, reject) => {
    // A failed handshake still closes the socket, so a late open can't leave an authenticated socket behind.
    const fail = (message: string) => {
      clearTimeout(timer);
      closeSocket();
      reject(new T3RpcError("unreachable", message));
    };
    const timer = setTimeout(() => fail("Timed out connecting to T3 Code"), timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => fail("Could not open a WebSocket to T3 Code"));
  });

  socket.addEventListener("close", () => failAll(new T3RpcError("unreachable", "T3 Code closed the connection")));
  socket.addEventListener("message", (event) => {
    let frames: unknown;
    try {
      frames = JSON.parse(String(event.data));
    } catch {
      return;
    }
    for (const frame of Array.isArray(frames) ? frames : [frames]) {
      const failure = SessionFailure.safeParse(frame);
      if (failure.success) {
        const detail = typeof failure.data === "string" ? failure.data : JSON.stringify(failure.data ?? "unknown");
        failAll(new T3RpcError("protocol", `T3 Code rejected the session (its protocol may have changed): ${detail}`));
        closeSocket();
        return;
      }
      const exit = Exit.safeParse(frame);
      if (!exit.success) continue;
      const entry = pending.get(exit.data.requestId);
      if (!entry) continue;
      pending.delete(exit.data.requestId);
      if (exit.data.exit.tag === "Success") entry.resolve(exit.data.exit.value);
      else entry.reject(failureToError(exit.data.exit.cause));
    }
  });

  return {
    request<T>(tag: string, payload: unknown): Promise<T> {
      if (closed) return Promise.reject(closed);
      const id = String(nextId++);
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new T3RpcError("unreachable", `T3 Code didn't answer ${tag} in time`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value as T);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      });
    },
    close() {
      failAll(new T3RpcError("unreachable", "Session closed"));
      closeSocket();
    },
  };
}
