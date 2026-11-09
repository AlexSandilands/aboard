import { boardState, parseLogins, projectState, whereProjectPreview, type AutopilotAutomation } from "@repo/contracts";
import { PlusIcon, Undo2Icon } from "lucide-react";
import { useState } from "react";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import { useAutopilotOverview, useAutopilotProjectScopes, useAutopilotScope } from "~/state/queries";
import { entryFor } from "./autopilot.logic";
import { ProjectTable, type ProjectTableColumn, type ProjectTableSwitchColumn } from "./ProjectTable";
import {
  approveHeaderLoss,
  approveHeaderWrites,
  approveOn,
  approveRowWrite,
  boardPeople,
  hasOwnPeople,
  peopleBoardWrite,
  peopleIn,
  peopleResetWrite,
  peopleRoster,
  peopleRowWrite,
  reviewNewProjects,
  reviewRowDiffers,
  sourceHeaderLoss,
  sourceHeaderWrites,
  sourceOn,
  sourceRowWrites,
  togglePerson,
  type ReviewPrsScopes,
  type ReviewPrsWrite,
  type ReviewSource,
} from "./reviewPrs.logic";
import { tableProjects } from "./where.logic";
import type { useWhere } from "./useWhere";

/** The same colour for a login everywhere it shows, on a tone that holds white initials in both themes. */
const loginHue = (login: string): number => Array.from(login).reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function Avatar({ login, className }: { login: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10.5px] font-semibold text-white uppercase",
        className,
      )}
      style={{ background: `hsl(${loginHue(login)} 42% 42%)` }}
    >
      {login[0]}
    </span>
  );
}

/** Up to three people's initials, then "+N". Opens the row's people. */
function PeopleCell({ people, onOpen }: { people: readonly string[]; onOpen: () => void }) {
  if (people.length === 0) {
    return (
      <button
        type="button"
        className="cursor-pointer text-xs text-warning-foreground outline-none hover:underline focus-visible:underline"
        onClick={onOpen}
      >
        Add
      </button>
    );
  }
  const names = people.join(", ");
  return (
    <button
      type="button"
      aria-label={names}
      title={names}
      className="inline-flex cursor-pointer items-center outline-none focus-visible:underline"
      onClick={onOpen}
    >
      {people.slice(0, 3).map((login) => (
        <Avatar key={login} login={login} className="not-first:-ms-1.5 ring-2 ring-card" />
      ))}
      {people.length > 3 ? <span className="ms-1 text-[11px] text-muted-foreground">+{people.length - 3}</span> : null}
    </button>
  );
}

