import { normalizeLabel, TASK_STATUSES, type TaskSummary } from "@repo/contracts";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CircleCheckBigIcon,
  ClipboardCopyIcon,
  ListTodoIcon,
  MoveRightIcon,
  PlusIcon,
  SquareCheckIcon,
  StarIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { canStartProjectT3Thread } from "~/components/handoff/handoff.logic";
import { PlanTasksMenuItems } from "~/components/handoff/HandoffActions";
import { LabelChip, useLabelColors } from "~/components/labels/LabelChip";
import { labelCounts } from "~/components/labels/labels.logic";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { Input } from "~/components/ui/input";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemLabel,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "~/components/ui/menu";
import { useBoard } from "~/state/queries";
import { useDialogs } from "~/state/ui";
import { useBoardContext } from "./BoardContext";
import { useBulkActions } from "./bulkActions";
import {
  bulkArchive,
  bulkCloseable,
  bulkLabel,
  bulkLabelChoices,
  bulkMove,
  bulkPriority,
  bulkWontDo,
  taskCount,
} from "./bulkMenu.logic";
import { isPlannable } from "./boardSelection.logic";

/**
 * The card menu for two or more picked cards: the actions that make sense for many at once, each applying to the picked
 * cards it fits. An item that fits none is left out, so a pick that mixes, say, priority and other cards offers both Mark
 * and Remove, and a uniform one only the one that does something. Each runs the board's own mutations and ends in one summary toast.
 */
export function BulkMenuItems({ tasks }: { tasks: readonly TaskSummary[] }) {
  const actions = useBulkActions();
  const { projects, t3, settings } = useBoardContext();
  const plannable = tasks.filter(isPlannable);
  const plannableProjects = projects.filter((p) => plannable.some((t) => t.projectId === p.id));
  const closeable = bulkCloseable(tasks);
  const archive = bulkArchive(tasks, true);
  const unarchive = bulkArchive(tasks, false);
  const mark = bulkPriority(tasks, true);
  const unmark = bulkPriority(tasks, false);
  const wontDo = bulkWontDo(tasks);
  const moves = TASK_STATUSES.map((status) => ({ status, plan: bulkMove(tasks, status.value) }));

  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>{taskCount(tasks.length)}</MenuGroupLabel>
      </MenuGroup>
      {/* Epics and archived cards don't move; a pick of only those has nothing to offer here. */}
      {moves.some((m) => m.plan.move.length || m.plan.refused.length) ? (
        <MenuSub>
          <MenuSubTrigger>
            <MoveRightIcon />
            Move to
          </MenuSubTrigger>
          <MenuSubPopup>
            {moves.map(({ status, plan }) => {
              return (
                <MenuItem
                  key={status.value}
                  disabled={plan.move.length === 0}
                  onClick={() => void actions.move(tasks, status.value, status.label)}
                >
                  <MenuItemLabel>{status.label}</MenuItemLabel>
                  {plan.refused.length ? (
                    <span className="ms-auto ps-3 text-xs text-muted-foreground">
                      {plan.refused.length} without a plan
                    </span>
                  ) : null}
                </MenuItem>
              );
            })}
          </MenuSubPopup>
        </MenuSub>
      ) : null}
      {mark.length ? (
        <MenuItem onClick={() => void actions.setPriority(mark, true)}>
          <StarIcon />
          Mark as priority
        </MenuItem>
      ) : null}
      {unmark.length ? (
        <MenuItem onClick={() => void actions.setPriority(unmark, false)}>
          <StarIcon className="fill-current" />
          Remove priority
        </MenuItem>
      ) : null}
      {closeable.length ? (
        <MenuSub>
          <MenuSubTrigger>
            <CircleCheckBigIcon />
            Close as…
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuItem onClick={() => useDialogs.getState().openCloseTaskAs(closeable, "completed")}>
              <SquareCheckIcon />
              Done by another task…
            </MenuItem>
            {wontDo.length ? (
              <MenuItem onClick={() => void actions.wontDo(wontDo)}>
                <XIcon />
                Won&apos;t do
              </MenuItem>
            ) : null}
          </MenuSubPopup>
        </MenuSub>
      ) : null}
      {archive.length ? (
        <MenuItem onClick={() => void actions.archive(archive, true)}>
          <ArchiveIcon />
          Archive
        </MenuItem>
      ) : null}
      {unarchive.length ? (
        <MenuItem onClick={() => void actions.archive(unarchive, false)}>
          <ArchiveRestoreIcon />
          Unarchive
        </MenuItem>
      ) : null}
      <MenuSub>
        <MenuSubTrigger>
          <TagIcon />
          Labels
        </MenuSubTrigger>
        <MenuSubPopup>
          <LabelSub tasks={tasks} mode="add" />
          <LabelSub tasks={tasks} mode="remove" />
        </MenuSubPopup>
      </MenuSub>
      <MenuSeparator />
      <MenuItem onClick={() => actions.copyReferences(tasks)}>
        <ClipboardCopyIcon />
        Copy references
      </MenuItem>
      {/* The planning session covers one project's tasks, so a pick across projects offers each its own. */}
      {plannableProjects.length === 0 ? null : plannableProjects.length === 1 && plannableProjects[0] ? (
        <MenuSub>
          <MenuSubTrigger>
            <ListTodoIcon />
            Plan with an agent
          </MenuSubTrigger>
          <MenuSubPopup>
            <PlanTasksMenuItems
              project={plannableProjects[0]}
              canStartT3={canStartProjectT3Thread(plannableProjects[0], t3, settings)}
            />
          </MenuSubPopup>
        </MenuSub>
      ) : (
        plannableProjects.map((project) => (
          <MenuSub key={project.id}>
            <MenuSubTrigger>
              <ProjectFavicon title={project.title} icon={project.icon} className="size-4" />
              Plan with an agent in {project.title}
            </MenuSubTrigger>
            <MenuSubPopup>
              <PlanTasksMenuItems project={project} canStartT3={canStartProjectT3Thread(project, t3, settings)} />
            </MenuSubPopup>
          </MenuSub>
        ))
      )}
    </>
  );
}

