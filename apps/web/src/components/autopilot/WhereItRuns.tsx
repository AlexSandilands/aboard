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
import { PlusIcon, XIcon } from "lucide-react";
import { DetailSection } from "~/components/settings/agents/SplitCard";
import { StatusDot } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Skeleton } from "~/components/ui/skeleton";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import { turnsOn } from "./where.logic";
import { useWhere } from "./useWhere";

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
export function WhereItRuns({ automation }: { automation: AutopilotAutomation }) {
  const { input, description, scopes, apply, error } = useWhere(automation);
  if (!input || !description || !scopes) {
    return (
      <DetailSection title="Where it runs">
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
      </DetailSection>
    );
  }

  const blocked = automation.blocked;
  const everywhere = description.reach === "everywhere";
  const save = (writes: Parameters<typeof apply.mutate>[0]) => {
    if (writes.length > 0) apply.mutate(writes);
  };
  const candidates = whereCandidates(input);
  const everywhereWrites = whereEverywhere(input);
  const onlyWrites = whereOnlyIn(input, currentOnProjects(input));
  const noProjects = scopes.projects.length === 0;

  return (
    <DetailSection title="Where it runs">
      <div className="space-y-3 px-3 py-3 sm:px-4">
        <p className="flex min-w-0 items-center gap-2 text-sm text-foreground">
          <StatusDot tone={description.on ? "success" : "muted"} label={description.on ? "On" : "Off"} />
          <span className="min-w-0 [overflow-wrap:anywhere]">{description.sentence}</span>
        </p>
        {noProjects ? (
          <p className="text-xs text-muted-foreground">There are no projects yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            <ToggleGroup
              aria-label={`Where ${automation.title} runs`}
              className="self-start"
              disabled={apply.isPending}
              value={[everywhere ? "everywhere" : "only"]}
              onValueChange={(next) => {
                const choice = next[0];
                if (choice === "everywhere" && !everywhere) save(everywhereWrites);
                // Over Everywhere, "Only in…" starts from the projects it runs in now, so nothing changes until a chip does.
                else if (choice === "only" && everywhere) save(onlyWrites);
              }}
            >
              <Toggle
                value="everywhere"
                disabled={Boolean(blocked) && !everywhere}
                title={!everywhere && blocked ? blocked : undefined}
                className="data-pressed:bg-info/16 data-pressed:text-info-foreground dark:data-pressed:bg-info/24"
              >
                Everywhere
              </Toggle>
              <Toggle
                value="only"
                disabled={Boolean(blocked) && everywhere && turnsOn(onlyWrites)}
                title={blocked && everywhere && turnsOn(onlyWrites) ? blocked : undefined}
              >
                Only in…
              </Toggle>
            </ToggleGroup>
            {everywhere ? (
              <p className="text-xs text-muted-foreground">Every project, new ones too.</p>
            ) : (
              <div role="group" aria-label="Projects it runs in" className="flex flex-wrap gap-1.5">
                {scopes.projects.map((project) => {
                  const on = description.projects.includes(project.id);
                  const writes = whereProject(input, project.id, !on);
                  return (
                    <button
                      key={project.id}
                      type="button"
                      aria-pressed={on}
                      disabled={apply.isPending || (Boolean(blocked) && turnsOn(writes))}
                      title={!on && blocked ? blocked : undefined}
                      className={cn(
                        "inline-flex max-w-full cursor-pointer items-center truncate rounded-full border px-2.5 py-0.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
                        on
                          ? "border-info/40 bg-info/12 text-info-foreground"
                          : "border-border/60 text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                      )}
                      onClick={() => save(writes)}
                    >
                      {project.title}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <div className="flex flex-col gap-1.5 border-t border-border/50 pt-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">Exceptions</h4>
            <ExceptionMenu
              candidates={candidates}
              epics={scopes.epics}
              blocked={blocked}
              disabled={apply.isPending}
              onPick={(candidate) => save(whereAddException(candidate))}
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
                  onRemove={() => save(whereRemoveException(input, exception))}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </DetailSection>
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
        {exception.mode === "on" ? "On" : "Off"}
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
              <span className="shrink-0 text-muted-foreground">{candidate.mode === "on" ? "On" : "Off"}</span>
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
