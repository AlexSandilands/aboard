// The Operations list on the Models page: its groups, each operation's description, and the rows its picker offers at
// board level. Which model an operation runs on is #74's resolver (packages/contracts/src/operations.ts).
import {
  INHERIT,
  OPERATIONS,
  type ModelChoice,
  type OperationId,
  type OperationModels,
  type OperationSettings,
} from "@repo/contracts";
import { inheritDetail } from "./choicePicker.logic";

export interface OperationGroup {
  id: "review" | "autopilot" | "board";
  title: string;
  operations: readonly OperationId[];
}

/** The page's groups, in order; every operation is in one. */
export const OPERATION_GROUPS: readonly OperationGroup[] = [
  { id: "review", title: "Review", operations: ["reviewer", "boardReviewer", "prReview", "prFix"] },
  {
    id: "autopilot",
    title: "Autopilot",
    operations: ["taskRun", "orchestrate", "digest", "customTask", "customDetached"],
  },
  { id: "board", title: "Board tools", operations: ["launch", "issueImport", "ask"] },
];

/** What each operation is, in a line under its name. */
export const OPERATION_DESCRIPTIONS: Record<OperationId, string> = {
  taskRun: "Autopilot's agent working on a task: Start planned tasks, Unstick and Orchestrate's restarts.",
  launch: "A new T3 Code thread or CLI session started from a task's hand-off menu.",
  reviewer: "The subagent the implementing agent starts for a local review round.",
  boardReviewer: "The board's own read-only review, for a round no agent picks up.",
  prReview: "Review PRs: reads a pull request and posts its review on GitHub.",
  prFix: "Fix PRs: works on a pull request's failed checks, conflicts and review comments.",
  orchestrate: "Orchestrate's check over a project's work every few minutes.",
  digest: "The digest written by an agent.",
  customTask: "A custom automation's agent that works on a task.",
  customDetached: "A custom automation's agent that runs on a schedule, with no task.",
  issueImport: "Fills in a task pasted as a ticket or GitHub issue URL.",
  ask: "The Ask box in settings search.",
};

/** The settings target of an operation's row. */
export const operationTarget = (op: OperationId) => `models.operations.${op}`;

/** The board's models without one operation's, so its default shows through. */
const withoutBoard = (settings: OperationSettings, op: OperationId): OperationSettings => {
  const { [op]: _gone, ...rest } = settings.operationModels;
  return { ...settings, operationModels: rest };
};

/**
 * The rows a board-level picker offers above the tiers. Default (nothing saved) takes the operation's default. An
 * operation on a task whose default is a tier also offers the task's own model, saved as inherit; for the others,
 * inherit is what Default already is, so it isn't offered twice.
 */
export function boardPickerRows(
  op: OperationId,
  settings: OperationSettings,
): {
  unset: { label: string; detail: string | null };
  inherit: { label: string; detail: string | null } | null;
} {
  const info = OPERATIONS[op];
  const unset = { label: "Default", detail: inheritDetail(op, {}, withoutBoard(settings, op)) };
  const inherit =
    info.taskScoped && info.default !== INHERIT
      ? { label: "The task's own model", detail: "Its label's or tier's" }
      : null;
  return { unset, inherit };
}

/** The value a board-level picker shows: what is saved, with inherit read as Default where that is what it means. */
export function boardPickerValue(op: OperationId, models: OperationModels): ModelChoice | null {
  const saved = models[op] ?? null;
  if (saved === INHERIT && !(OPERATIONS[op].taskScoped && OPERATIONS[op].default !== INHERIT)) return null;
  return saved;
}

/** What saving a pick sends: null removes the board's setting, so the operation's default applies. */
export const boardUpdate = (
  op: OperationId,
  next: ModelChoice | null,
): Partial<Record<OperationId, ModelChoice | null>> => ({ [op]: next });
