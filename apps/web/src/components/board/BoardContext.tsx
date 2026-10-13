import type { AppSettings, T3IntegrationStatus } from "@taskboard/contracts";
import { createContext, use, type RefObject } from "react";

/**
 * Board-wide values cards need but that rarely change. Kept out of card props so memoized
 * cards only re-render when their own task object or selection changes.
 */
export interface BoardContextValue {
  openTask: (taskId: string) => void;
  /** Set while a drag finishes so the click that ends it does not open the panel. */
  suppressClickRef: RefObject<boolean>;
  t3: T3IntegrationStatus;
  settings: AppSettings | undefined;
}

export const BoardContext = createContext<BoardContextValue | null>(null);

export function useBoardContext(): BoardContextValue {
  const value = use(BoardContext);
  if (!value) throw new Error("useBoardContext must be used inside <Board>.");
  return value;
}
