import { ChevronRightIcon } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import { columnState, filterProjects, headerTurnsOn, usesProjectSearch, type HeaderLoss } from "./where.logic";

/** One column of switches. "All projects" shows what its rows add up to. */
export interface ProjectTableColumn {
  key: string;
  label: string;
  isOn: (projectId: string) => boolean;
  onToggle: (projectId: string, on: boolean) => void;
  /** Sets the whole column, dropping its per-project switches. */
  onHeader: (on: boolean) => void;
  /** What a header click would take away, to ask first; null when it takes nothing a person set. */
  headerLoss: (on: boolean) => HeaderLoss | null;
}

/** The expanded row's per-project Preview, on a saved automation; a draft has none, so its rows don't expand. */
export interface ProjectTablePreview {
  isPreview: (projectId: string) => boolean;
  /** Whether it runs in this project: a project that is off has nothing to preview. */
  isRunning: (projectId: string) => boolean;
  onChange: (projectId: string, preview: boolean) => void;
}

const previewTint = "data-checked:bg-warning";

function PreviewBadge() {
  return (
    <span className="shrink-0 rounded bg-warning/12 px-1.5 text-[10.5px] leading-4 font-medium text-warning-foreground">
      Preview
    </span>
  );
}

function Chevron({ open, always = false }: { open: boolean; always?: boolean }) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-100 motion-reduce:transition-none",
        open && "rotate-90",
        !open &&
          !always &&
          "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100",
      )}
    />
  );
}

/**
 * Where an automation runs, one row per project under an "All projects" row that is the board's scope. Presentational:
 * the automation's page saves each change as switches, the builder and import keep it in their form until saved.
 *
 * The header sits outside the scrolling rows so its labels stay visible; both reserve the same scrollbar gutter, so
 * the columns stay in line whether or not the scrollbar is showing.
 */