/** "Add label" or "Remove label": the labels that fit some picked card, and for adding, a field to make a new one. */
function LabelSub({ tasks, mode }: { tasks: readonly TaskSummary[]; mode: "add" | "remove" }) {
  const actions = useBulkActions();
  const colors = useLabelColors();
  const board = useBoard().data;
  const [query, setQuery] = useState("");
  const inUse = labelCounts(board?.tasks ?? []).map((l) => l.name);
  const choices = bulkLabelChoices(tasks, inUse, mode);
  const normalized = normalizeLabel(query);
  const shown = normalized ? choices.filter((label) => label.includes(normalized)) : choices;
  const create =
    mode === "add" && normalized && !inUse.includes(normalized) && bulkLabel(tasks, normalized, "add").length > 0
      ? normalized
      : null;
  const empty = shown.length === 0 && !create;
  if (mode === "remove" && choices.length === 0) return null;

  return (
    <MenuSub>
      <MenuSubTrigger>
        {mode === "add" ? <PlusIcon /> : <XIcon />}
        {mode === "add" ? "Add label" : "Remove label"}
      </MenuSubTrigger>
      <MenuSubPopup>
        {mode === "add" ? (
          <div className="p-1">
            <Input
              size="sm"
              aria-label="Find or create a label"
              placeholder="Find or create a label"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              // Keys typed here are text, not menu navigation or typeahead.
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter" && (shown[0] ?? create)) {
                  event.preventDefault();
                  const label = create ?? shown[0]!;
                  void actions.setLabel(bulkLabel(tasks, label, "add"), label, "add");
                }
              }}
            />
          </div>
        ) : null}
        {create ? (
          <MenuItem onClick={() => void actions.setLabel(bulkLabel(tasks, create, "add"), create, "add")}>
            <PlusIcon />
            <MenuItemLabel>Create “{create}”</MenuItemLabel>
          </MenuItem>
        ) : null}
        {shown.map((label) => {
          const targets = bulkLabel(tasks, label, mode);
          return (
            <MenuItem key={label} onClick={() => void actions.setLabel(targets, label, mode)}>
              <LabelChip label={label} colors={colors} className="pointer-events-none" />
              <span className="ms-auto ps-3 text-xs text-muted-foreground">{targets.length}</span>
            </MenuItem>
          );
        })}
        {empty ? <div className="px-2 py-1.5 text-xs text-muted-foreground">No labels</div> : null}
      </MenuSubPopup>
    </MenuSub>
  );
}
