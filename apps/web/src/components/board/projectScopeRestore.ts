import { useProjectScope } from "~/state/ui";
import { createBoardRestorer } from "./projectScope.logic";

/** The scope to put on the board the first time it is shown in this page load, if it is bare. */
export const restoreBoardScope = createBoardRestorer(() => useProjectScope.getState().projectIds);