export function ProjectTable({
  label,
  projects,
  columns,
  differs,
  boardPreview = false,
  preview,
  newProjects,
  title,
  disabled,
  blocked,
  flush = false,
  empty = "There are no projects yet.",
}: {
  label: string;
  /** The rows, in lane order. */
  projects: ReadonlyArray<{ id: string; title: string }>;
  columns: readonly ProjectTableColumn[];
  /** Whether a row differs from All projects: it counts towards "N differ", and gets a dot on a saved automation. */
  differs: (projectId: string) => boolean;
  boardPreview?: boolean;
  preview?: ProjectTablePreview;
  /** What projects added later get, which the header can't say while it is mixed: "New projects: on." */
  newProjects: string;
  /** The automation's name, for the question a header click asks. */
  title: string;
  disabled: boolean;
  /** Why it can't be switched on, or null: anything that would switch it on is disabled and says this. */
  blocked: string | null;
  /** Sits straight in a card of its own, so it draws no border and the line under it brings its own inset. */
  flush?: boolean;
  /** Said instead of the table when it has no rows. */
  empty?: string;
}) {
  const differing = projects.filter((p) => differs(p.id)).length;
  // A table with something to explain opens on it; one with nothing to say stays one line.
  const [open, setOpen] = useState(differing > 0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [asking, setAsking] = useState<{ key: string; on: boolean; loss: HeaderLoss } | null>(null);

  if (projects.length === 0) {
    return <p className={cn("text-xs text-muted-foreground", flush && "px-3 py-3 sm:px-4")}>{empty}</p>;
  }

  const template: CSSProperties = {
    gridTemplateColumns: `minmax(0, 1fr) repeat(${columns.length}, ${columns.length === 1 ? "4.5rem" : "3.75rem"})`,
  };
  const rowIds = projects.map((p) => p.id);
  const shown = usesProjectSearch(projects.length) ? filterProjects(projects, query) : projects;

  const headerClick = (column: ProjectTableColumn) => {
    const on = headerTurnsOn(columnState(rowIds.map(column.isOn)));
    const loss = column.headerLoss(on);
    if (loss) setAsking({ key: column.key, on, loss });
    else column.onHeader(on);
  };

  return (
    <div className={cn("flex flex-col", flush ? "gap-0" : "gap-2")} role="group" aria-label={label}>
      <div className={cn("min-w-0 overflow-hidden", !flush && "rounded-xl border border-border/60")}>
        {/* The same gutter as the rows below: `stable` holds it open even while no scrollbar shows. */}
        <div className="overflow-hidden bg-foreground/[0.025] [scrollbar-gutter:stable]">
          {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the row is a larger target; the name button inside it is the keyboard way */}
          <div
            className="grid min-h-10 cursor-pointer grid-rows-[1.375rem_2.5rem] items-stretch gap-x-1 pe-2 ps-1.5 pt-1.5"
            style={template}
            onClick={() => setOpen((v) => !v)}
          >
            <div className="row-span-2 flex min-w-0 items-center gap-1">
              <Chevron open={open} always />
              <span className="grid min-w-0 gap-0">
                <button
                  type="button"
                  aria-expanded={open}
                  className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 text-start text-sm font-semibold outline-none [overflow-wrap:anywhere] focus-visible:underline"
                >
                  All projects
                  {boardPreview ? <PreviewBadge /> : null}
                </button>
                {!open && differing > 0 ? (
                  <span className="text-xs text-muted-foreground">{differing} differ</span>
                ) : null}
              </span>
            </div>
            {columns.map((column) => (
              <div key={column.key} className="flex items-center justify-center text-[11.5px] text-muted-foreground">
                {column.label}
              </div>
            ))}
            {columns.map((column) => {
              const state = columnState(rowIds.map(column.isOn));
              const turnOnBlocked = headerTurnsOn(state) && Boolean(blocked);
              return (
                // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- only stops a click on the switch reaching the row
                <div
                  key={column.key}
                  className="flex items-center justify-center"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Switch
                    size="sm"
                    aria-label={`${column.label} in all projects`}
                    checked={state === "on"}
                    mixed={state === "mixed"}
                    // On somewhere, so the track takes a tint of On, as the automation list's mixed switch does.
                    className={cn("data-[mixed]:bg-primary/45", boardPreview && previewTint)}
                    disabled={disabled || turnOnBlocked}
                    title={turnOnBlocked && blocked ? blocked : undefined}
                    onCheckedChange={() => headerClick(column)}
                  />
                </div>
              );
            })}
          </div>
        </div>
        {open ? (
          <>
            {usesProjectSearch(projects.length) ? (
              <div className="border-t border-border/50 p-1.5">
                <Input
                  type="search"
                  size="sm"
                  placeholder="Find a project"
                  aria-label="Find a project"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            ) : null}
            {/* About ten rows, then it scrolls. */}
            <div className="max-h-[25.5rem] overflow-y-auto [scrollbar-gutter:stable]">
              {shown.length === 0 ? (
                <p className="border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">No project matches.</p>
              ) : (
                shown.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    columns={columns}
                    template={template}
                    differs={differs(project.id)}
                    preview={preview}
                    expanded={expanded === project.id}
                    onExpand={() => setExpanded((id) => (id === project.id ? null : project.id))}
                    disabled={disabled}
                    blocked={blocked}
                  />
                ))
              )}
            </div>
          </>
        ) : null}
      </div>
      <p className={cn("text-xs text-muted-foreground", flush && "border-t border-border/50 px-3 py-2 sm:px-4")}>
        {newProjects}
      </p>
      <HeaderClearDialog
        open={asking !== null}
        onOpenChange={(next) => (next ? null : setAsking(null))}
        title={title}
        ask={asking}
        // Looked up now: the switches can change over the event stream while the dialog is open.
        onConfirm={() => asking && columns.find((c) => c.key === asking.key)?.onHeader(asking.on)}
      />
    </div>
  );
}

