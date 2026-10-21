import { attachmentUrl, storageKey, type ApiErrorBody, type ApiErrorCode, type TaskAttachment } from "@repo/contracts";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const TOKEN_KEY = storageKey("token");

/**
 * Token mode (server started with the `TOKEN` env var, see `brandEnv`): open the UI at `/#token=<token>`. The token is
 * moved into sessionStorage and the hash stripped so it doesn't linger in the address bar.
 * Call once before rendering.
 */
export function captureTokenFromHash(): void {
  const match = /^#token=(.+)$/.exec(window.location.hash);
  if (!match) return;
  sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(match[1]!));
  history.replaceState(history.state, "", window.location.pathname + window.location.search);
}

function authToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

/** The SSE stream URL; EventSource can't send headers, so the token rides in the query. */
export function eventsUrl(): string {
  const token = authToken();
  return token ? `/events?token=${encodeURIComponent(token)}` : "/events";
}

/** Where an `<img>` loads an attachment from; it can't send a header, so the token rides in the query. */
export function attachmentSrc(id: string): string {
  const token = authToken();
  return token ? `${attachmentUrl(id)}?token=${encodeURIComponent(token)}` : attachmentUrl(id);
}

/** Where an image found in a project's folder loads from, for an `<img>` or a fetch; the token rides in the query. */
export function iconCandidateSrc(projectId: string, path: string): string {
  const query = new URLSearchParams({ path });
  const token = authToken();
  if (token) query.set("token", token);
  return `/api/projects/${encodeURIComponent(projectId)}/icon-candidates/file?${query}`;
}

/** Uploads an image (the body is the file itself). `taskId` is null in the new-task box, whose task isn't created yet. */
export async function uploadAttachment(file: Blob, filename: string, taskId: string | null): Promise<TaskAttachment> {
  const token = authToken();
  const query = new URLSearchParams({ filename, ...(taskId ? { taskId } : {}) });
  const res = await fetch(`/api/attachments?${query}`, {
    method: "POST",
    headers: { "content-type": file.type, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: file,
  });
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (json as ApiErrorBody | null)?.error;
    throw new ApiError(
      err?.code ?? "INTERNAL",
      err?.message ?? `Upload failed (${res.status})`,
      res.status,
      err?.details,
    );
  }
  return json as TaskAttachment;
}

/** JSON fetch against the server. Throws ApiError with the server's error code. */
export async function api<T>(
  path: string,
  init?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const token = authToken();
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init?.signal,
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (json as ApiErrorBody | null)?.error;
    throw new ApiError(
      err?.code ?? "INTERNAL",
      err?.message ?? `Request failed (${res.status})`,
      res.status,
      err?.details,
    );
  }
  return json as T;
}
