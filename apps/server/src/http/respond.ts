import { ACTOR_HEADER, type ApiErrorBody } from "@repo/contracts";
import type { Context } from "hono";
import { z } from "zod";
import { AppError, httpStatusFor } from "../errors.ts";

type Handler = (c: Context) => Response | Promise<Response>;

/** Maps any thrown error to the API error body and status. */
export function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof AppError) {
    const body: ApiErrorBody = { error: { code: error.code, message: error.message, details: error.details } };
    return c.json(body, httpStatusFor(error.code));
  }
  if (error instanceof z.ZodError) {
    const body: ApiErrorBody = { error: { code: "VALIDATION", message: "Invalid request", details: error.issues } };
    return c.json(body, 400);
  }
  console.error("[api] unhandled error", c.req.method, c.req.path, error);
  const body: ApiErrorBody = { error: { code: "INTERNAL", message: "Internal server error" } };
  return c.json(body, 500);
}

/** Wraps a route handler so thrown errors become API error responses. */
export const handle =
  (fn: Handler): Handler =>
  async (c) => {
    try {
      return await fn(c);
    } catch (error) {
      return errorResponse(c, error);
    }
  };

/** Parses the JSON body with `schema`; malformed JSON or schema mismatch → VALIDATION. */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new AppError("VALIDATION", "Request body must be valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION", "Invalid request body", parsed.error.issues);
  return parsed.data;
}

/** Parses query-string parameters with `schema`. */
export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw new AppError("VALIDATION", "Invalid query parameters", parsed.error.issues);
  return parsed.data;
}

/** Actor for REST writes: the `ACTOR_HEADER` header, else "user". */
export const actorOf = (c: Context): string => c.req.header(ACTOR_HEADER)?.trim() || "user";

export const noContent = (c: Context): Response => c.body(null, 204);

/** Query-string boolean: "1"/"true" → true. */
export const queryFlag = z
  .enum(["0", "1", "true", "false"])
  .optional()
  .transform((v) => v === "1" || v === "true");

/** The `:id` route parameter. */
export const idParam = (c: Context): string => c.req.param("id") ?? "";