function ProjectRow({
  project,
  columns,
  template,
  differs,
  preview,
  expanded,
  onExpand,
  disabled,
  blocked,
}: {
  project: { id: string; title: string };
  columns: readonly ProjectTableColumn[];
  template: CSSProperties;
  differs: boolean;
  preview: ProjectTablePreview | undefined;
  expanded: boolean;
  onExpand: () => void;
  disabled: boolean;
  blocked: string | null;
}) {
  const running = preview?.isRunning(project.id) ?? false;
  const inPreview = running && (preview?.isPreview(project.id) ?? false);
  const name: ReactNode = (
    <>
      <span className="min-w-0 [overflow-wrap:anywhere]">{project.title}</span>
      {/* A draft's one column says it already: a dot on every row would only be noise. */}
      {preview && differs ? (
        <span aria-label="Differs from All projects" className="size-1.5 shrink-0 rounded-full bg-info" role="img" />
      ) : null}
      {inPreview ? <PreviewBadge /> : null}
    </>
  );
  return (
    <div className={cn("group/row border-t border-border/50", expanded && "bg-foreground/[0.022]")}>
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the row is a larger target; the name button inside it is the keyboard way */}
      <div
        className={cn(
          "grid min-h-10 items-stretch gap-x-1 pe-2 ps-1.5",
          preview && "cursor-pointer hover:bg-foreground/[0.03]",
        )}
        style={template}
        onClick={preview ? onExpand : undefined}
      >
        <div className="flex min-w-0 items-center gap-1">
          {preview ? <Chevron open={expanded} /> : <span aria-hidden className="w-3.5 shrink-0" />}
          {preview ? (
            <button
              type="button"
              aria-expanded={expanded}
              className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 text-start text-sm font-medium outline-none focus-visible:underline"
            >
              {name}
            </button>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-sm font-medium">{name}</span>
          )}
        </div>
        {columns.map((column) => {
          const on = column.isOn(project.id);
          const turnOnBlocked = !on && Boolean(blocked);
          return (
            // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- only stops a click on the switch reaching the row
            <div
              key={column.key}
              className="flex items-center justify-center"
              onClick={(event) => event.stopPropagation()}
            >
              <Switch
                size="sm"
                aria-label={`${column.label} in ${project.title}`}
                checked={on}
                className={cn(inPreview && previewTint)}
                disabled={disabled || turnOnBlocked}
                title={turnOnBlocked && blocked ? blocked : undefined}
                onCheckedChange={(next) => column.onToggle(project.id, next)}
              />
            </div>
          );
        })}
      </div>
      {preview && expanded ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pe-3 pb-3 ps-[1.625rem] pt-1">
          <span className="text-xs text-muted-foreground">Preview</span>
          <Switch
            size="sm"
            aria-label={`Preview in ${project.title}`}
            checked={inPreview}
            className={previewTint}
            disabled={disabled || !running || Boolean(blocked)}
            title={blocked ?? (running ? undefined : "Switch it on in this project first")}
            onCheckedChange={(next) => preview.onChange(project.id, next)}
          />
          <span className="text-xs text-muted-foreground">Records what it would do. Nothing runs.</span>
        </div>
      ) : null}
    </div>
  );
}

/** "a, b and 1 epic": everything the header click would clear. */
function lossWhere({ projects, epics }: HeaderLoss): string {
  const named =
    projects.length === 0 ? [] : [projects.length <= 3 ? projects.join(", ") : `${projects.length} projects`];
  return [...named, ...(epics > 0 ? [epics === 1 ? "1 epic" : `${epics} epics`] : [])].join(" and ");
}

/** Asked before a header click drops switches a person set on a project, as `SwitchOffDialog` asks on the list. */
function HeaderClearDialog({
  open,
  onOpenChange,
  title,
  ask,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  ask: { on: boolean; loss: HeaderLoss } | null;
  onConfirm: () => void;
}) {
  const one = ask ? ask.loss.projects.length + ask.loss.epics === 1 : false;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {ask?.on ? "Turn on" : "Switch off"} {title} everywhere?
          </DialogTitle>
          <DialogDescription>
            {ask ? lossWhere(ask.loss) : ""}{" "}
            {ask?.on
              ? `${one ? "is" : "are"} switched off on ${one ? "its" : "their"} own. This clears that, so ${one ? "it follows" : "they follow"} All projects.`
              : `${one ? "has its own setting" : "have their own setting"}, which beats All projects. This clears that, so it runs nowhere.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button
            variant={ask?.on ? "default" : "destructive"}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {ask?.on ? "Turn on everywhere" : "Off everywhere"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
