import {
  currentOnProjects,
  whereAddException,
  whereCandidates,
  whereEverywhere,
  whereOnlyIn,
  whereProject,
  whereRemoveException,
  type AutopilotAutomation,
  type WhereCandidate,
  type WhereException,
} from "@repo/contracts";
import { ChevronDownIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { DetailSection } from "~/components/settings/agents/SplitCard";
import { StatusDot } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Skeleton } from "~/components/ui/skeleton";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import { filterProjects, pickerLabel, turnsOn, usesProjectPicker } from "./where.logic";
import { useWhere } from "./useWhere";

const modeLabel = (mode: "on" | "preview" | "off"): string =>
  mode === "on" ? "On" : mode === "preview" ? "Preview" : "Off";

/** An epic with its title ("epic #5 · Checkout redesign"), where the widget has room; a project is just its name. */
function candidateLabel(
  candidate: Pick<WhereCandidate, "scope" | "id" | "label">,
  epics: ReadonlyArray<{ id: string; title: string }>,
): string {
  const title = candidate.scope === "epic" ? epics.find((e) => e.id === candidate.id)?.title : undefined;
  return title ? `${candidate.label} · ${title}` : candidate.label;
}

/**
 * The detail pane's "Where it runs": the effective state as a sentence, Everywhere / Only in… with the projects as
 * chips, and the exceptions (a project or epic that differs) with + Exception. It writes the same board, project and
 * epic switches as the lane and epic popovers, so all three always agree. A blocked automation can't be switched on, so
 * every edit that would switch something on is disabled.
 */
