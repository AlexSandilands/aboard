import type { ApiErrorCode } from "@taskboard/contracts";

/** Typed domain error. HTTP routes and MCP tools map it to a response; anything else is INTERNAL. */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string, id: string) => new AppError("NOT_FOUND", `${what} not found: ${id}`);

export const planRequired = (taskNumber: number) =>
  new AppError(
    "PLAN_REQUIRED",
    `Task #${taskNumber} has no plan. Only ideas may exist without a plan — add at least one plan step (set_plan) before moving it out of Ideas.`,
  );

export function httpStatusFor(code: ApiErrorCode): 400 | 404 | 409 | 422 | 500 {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "VALIDATION":
      return 400;
    case "CONFLICT":
      return 409;
    case "PLAN_REQUIRED":
      return 422;
    case "INTERNAL":
      return 500;
  }
}
