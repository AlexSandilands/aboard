import type { TaskSummary } from "@repo/contracts";
import { GitMergeIcon, PlaneIcon, ScanSearchIcon } from "lucide-react";
import { Fragment } from "react";

import { MenuItem } from "~/components/ui/menu";
import { useBoardContext } from "./BoardContext";
import { useBulkActions } from "./bulkActions";
import { bulkAutoMerge, bulkAutopilot, bulkAutoReview } from "./bulkMenu.logic";

/**
 * "Turn Autopilot / auto-merge / auto-review on / off" for one card or several picked ones. Each item applies to the
 * cards it would change and is left out when that is none, so a card shows only the item that does something and a
 * mixed pick shows both. Epics, manual and archived cards never match (see `automationEligible`), so the items
 * disappear for them. Labels follow the panel's Automation section.
 */
export function AutomationMenuItems({ tasks }: { tasks: readonly TaskSummary[] }) {
  const actions = useBulkActions();
  const globalReview = useBoardContext().settings?.autoReview ?? false;
  const rows = [
    {
      name: "Autopilot",
      icon: <PlaneIcon />,
      on: bulkAutopilot(tasks, true),
      off: bulkAutopilot(tasks, false),
      set: actions.setAutopilot,
    },
    {
      name: "auto-merge",
      icon: <GitMergeIcon />,
      on: bulkAutoMerge(tasks, true),
      off: bulkAutoMerge(tasks, false),
      set: actions.setAutoMerge,
    },
    {
      name: "auto-review",
      icon: <ScanSearchIcon />,
      on: bulkAutoReview(tasks, true, globalReview),
      off: bulkAutoReview(tasks, false, globalReview),
      set: actions.setAutoReview,
    },
  ];
  return (
    <>
      {rows.map((row) => (
        <Fragment key={row.name}>
          {row.on.length ? (
            <MenuItem onClick={() => void row.set(row.on, true)}>
              {row.icon}
              Turn {row.name} on
            </MenuItem>
          ) : null}
          {row.off.length ? (
            <MenuItem onClick={() => void row.set(row.off, false)}>
              {row.icon}
              Turn {row.name} off
            </MenuItem>
          ) : null}
        </Fragment>
      ))}
    </>
  );
}