export function WhereItRuns({
  automation,
  everywhereMode = "on",
}: {
  automation: AutopilotAutomation;
  /** The mode Everywhere turns an off automation on in: On, or Preview for one that has never run. */
  everywhereMode?: "on" | "preview";
}) {
  const where = useWhere(automation);
  const { input, description, scopes, apply } = where;
  return (
    <DetailSection title="Where it runs">
      {!input || !description || !scopes ? (
        <WhereLoading error={where.error} />
      ) : (
        <div className="space-y-3 px-3 py-3 sm:px-4">
          <LiveProjects automation={automation} everywhereMode={everywhereMode} where={where} />
          <div className="flex flex-col gap-1.5 border-t border-border/50 pt-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-medium text-muted-foreground">Exceptions</h4>
              <ExceptionMenu
                candidates={whereCandidates(input)}
                epics={scopes.epics}
                blocked={automation.blocked}
                disabled={apply.isPending}
                onPick={(candidate) => apply.mutate(whereAddException(candidate))}
              />
            </div>
            {description.exceptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                None. {automation.epicScope ? "A project or an epic" : "A project"} can run differently from the rest.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {description.exceptions.map((exception) => (
                  <ExceptionChip
                    key={`${exception.scope}:${exception.id}`}
                    exception={exception}
                    label={candidateLabel(exception, scopes.epics)}
                    disabled={apply.isPending}
                    onRemove={() => {
                      const writes = whereRemoveException(input, exception);
                      if (writes.length > 0) apply.mutate(writes);
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </DetailSection>
  );
}

function WhereLoading({ error }: { error: Error | null }) {
  return (
    <div className="space-y-2 px-3 py-3 sm:px-4">
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          Couldn&apos;t load where it runs: {error.message}
        </p>
      ) : (
        <>
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-7 w-44" />
        </>
      )}
    </div>
  );
}

/**
 * The builder's Where step for a saved automation: the sentence and the projects of Where it runs, writing its
 * switches as they change. Exceptions stay on the automation's page.
 */
export function WhereProjects({
  automation,
  everywhereMode = "preview",
}: {
  automation: AutopilotAutomation;
  everywhereMode?: "on" | "preview";
}) {
  const where = useWhere(automation);
  if (!where.input || !where.description || !where.scopes) {
    return (
      <div className="-mx-3 sm:-mx-4">
        <WhereLoading error={where.error} />
      </div>
    );
  }
  return <LiveProjects automation={automation} everywhereMode={everywhereMode} where={where} />;
}

/** The sentence and Everywhere / Only in… with its projects, writing the automation's switches. */
function LiveProjects({
  automation,
  everywhereMode,
  where,
}: {
  automation: AutopilotAutomation;
  everywhereMode: "on" | "preview";
  where: ReturnType<typeof useWhere>;
}) {
  const { input, description, scopes, apply } = where;
  if (!input || !description || !scopes) return null;
  const blocked = automation.blocked;
  const everywhere = description.reach === "everywhere";
  const save = (writes: Parameters<typeof apply.mutate>[0]) => {
    if (writes.length > 0) apply.mutate(writes);
  };
  const everywhereWrites = whereEverywhere(input, everywhereMode);
  const allPreview =
    description.state === "preview" ||
    (description.projects.length > 0 && description.projects.every((id) => description.previewProjects.includes(id)));
  // Over Everywhere, "Only in…" starts from the projects it runs in now, so nothing changes until a chip does.
  const onlyWrites = whereOnlyIn(input, currentOnProjects(input));
  const allIds = scopes.projects.map((p) => p.id);

  return (
    <>
      <p className="flex min-w-0 items-center gap-2 text-sm text-foreground">
        <StatusDot
          tone={!description.on ? "muted" : allPreview ? "warning" : "success"}
          label={!description.on ? "Off" : allPreview ? "Preview" : "On"}
        />
        <span className="min-w-0 [overflow-wrap:anywhere]">{description.sentence}</span>
      </p>
      <ProjectsChoice
        label={`Where ${automation.title} runs`}
        projects={scopes.projects}
        everywhere={everywhere}
        on={description.projects}
        preview={description.previewProjects}
        disabled={apply.isPending}
        blocked={blocked}
        everywhereBlocked={Boolean(blocked) && !everywhere}
        onlyBlocked={Boolean(blocked) && everywhere && turnsOn(onlyWrites)}
        toggleBlocked={(id, on) => Boolean(blocked) && turnsOn(whereProject(input, id, on))}
        allBlocked={Boolean(blocked) && turnsOn(whereOnlyIn(input, allIds))}
        onChoose={(choice) => {
          if (choice === "everywhere" && !everywhere) save(everywhereWrites);
          else if (choice === "only" && everywhere) save(onlyWrites);
        }}
        onToggle={(id, on) => save(whereProject(input, id, on))}
        onAll={() => save(whereOnlyIn(input, allIds))}
        onNone={() => save(whereOnlyIn(input, []))}
      />
    </>
  );
}

/** "a", "a and b", "a, b, c and 2 more". */
function namesPhrase(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/**
 * The builder's Where step for a new automation: the same choice as Where it runs, kept in the form and written as its
 * switches when it is saved (in Preview, unless saved and turned on).
 */
export function DraftProjects({
  projects,
  everywhere,
  projectIds,
  onChange,
}: {
  projects: ReadonlyArray<{ id: string; title: string }>;
  everywhere: boolean;
  projectIds: readonly string[];
  onChange: (next: { everywhere: boolean; projectIds: string[] }) => void;
}) {
  const picked = projects.filter((p) => projectIds.includes(p.id));
  const sentence = everywhere
    ? "Every project, new ones too"
    : picked.length > 0
      ? `Only in ${namesPhrase(picked.map((p) => p.title))}`
      : "No project picked yet";
  const ids = picked.map((p) => p.id);
  return (
    <>
      <p className="flex min-w-0 items-center gap-2 text-sm text-foreground">
        <StatusDot
          tone={everywhere || picked.length > 0 ? "success" : "muted"}
          label={everywhere || picked.length > 0 ? "Runs" : "Nowhere yet"}
        />
        <span className="min-w-0 [overflow-wrap:anywhere]">{sentence}</span>
      </p>
      <ProjectsChoice
        label="Where it runs"
        projects={projects}
        everywhere={everywhere}
        on={ids}
        preview={[]}
        disabled={false}
        blocked={null}
        hideEverywhereHint
        onChoose={(choice) =>
          onChange(
            choice === "everywhere"
              ? { everywhere: true, projectIds: ids }
              : // From Everywhere, Only in… starts with every project picked, as the automation's page does.
                { everywhere: false, projectIds: ids.length > 0 ? ids : projects.map((p) => p.id) },
          )
        }
        onToggle={(id, on) =>
          onChange({ everywhere: false, projectIds: on ? [...ids, id] : ids.filter((other) => other !== id) })
        }
        onAll={() => onChange({ everywhere: false, projectIds: projects.map((p) => p.id) })}
        onNone={() => onChange({ everywhere: false, projectIds: [] })}
      />
    </>
  );
}

const neverBlocked = (): boolean => false;

/**
 * Everywhere / Only in… and, under Only in…, the projects as chips, or a searchable picker past
 * `usesProjectPicker`'s limit. Presentational: Where it runs saves each change as switches, the builder keeps it in its
 * form until it is saved.
 */
function ProjectsChoice({
  label,
  projects,
  everywhere,
  on,
  preview,
  disabled,
  blocked,
  everywhereBlocked = false,
  onlyBlocked = false,
  toggleBlocked = neverBlocked,
  allBlocked = false,
  hideEverywhereHint = false,
  onChoose,
  onToggle,
  onAll,
  onNone,
}: {
  label: string;
  projects: ReadonlyArray<{ id: string; title: string }>;
  everywhere: boolean;
  /** Ids of the projects it runs in (in Preview too). */
  on: readonly string[];
  preview: readonly string[];
  disabled: boolean;
  /** Why it can't be switched on, or null: shown on whatever would switch it on, which is disabled. */
  blocked: string | null;
  everywhereBlocked?: boolean;
  onlyBlocked?: boolean;
  toggleBlocked?: (id: string, on: boolean) => boolean;
  allBlocked?: boolean;
  /** The sentence above already says Everywhere is every project. */
  hideEverywhereHint?: boolean;
  onChoose: (choice: "everywhere" | "only") => void;
  onToggle: (id: string, on: boolean) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  if (projects.length === 0) return <p className="text-xs text-muted-foreground">There are no projects yet.</p>;
  return (
    <div className="flex flex-col gap-2">
      <ToggleGroup
        aria-label={label}
        className="self-start"
        disabled={disabled}
        value={[everywhere ? "everywhere" : "only"]}
        onValueChange={(next) => {
          const choice = next[0];
          if (choice === "everywhere" || choice === "only") onChoose(choice);
        }}
      >
        <Toggle
          value="everywhere"
          disabled={everywhereBlocked}
          title={everywhereBlocked && blocked ? blocked : undefined}
          className="data-pressed:bg-info/16 data-pressed:text-info-foreground dark:data-pressed:bg-info/24"
        >
          Everywhere
        </Toggle>
        <Toggle value="only" disabled={onlyBlocked} title={onlyBlocked && blocked ? blocked : undefined}>
          Only in…
        </Toggle>
      </ToggleGroup>
      {everywhere ? (
        hideEverywhereHint ? null : (
          <p className="text-xs text-muted-foreground">Every project, new ones too.</p>
        )
      ) : usesProjectPicker(projects.length) ? (
        <ProjectPicker
          projects={projects}
          on={on}
          preview={preview}
          blocked={blocked}
          disabled={disabled}
          onToggle={onToggle}
          onAll={onAll}
          allTurnsOn={allBlocked}
          onNone={onNone}
        />
      ) : (
        <div role="group" aria-label="Projects it runs in" className="flex flex-wrap gap-1.5">
          {projects.map((project) => {
            const isOn = on.includes(project.id);
            const isPreview = preview.includes(project.id);
            const turnOnBlocked = toggleBlocked(project.id, !isOn);
            return (
              <button
                key={project.id}
                type="button"
                aria-pressed={isOn}
                disabled={disabled || turnOnBlocked}
                title={!isOn && blocked ? blocked : undefined}
                className={cn(
                  "inline-flex max-w-full cursor-pointer items-center truncate rounded-full border px-2.5 py-0.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
                  isOn && isPreview
                    ? "border-warning/40 bg-warning/12 text-warning-foreground"
                    : isOn
                      ? "border-info/40 bg-info/12 text-info-foreground"
                      : "border-border/60 text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                )}
                onClick={() => onToggle(project.id, !isOn)}
              >
                {project.title}
                {isPreview ? <span className="ms-1 opacity-80">Preview</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ExceptionChip({
  exception,
  label,
  disabled,
  onRemove,
}: {
  exception: WhereException;
  label: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <li className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-card/40 py-0.5 ps-2.5 pe-1 text-xs">
      <span className="min-w-0 truncate">{label}</span>
      <span
        className={cn(
          "shrink-0 font-medium",
          exception.mode === "on" ? "text-info-foreground" : "text-warning-foreground",
        )}
      >
        {modeLabel(exception.mode)}
      </span>
      <Button
        size="icon-micro"
        variant="ghost-muted"
        aria-label={`Remove the exception for ${label}`}
        title="Follow the rest again"
        disabled={disabled}
        onClick={onRemove}
      >
        <XIcon />
      </Button>
    </li>
  );
}

function ExceptionMenu({
  candidates,
  epics,
  blocked,
  disabled,
  onPick,
}: {
  candidates: ReadonlyArray<WhereCandidate>;
  epics: ReadonlyArray<{ id: string; title: string }>;
  blocked: string | null;
  disabled: boolean;
  onPick: (candidate: WhereCandidate) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="xs" variant="outline" disabled={disabled || candidates.length === 0} />}
        aria-label="Add an exception"
      >
        <PlusIcon />
        Exception
      </MenuTrigger>
      <MenuPopup align="end" className="max-h-72">
        {candidates.map((candidate) => (
          <MenuItem
            key={`${candidate.scope}:${candidate.id}`}
            disabled={Boolean(blocked) && candidate.mode === "on"}
            onClick={() => onPick(candidate)}
          >
            <span className="flex min-w-0 flex-1 items-center justify-between gap-4 text-xs">
              <span className="min-w-0 truncate">{candidateLabel(candidate, epics)}</span>
              <span className="shrink-0 text-muted-foreground">{modeLabel(candidate.mode)}</span>
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/**
 * Only in… on a board with more projects than fit as chips: one "5 of 20 projects" button opening a searchable
 * checklist with All and None. The sentence above still names the first few, so it rarely needs opening.
 */
function ProjectPicker({
  projects,
  on,
  preview,
  blocked,
  disabled,
  onToggle,
  onAll,
  allTurnsOn,
  onNone,
}: {
  projects: ReadonlyArray<{ id: string; title: string }>;
  /** Ids of the projects it runs in (in Preview too). */
  on: readonly string[];
  preview: readonly string[];
  blocked: string | null;
  disabled: boolean;
  onToggle: (id: string, on: boolean) => void;
  onAll: () => void;
  allTurnsOn: boolean;
  onNone: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = filterProjects(projects, query);
  return (
    <Popover onOpenChange={(open) => (open ? null : setQuery(""))}>
      <PopoverTrigger
        render={<Button size="xs" variant="outline" className="self-start" />}
        aria-label={`Projects it runs in: ${pickerLabel(on.length, projects.length)}`}
      >
        {pickerLabel(on.length, projects.length)}
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverPopup align="start" padding="compact" width="sm">
        <div className="flex flex-col gap-2">
          <Input
            type="search"
            size="sm"
            placeholder="Find a project"
            aria-label="Find a project"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div role="group" aria-label="Projects it runs in" className="-mx-1 max-h-60 overflow-y-auto">
            {shown.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No project matches.</p>
            ) : (
              shown.map((project) => {
                const isOn = on.includes(project.id);
                const turnOnBlocked = !isOn && Boolean(blocked);
                return (
                  <label
                    key={project.id}
                    title={turnOnBlocked && blocked ? blocked : undefined}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent/50",
                      (disabled || turnOnBlocked) && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 cursor-pointer accent-primary disabled:cursor-not-allowed"
                      checked={isOn}
                      disabled={disabled || turnOnBlocked}
                      onChange={() => onToggle(project.id, !isOn)}
                    />
                    <span className="min-w-0 flex-1 truncate">{project.title}</span>
                    {preview.includes(project.id) ? (
                      <span className="shrink-0 text-xs text-warning-foreground">Preview</span>
                    ) : null}
                  </label>
                );
              })
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-border/50 pt-2 text-xs text-muted-foreground">
            <span>{on.length} selected</span>
            <span className="flex gap-1">
              <Button size="xs" variant="ghost" disabled={disabled || (Boolean(blocked) && allTurnsOn)} onClick={onAll}>
                All
              </Button>
              <Button size="xs" variant="ghost" disabled={disabled || on.length === 0} onClick={onNone}>
                None
              </Button>
            </span>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
