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
 * cards it fits. An item that fits none is disabled. Each runs the board's own mutations and ends in one summary toast.
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

  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>{taskCount(tasks.length)}</MenuGroupLabel>
      </MenuGroup>
      <MenuSub>
        <MenuSubTrigger>
          <MoveRightIcon />
          Move to
        </MenuSubTrigger>
        <MenuSubPopup>
          {TASK_STATUSES.map((status) => {
            const plan = bulkMove(tasks, status.value);
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
      <MenuItem disabled={mark.length === 0} onClick={() => void actions.setPriority(mark, true)}>
        <StarIcon />
        Mark as priority
      </MenuItem>
      <MenuItem disabled={unmark.length === 0} onClick={() => void actions.setPriority(unmark, false)}>
        <StarIcon />
        Remove priority
      </MenuItem>
      <MenuSub>
        <MenuSubTrigger disabled={closeable.length === 0}>
          <CircleCheckBigIcon />
          Close as…
        </MenuSubTrigger>
        <MenuSubPopup>
          <MenuItem onClick={() => useDialogs.getState().openCloseTaskAs(closeable, "completed")}>
            <SquareCheckIcon />
            Done by another task…
          </MenuItem>
          <MenuItem disabled={wontDo.length === 0} onClick={() => void actions.wontDo(wontDo)}>
            <XIcon />
            Won&apos;t do
          </MenuItem>
        </MenuSubPopup>
      </MenuSub>
      <MenuItem disabled={archive.length === 0} onClick={() => void actions.archive(archive, true)}>
        <ArchiveIcon />
        Archive
      </MenuItem>
      <MenuItem disabled={unarchive.length === 0} onClick={() => void actions.archive(unarchive, false)}>
        <ArchiveRestoreIcon />
        Unarchive
      </MenuItem>
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
      {plannableProjects.length <= 1 ? (
        <MenuSub>
          <MenuSubTrigger disabled={plannableProjects.length === 0}>
            <ListTodoIcon />
            Plan with an agent
          </MenuSubTrigger>
          <MenuSubPopup>
            {plannableProjects[0] ? (
              <PlanTasksMenuItems
                project={plannableProjects[0]}
                canStartT3={canStartProjectT3Thread(plannableProjects[0], t3, settings)}
              />
            ) : null}
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

  return (
    <MenuSub>
      <MenuSubTrigger disabled={mode === "remove" && choices.length === 0}>
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
