import type { Project, TaskDetail } from "@taskboard/contracts";
import {
  ArchiveIcon,
  ArrowRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  DotIcon,
  FolderInputIcon,
  LinkIcon,
  ListTodoIcon,
  MessageSquareTextIcon,
  PencilIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Markdown } from "~/components/markdown/Markdown";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { Input } from "~/components/ui/input";
import { formatElapsedDurationLabel } from "~/lib/timestampFormat";
import { useAddNote } from "~/state/mutations";
import { describeEvent, type ActivityIcon } from "./activity.logic";
import { stepIndexLabels } from "./plan.logic";

const ICON_CLASS = "size-3.5 text-muted-foreground/70";

const ICONS: Record<ActivityIcon, ReactNode> = {
  created: <SparklesIcon className={ICON_CLASS} />,
  status: <ArrowRightIcon className={ICON_CLASS} />,
  edit: <PencilIcon className={ICON_CLASS} />,
  note: <MessageSquareTextIcon className="size-3.5 text-info" />,
  plan: <ListTodoIcon className={ICON_CLASS} />,
  step_done: <CircleCheckIcon className="size-3.5 text-success" />,
  step_started: <CircleDotIcon className="size-3.5 text-primary" />,
  step_blocked: <CircleAlertIcon className="size-3.5 text-warning" />,
  step: <CircleIcon className={ICON_CLASS} />,
  link: <LinkIcon className={ICON_CLASS} />,
  archive: <ArchiveIcon className={ICON_CLASS} />,
  project: <FolderInputIcon className={ICON_CLASS} />,
  delete: <Trash2Icon className={ICON_CLASS} />,
  other: <DotIcon className={ICON_CLASS} />,
};

/** Handover input plus the task's event log, newest first (T3 WorkLog line style). */
export function ActivityLog({ task, projects }: { task: TaskDetail; projects: ReadonlyArray<Project> }) {
  const [expanded, setExpanded] = useState(task.events.length === 0);
  const lines = useMemo(() => {
    const ctx = {
      steps: stepIndexLabels(task.phases),
      projectTitle: (id: string) => projects.find((p) => p.id === id)?.title,
    };
    return [...task.events].reverse().map((event) => ({ event, line: describeEvent(event, ctx) }));
  }, [task.events, task.phases, projects]);

  return (
    <section className="border-t border-border/65 px-2 pt-2 pb-2.5" aria-label="Activity">
      <CollapsibleSectionHeader
        variant="panel"
        expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        accessory={<span className="text-2xs tabular-nums">{task.events.length}</span>}
      >
        Activity
      </CollapsibleSectionHeader>
      <div className="px-1.5 pt-1">
        <AddNoteInput taskId={task.id} />
      </div>
      {expanded ? (
        <ol className="mt-2 flex flex-col px-1.5">
          {lines.map(({ event, line }) => (
            <li key={event.id} className="py-0.5">
              <div className="flex min-h-6 min-w-0 items-center gap-1.5 text-[13px] leading-relaxed">
                <span className="flex size-5 shrink-0 items-center justify-center">{ICONS[line.icon]}</span>
                <span className="min-w-0 flex-1 truncate text-secondary-label">
                  <span className="font-medium text-foreground/80">{event.actor}</span> {line.text}
                </span>
                <time
                  dateTime={event.at}
                  title={new Date(event.at).toLocaleString()}
                  className="shrink-0 text-2xs text-muted-foreground tabular-nums"
                >
                  {formatElapsedDurationLabel(event.at)}
                </time>
              </div>
              {line.quote ? (
                <div className="mb-1 ms-6.5 border-l-2 border-border ps-2.5">
                  <Markdown size="xs">{line.quote}</Markdown>
                </div>
              ) : null}
            </li>
          ))}
          {lines.length === 0 ? <li className="py-1 text-xs text-muted-foreground">No activity yet.</li> : null}
        </ol>
      ) : null}
    </section>
  );
}

/** Notes are handovers: what was done, what's next, anything surprising. */
function AddNoteInput({ taskId }: { taskId: string }) {
  const [draft, setDraft] = useState("");
  const { mutate: addNote, isPending } = useAddNote();
  return (
    <Input
      aria-label="Add a handover note"
      size="sm"
      value={draft}
      disabled={isPending}
      placeholder="Add a handover note… (Enter to post)"
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        const text = draft.trim();
        if (!text) return;
        addNote({ taskId, text }, { onSuccess: () => setDraft("") });
      }}
    />
  );
}
