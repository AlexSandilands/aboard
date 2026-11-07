import {
  describeWhere,
  whereInput,
  type AutopilotAutomation,
  type WhereDescription,
  type WhereInput,
} from "@repo/contracts";
import { useMemo } from "react";
import { useApplyWhere } from "~/state/mutations";
import { useAutopilotModes, useBoard } from "~/state/queries";
import { whereScopes, type WhereScopes } from "./where.logic";

export interface WhereState {
  /** Null until the switches and the board have loaded, so nothing shows a made-up Off. */
  input: WhereInput | null;
  description: WhereDescription | null;
  scopes: WhereScopes | null;
  apply: ReturnType<typeof useApplyWhere>;
  /** The switches query's error, so a failed load can say so instead of staying a skeleton. */
  error: Error | null;
}

/** One automation's modes at every scope, read as the Where it runs widget needs them, and the way to save an edit. */
export function useWhere(automation: Pick<AutopilotAutomation, "key" | "epicScope">): WhereState {
  const modes = useAutopilotModes();
  const board = useBoard();
  const apply = useApplyWhere(automation.key);
  const scopes = useMemo(() => whereScopes(board.data, automation.epicScope), [board.data, automation.epicScope]);
  const input = useMemo(
    () => (modes.data && scopes ? whereInput(modes.data, automation.key, scopes.projects, scopes.epics) : null),
    [modes.data, scopes, automation.key],
  );
  const description = useMemo(() => (input ? describeWhere(input) : null), [input]);
  return { input, description, scopes, apply, error: modes.error ?? board.error ?? null };
}