/** The people field: every name already in use as a pill, the chosen ones lit, and Add for a new login. */
function PeoplePills({
  label,
  people,
  roster,
  onChange,
  onReset,
}: {
  label: string;
  people: readonly string[];
  roster: readonly string[];
  onChange: (people: string[]) => void;
  onReset?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const shown = [...new Set([...roster, ...people])];
  const add = (text: string) => {
    const logins = parseLogins(text);
    if (logins.length > 0) onChange([...new Set([...people, ...logins])]);
    setAdding(false);
  };
  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-start gap-x-2.5" role="group" aria-label={label}>
      <span className="flex h-7 items-center gap-1 text-xs text-muted-foreground">
        People
        {onReset ? (
          <button
            type="button"
            aria-label="Use the default people"
            title="Use the default people"
            className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md hover:bg-foreground/5 hover:text-foreground"
            onClick={onReset}
          >
            <Undo2Icon className="size-3" />
          </button>
        ) : null}
      </span>
      <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-1.5">
        {shown.map((login) => {
          const chosen = people.includes(login);
          return (
            <button
              key={login}
              type="button"
              aria-pressed={chosen}
              className={cn(
                "inline-flex h-6.5 cursor-pointer items-center gap-1.5 rounded-full border ps-0.5 pe-2.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                chosen
                  ? "border-primary/60 bg-primary/14 text-foreground"
                  : "border-input text-muted-foreground hover:bg-foreground/[0.03]",
              )}
              onClick={() => onChange(togglePerson(people, login))}
            >
              <Avatar login={login} className={chosen ? undefined : "opacity-55 grayscale"} />
              {login}
            </button>
          );
        })}
        {adding ? (
          <Input
            size="sm"
            autoFocus
            placeholder="GitHub login"
            aria-label="Add a person"
            className="w-32"
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                add(event.currentTarget.value);
              } else if (event.key === "Escape") {
                setAdding(false);
              }
            }}
            onBlur={(event) => add(event.currentTarget.value)}
          />
        ) : (
          <button
            type="button"
            className="inline-flex h-6.5 cursor-pointer items-center gap-1 rounded-full border border-input px-2.5 text-[12.5px] text-muted-foreground outline-none hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setAdding(true)}
          >
            <PlusIcon className="size-3" />
            Add
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Review PRs' Where it runs: Your PRs, Others', People and Approve per project, the one automation whose table has more
 * than On. Its saves go through the Where it runs mutation, in order and with mode and config in one write per scope.
 */
export function ReviewPrsProjects({
  automation,
  everywhereMode,
  where,
  flush,
}: {
  automation: AutopilotAutomation;
  everywhereMode: "on" | "preview";
  where: ReturnType<typeof useWhere>;
  flush: boolean;
}) {
  const { input, scopes: whereScopes, apply } = where;
  const board = useAutopilotScope(null);
  const ids = whereScopes?.projects.map((p) => p.id) ?? [];
  const projectScopes = useAutopilotProjectScopes(ids);
  const overview = useAutopilotOverview();
  if (!input || !whereScopes || !board.data || projectScopes.some((q) => !q.data)) return null;

  const scopes: ReviewPrsScopes = {
    input,
    board: { ...automation.defaults, ...entryFor(board.data, automation).config },
    projects: Object.fromEntries(
      ids.map((id, i) => [id, projectScopes[i]!.data!.find((e) => e.automation === automation.key)?.config ?? {}]),
    ),
  };
  const save = (writes: ReviewPrsWrite[]) => {
    if (writes.length > 0) apply.mutate(writes);
  };
  const projects = tableProjects(whereScopes, automation.needsRepo);
  const shown = projects.map((p) => p.id);
  const othersOn = (id: string) => sourceOn(scopes, id, "otherPrs");
  const waiting = (overview.data?.needsYou ?? []).flatMap((n) => (n.kind === "pr_approval" ? [n.author] : []));
  const roster = peopleRoster(scopes, waiting);

  const sourceColumn = (key: ReviewSource, label: string): ProjectTableSwitchColumn => ({
    key,
    label,
    isOn: (id) => sourceOn(scopes, id, key),
    onToggle: (id, on) => save(sourceRowWrites(scopes, id, key, on)),
    onHeader: (on) => save(sourceHeaderWrites(scopes, key, on, everywhereMode)),
    headerLoss: (on) => sourceHeaderLoss(scopes, shown, key, on),
  });
  const columns: ProjectTableColumn[] = [
    sourceColumn("ownPrs", "Your PRs"),
    {
      ...sourceColumn("otherPrs", "Others'"),
      expandsOnTurnOn: true,
      opensAllDetail: () => boardPeople(scopes).length === 0,
    },
    {
      kind: "cell",
      key: "people",
      label: "People",
      wide: true,
      renderCell: (id, expand) =>
        othersOn(id) ? <PeopleCell people={peopleIn(scopes, id)} onOpen={expand.toggle} /> : null,
      renderAllCell: (expand) => {
        const people = boardPeople(scopes);
        // Nobody to add while Others' is off everywhere; a list that exists stays reachable.
        if (people.length === 0 && !shown.some(othersOn)) return null;
        return <PeopleCell people={people} onOpen={expand.toggle} />;
      },
    },
    {
      key: "approve",
      label: "Approve",
      appliesTo: othersOn,
      isOn: (id) => approveOn(scopes, id),
      onToggle: (id, on) => save([approveRowWrite(scopes, id, on)]),
      onHeader: (on) => save(approveHeaderWrites(scopes, on)),
      headerLoss: (on) => approveHeaderLoss(scopes, shown, on),
    },
  ];
  const rowState = (id: string) => {
    const project = input.projects.find((p) => p.id === id);
    return project ? projectState(input.board, project) : "off";
  };
  const projectTitle = (id: string) => projects.find((p) => p.id === id)?.title ?? id;

  return (
    <ProjectTable
      label={`Where ${automation.title} runs`}
      title={automation.title}
      projects={projects}
      columns={columns}
      differs={(id) => reviewRowDiffers(scopes, id)}
      boardPreview={boardState(input.board) === "preview"}
      preview={{
        isPreview: (id) => rowState(id) === "preview",
        isRunning: (id) => rowState(id) !== "off",
        onChange: (id, preview) => save(whereProjectPreview(input, id, preview)),
      }}
      newProjects={reviewNewProjects(scopes)}
      disabled={apply.isPending}
      blocked={automation.blocked}
      flush={flush}
      empty="No projects with a repository yet."
      renderRowDetail={(id) =>
        othersOn(id) ? (
          <PeoplePills
            label={`People in ${projectTitle(id)}`}
            people={peopleIn(scopes, id)}
            roster={roster}
            onChange={(people) => save([peopleRowWrite(scopes, id, people)])}
            onReset={hasOwnPeople(scopes, id) ? () => save([peopleResetWrite(id)]) : undefined}
          />
        ) : null
      }
      allDetail={
        <PeoplePills
          label="People in all projects"
          people={boardPeople(scopes)}
          roster={roster}
          onChange={(people) => save([peopleBoardWrite(people)])}
        />
      }
    />
  );
}
