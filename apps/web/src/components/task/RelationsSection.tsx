import { TASK_STATUSES, type TaskDetail, type TaskRelation, type TaskSummary } from "@repo/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

import { matchesTaskSearch } from "~/components/board/board.logic";
import { useOpenTask } from "~/components/board/boardNavigation";
import { relationCandidates, type EdgeSide } from "~/components/board/dependencies.logic";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { useUpdateTask } from "~/state/mutations";
import { useBoard } from "~/state/queries";
import { PanelControl } from "./PanelControl";
import { TaskSection } from "./TaskSection";

const STATUS_LABEL = Object.fromEntries(TASK_STATUSES.map((s) => [s.value, s.label])) as Record<
  TaskSummary["status"],
  string
>;
/** The picker lists this many matches; typing narrows them. */
const PICKER_LIMIT = 30;

/**
 * What blocks this task and what it blocks, each with its status. A task is blocked while any blocker isn't Done.
 * Either list takes a task from the board (the picker leaves out what would make a loop) and has a × per row.
 * A relation is stored once, so adding to "Blocks" or removing from it edits the other task.
 */
export function RelationsSection({ task }: { task: TaskDetail }) {
  const { mutate: update } = useUpdateTask();
  const openTask = useOpenTask();
  // Archived tasks aren't on the board, but a relation to one still stands and can be removed.
  return (
    <TaskSection title="Relations">
      <div className="flex flex-col gap-2 px-1.5">
        <RelationGroup
          title="Blocked by"
          side="blockers"
          task={task}
          relations={task.blockedBy}
          emptyText="Nothing blocks this task."
          onOpen={(id) => void openTask(id)}
          onAdd={(id) => update({ id: task.id, addBlockedBy: [id] })}
          onRemove={(id) => update({ id: task.id, removeBlockedBy: [id] })}
        />
        <RelationGroup
          title="Blocks"
          side="dependents"
          task={task}
          relations={task.blocks}
          emptyText="This task doesn't hold anything up."
          onOpen={(id) => void openTask(id)}
          onAdd={(id) => update({ id, addBlockedBy: [task.id] })}
          onRemove={(id) => update({ id, removeBlockedBy: [task.id] })}
        />
      </div>
    </TaskSection>
  );
}

function RelationGroup({
  title,
  side,
  task,
  relations,
  emptyText,
  onOpen,
  onAdd,
  onRemove,
}: {
  title: string;
  side: EdgeSide;
  task: TaskDetail;
  relations: ReadonlyArray<TaskRelation>;
  emptyText: string;
  onOpen: (id: string) => void;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <section aria-label={title}>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h4 className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          {title} <span className="tabular-nums text-muted-foreground/70">{relations.length}</span>
        </h4>
        <AddRelationPopover task={task} side={side} onAdd={onAdd} />
      </div>
      {relations.length === 0 ? (
        <p className="px-1.5 pb-1 text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="flex flex-col">
          {relations.map((relation) => (
            <RelationRow key={relation.id} relation={relation} onOpen={onOpen} onRemove={onRemove} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RelationRow({
  relation,
  onOpen,
  onRemove,
}: {
  relation: TaskRelation;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <li className={cn("group/relation flex min-w-0 items-center gap-1 rounded-md", relation.archived && "opacity-60")}>
      <button
        type="button"
        onClick={() => onOpen(relation.id)}
        className="flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-start text-sm outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">#{relation.number}</span>
        <span className="min-w-0 truncate text-foreground/90">{relation.title}</span>
        <span className="ms-auto shrink-0 text-2xs text-muted-foreground">
          {STATUS_LABEL[relation.status]}
          {relation.archived ? " · archived" : ""}
        </span>
      </button>
      <Button
        variant="ghost-muted"
        size="icon-xs"
        className="shrink-0 opacity-0 group-hover/relation:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        aria-label={`Remove #${relation.number} ${relation.title}`}
        onClick={() => onRemove(relation.id)}
      >
        <XIcon />
      </Button>
    </li>
  );
}

function AddRelationPopover({ task, side, onAdd }: { task: TaskDetail; side: EdgeSide; onAdd: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const tasks = useBoard().data?.tasks;
  const options = useMemo(() => {
    if (!open || !tasks) return [];
    return relationCandidates(tasks, task.id, side)
      .filter((t) => matchesTaskSearch(t, query))
      .sort((a, b) => b.number - a.number)
      .slice(0, PICKER_LIMIT);
  }, [open, tasks, task.id, side, query]);
  const active = Math.min(highlight, options.length - 1);

  const add = (id: string) => {
    onAdd(id);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((active + step + options.length) % Math.max(options.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[active];
      if (option) add(option.id);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
        setHighlight(0);
      }}
    >
      <PopoverTrigger
        render={<PanelControl part="meta" />}
        aria-label={side === "blockers" ? "Add blocker" : "Add blocked task"}
      >
        <PlusIcon className="size-3.5" />
        Add
      </PopoverTrigger>
      <PopoverPopup align="end" width="sm" padding="compact">
        <div className="flex flex-col gap-2">
          <Input
            autoFocus
            aria-label="Find a task"
            size="sm"
            value={query}
            placeholder="Title or #number"
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
          />
          {options.length ? (
            <div role="listbox" aria-label="Tasks" className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
              {options.map((option, index) => (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={cn(
                    "flex min-h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-left text-xs text-muted-foreground outline-none",
                    index === active && "bg-accent text-accent-foreground",
                  )}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => add(option.id)}
                >
                  <span className="shrink-0 tabular-nums">#{option.number}</span>
                  <span className="min-w-0 truncate text-foreground/90">{option.title}</span>
                  <span className="ms-auto shrink-0 text-2xs">{STATUS_LABEL[option.status]}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="px-1.5 text-xs text-muted-foreground">
              {query ? "No task matches." : "No other task can be added."}
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
