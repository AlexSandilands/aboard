import {
  AGENT_HARNESSES,
  STATS_PERIODS,
  type StatsPeriod,
  type StatsResponse,
  type StatsSeries,
} from "@repo/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SidebarTrigger, useSidebar } from "~/components/ui/sidebar";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { ApiError } from "~/lib/api";
import { useBoard, useStats } from "~/state/queries";
import { SERIES_COLORS, type ChartSeries } from "./chartParts";
import { KpiTile } from "./KpiTile";
import {
  breakdownRows,
  changeVsPrevious,
  formatStatsValue,
  isQuiet,
  parseStatsPeriod,
  runsByAutomation,
  runsByStatusWeekly,
  runsInStatuses,
  valuesOrZero,
} from "./stats.logic";
import { SortedBars } from "./SortedBars";
import { TrendLine } from "./TrendLine";
import { WeeklyBars } from "./WeeklyBars";

const ALL_PROJECTS = "all";

const EMPTY: StatsSeries = {
  unit: "count",
  values: [],
  total: null,
  previousTotal: null,
};

/** Route component for `/stats`: weekly trends over the board's history (docs/features/stats.md). */
export function StatsPage() {
  const { isMobile, open } = useSidebar();
  const navigate = useNavigate();
  const search = useSearch({ from: "/_app/stats" });
  const weeks = parseStatsPeriod(search.weeks);
  const projectId = search.project ?? null;
  const stats = useStats(weeks, projectId);
  const projects = useBoard().data?.projects ?? [];
  // A project that was deleted or archived since the link was made: the API says 404, so say so and offer the whole board.
  const unknownProject = stats.error instanceof ApiError && stats.error.status === 404 && projectId !== null;

  const setSearch = (patch: { project?: string | undefined; weeks?: StatsPeriod }) =>
    void navigate({
      to: "/stats",
      search: {
        weeks: patch.weeks ?? weeks,
        project: "project" in patch ? patch.project : (projectId ?? undefined),
      },
      replace: true,
    });

  const projectItems = [
    { value: ALL_PROJECTS, label: "All projects" },
    ...projects.map((project) => ({ value: project.id, label: project.title })),
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="drag-region flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 ps-(--workspace-gutter-start) pe-(--workspace-gutter-end) wco:pe-(--workspace-native-controls-inset)">
        {isMobile || !open ? <SidebarTrigger variant="ghost-muted" size="icon-sm" aria-label="Toggle sidebar" /> : null}
        <h1 className="truncate text-sm font-medium">Stats</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-6 px-4 pt-2 pb-24 sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <Select
              items={projectItems}
              value={projectId ?? ALL_PROJECTS}
              onValueChange={(next) =>
                setSearch({
                  project: next === null || next === ALL_PROJECTS ? undefined : next,
                })
              }
            >
              <SelectTrigger size="sm" className="sm:w-52" aria-label="Project">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {projectItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <ToggleGroup
              aria-label="Period"
              value={[String(weeks)]}
              onValueChange={(next) => {
                const period = parseStatsPeriod(next[0]);
                if (next[0] !== undefined) setSearch({ weeks: period });
              }}
            >
              {STATS_PERIODS.map((period) => (
                <Toggle key={period} value={String(period)} aria-label={`${period} weeks`}>
                  {period}w
                </Toggle>
              ))}
            </ToggleGroup>
            {stats.isFetching && stats.data ? <Spinner size="sm" tone="muted" aria-label="Refreshing" /> : null}
          </div>
          {unknownProject ? (
            <p className="text-sm text-muted-foreground">
              That project isn't on the board any more.{" "}
              <button
                type="button"
                className="rounded-sm underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setSearch({ project: undefined })}
              >
                Show all projects
              </button>
            </p>
          ) : stats.data ? (
            <div
              aria-busy={stats.isPlaceholderData}
              className={
                stats.isPlaceholderData ? "opacity-60 transition-opacity motion-reduce:transition-none" : undefined
              }
            >
              <StatsSections data={stats.data} />
            </div>
          ) : stats.isError ? (
            <p className="text-sm text-destructive">Couldn't load the stats.</p>
          ) : (
            <Spinner />
          )}
        </div>
      </div>
    </div>
  );
}

function seriesOf(data: StatsResponse, name: string): StatsSeries {
  return data.series[name] ?? { ...EMPTY, values: data.buckets.map(() => null) };
}

/** A series as a chart wants it. Counts and costs read null as a quiet week, so bars get zeros. */
function chartSeries(
  data: StatsResponse,
  name: string,
  label: string,
  color: string,
  { zeros = false }: { zeros?: boolean } = {},
): ChartSeries {
  const { values } = seriesOf(data, name);
  return {
    key: name,
    label,
    color,
    values: zeros ? valuesOrZero(values) : values,
  };
}

/** The sum of several series' totals, for a headline over a family such as findings by severity. */
function sumTotals(data: StatsResponse, names: ReadonlyArray<string>): Pick<StatsSeries, "total" | "previousTotal"> {
  const all = names.map((name) => seriesOf(data, name));
  return {
    total: all.reduce((sum, s) => sum + (s.total ?? 0), 0),
    previousTotal: all.reduce((sum, s) => sum + (s.previousTotal ?? 0), 0),
  };
}

/** What ran an agent session, as the `sessions_by_harness` breakdown keys it: a harness id, or a T3 Code thread. */
const sessionSource = (key: string): string =>
  key === "t3_thread"
    ? "T3 Code threads"
    : key in AGENT_HARNESSES
      ? AGENT_HARNESSES[key as keyof typeof AGENT_HARNESSES].label
      : key;

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const STALL_NAMES = ["friction.stalls.stale", "friction.stalls.waiting"];

const FINDING_SEVERITIES = [
  ["blocking", "Blocking", SERIES_COLORS.error],
  ["major", "Major", SERIES_COLORS.warning],
  ["minor", "Minor", SERIES_COLORS.info],
  ["nit", "Nit", SERIES_COLORS.muted],
] as const;

// Every status a run can end in the series, so the columns and bar segments add up to the Runs total; a run still
// queued or running is bucketed by its last update.
const RUN_STATUSES = [
  ["succeeded", "Succeeded", SERIES_COLORS.success, ["succeeded"]],
  ["failed", "Failed", SERIES_COLORS.error, ["failed"]],
  ["skipped", "Skipped", SERIES_COLORS.muted, ["skipped"]],
  ["in_progress", "In progress", SERIES_COLORS.info, ["queued", "running"]],
] as const;

function StatsSections({ data }: { data: StatsResponse }) {
  const previousLabel = `previous ${data.weeks} weeks`;
  const count = (value: number | null) => formatStatsValue(value, "count");
  const kpi = (
    label: string,
    name: string,
    better?: "up" | "down",
    override?: Pick<StatsSeries, "total" | "previousTotal">,
  ) => {
    const series = seriesOf(data, name);
    const { total, previousTotal } = override ?? series;
    return (
      <KpiTile
        label={label}
        value={formatStatsValue(total, series.unit)}
        change={changeVsPrevious(total, previousTotal)}
        better={better}
        previousLabel={previousLabel}
      />
    );
  };

  if (isQuiet(data.series)) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing happened {data.project ? `in ${data.project.title} ` : ""}in the last {data.weeks} weeks, or the weeks
        before. Charts appear as tasks are finished and agents run.
      </p>
    );
  }

  const findingNames = FINDING_SEVERITIES.map(([severity]) => `review_findings.${severity}`);
  const automations = runsByAutomation(data.series);
  const statusSeries = RUN_STATUSES.map(([key, label, color, statuses]): ChartSeries => ({
    key,
    label,
    color,
    values: runsByStatusWeekly(data.series, statuses, data.buckets.length),
  }));

  return (
    <>
      <StatsSection title="Throughput" description="Tasks created and finished each week. Epics aren't counted.">
        <Tiles>
          {kpi("Tasks finished", "tasks_completed", "up")}
          {kpi("Tasks created", "tasks_created")}
        </Tiles>
        <ChartCard title="Created and finished per week">
          <WeeklyBars
            buckets={data.buckets}
            integer
            format={count}
            label="Tasks created and finished per week"
            series={[
              chartSeries(data, "tasks_created", "Created", SERIES_COLORS.muted, { zeros: true }),
              chartSeries(data, "tasks_completed", "Finished", SERIES_COLORS.primary, { zeros: true }),
            ]}
          />
        </ChartCard>
      </StatsSection>

      <StatsSection
        title="Cycle time"
        description="Median time to finish the tasks that finished each week. A gap is a week where nothing finished."
      >
        <Tiles>
          {kpi("In progress to done", "cycle_time.in_progress_to_done", "down")}
          {kpi("Created to done", "cycle_time.created_to_done", "down")}
        </Tiles>
        <ChartCard title="Median cycle time per week">
          <TrendLine
            buckets={data.buckets}
            format={(value) => formatStatsValue(value, "ms")}
            label="Median cycle time per week"
            durations
            series={[
              chartSeries(data, "cycle_time.created_to_done", "Created to done", SERIES_COLORS.muted),
              chartSeries(data, "cycle_time.in_progress_to_done", "In progress to done", SERIES_COLORS.primary),
            ]}
          />
        </ChartCard>
      </StatsSection>

      <StatsSection
        title="PRs, commits and reviews"
        description="Pull requests the board saw merge, commits that landed on each project's default branch, and how often local reviews looped."
      >
        <Tiles>
          {kpi("PRs merged", "prs_merged")}
          {kpi("Commits", "commits")}
          {kpi("Review rounds per task", "review_rounds_per_task", "down")}
          {kpi("Review findings", "review_findings.blocking", "down", sumTotals(data, findingNames))}
        </Tiles>
        <ChartCard title="PRs merged per week">
          <WeeklyBars
            buckets={data.buckets}
            integer
            format={count}
            label="PRs merged per week"
            series={[chartSeries(data, "prs_merged", "PRs merged", SERIES_COLORS.primary, { zeros: true })]}
          />
        </ChartCard>
        <ChartCard title="Commits per week">
          <WeeklyBars
            buckets={data.buckets}
            integer
            format={count}
            label="Commits on the default branch per week"
            series={[chartSeries(data, "commits", "Commits", SERIES_COLORS.primary, { zeros: true })]}
          />
          {data.notes.map((note) => (
            <p key={note} className="mt-2 text-xs text-muted-foreground">
              {note}
            </p>
          ))}
        </ChartCard>
        <ChartCard title="Review rounds per finished task">
          <TrendLine
            buckets={data.buckets}
            format={(value) => formatStatsValue(value, "ratio")}
            label="Average review rounds per finished task, per week"
            series={[chartSeries(data, "review_rounds_per_task", "Rounds per task", SERIES_COLORS.primary)]}
          />
        </ChartCard>
        <ChartCard title="Review findings by severity">
          <WeeklyBars
            buckets={data.buckets}
            mode="stacked"
            integer
            format={count}
            label="Review findings raised per week, by severity"
            series={FINDING_SEVERITIES.map(([severity, label, color]) =>
              chartSeries(data, `review_findings.${severity}`, label, color, {
                zeros: true,
              }),
            )}
          />
        </ChartCard>
      </StatsSection>

      <StatsSection title="Autopilot" description="Runs by the week they finished, and what they cost.">
        <Tiles>
          {kpi("Runs", "autopilot.runs")}
          {kpi("Retries after a failure", "autopilot.retries", "down")}
          {kpi("Cost", "autopilot.cost_usd")}
        </Tiles>
        <ChartCard title="Runs by outcome">
          <WeeklyBars
            buckets={data.buckets}
            mode="stacked"
            integer
            format={count}
            label="Autopilot runs per week, by outcome"
            series={statusSeries}
          />
        </ChartCard>
        {automations.length > 0 ? <AutomationTable rows={automations} /> : null}
        <ChartCard title="Cost per week">
          <WeeklyBars
            buckets={data.buckets}
            format={(value) => formatStatsValue(value, "usd")}
            label="Autopilot cost per week"
            series={[chartSeries(data, "autopilot.cost_usd", "Cost", SERIES_COLORS.primary, { zeros: true })]}
          />
        </ChartCard>
      </StatsSection>

      <StatsSection title="Sessions" description="Agent sessions, by the week they were first linked to a task.">
        <Tiles>{kpi("Sessions started", "agent_sessions_started")}</Tiles>
        <ChartCard title="Sessions started per week">
          <WeeklyBars
            buckets={data.buckets}
            integer
            format={count}
            label="Agent sessions started per week"
            series={[chartSeries(data, "agent_sessions_started", "Sessions", SERIES_COLORS.primary, { zeros: true })]}
          />
        </ChartCard>
      </StatsSection>

      <StatsSection
        title="Friction"
        description="Where agents got stuck or needed you, by the week it happened. None of these is a failure on its own."
      >
        <Tiles>
          {kpi("Steps blocked", "friction.steps_blocked")}
          {kpi("Steps skipped", "friction.steps_skipped")}
          {kpi("Attention requests", "friction.attention_requests")}
          {kpi("Autopilot flags", "friction.autopilot_flags")}
          {kpi("Stalls", "friction.stalls.stale", undefined, sumTotals(data, STALL_NAMES))}
          {kpi("Runs cut short by a restart", "friction.runs_restarted")}
        </Tiles>
        <ChartCard title="Blocked and skipped steps">
          <WeeklyBars
            buckets={data.buckets}
            integer
            format={count}
            label="Steps marked blocked or skipped per week"
            series={[
              chartSeries(data, "friction.steps_blocked", "Blocked", SERIES_COLORS.warning, { zeros: true }),
              chartSeries(data, "friction.steps_skipped", "Skipped", SERIES_COLORS.muted, { zeros: true }),
            ]}
          />
        </ChartCard>
        <ChartCard title="Asks for attention">
          <WeeklyBars
            buckets={data.buckets}
            integer
            format={count}
            label="Attention requests and Autopilot flags per week"
            series={[
              chartSeries(data, "friction.attention_requests", "Agent requests", SERIES_COLORS.info, { zeros: true }),
              chartSeries(data, "friction.autopilot_flags", "Autopilot flags", SERIES_COLORS.warning, {
                zeros: true,
              }),
            ]}
          />
        </ChartCard>
        <ChartCard title="Stalls and restarts">
          <WeeklyBars
            buckets={data.buckets}
            integer
            format={count}
            label="Stalled tasks and runs cut short by a restart, per week"
            series={[
              chartSeries(data, "friction.stalls.stale", "Quiet too long", SERIES_COLORS.warning, { zeros: true }),
              chartSeries(data, "friction.stalls.waiting", "Waiting on input", SERIES_COLORS.info, { zeros: true }),
              chartSeries(data, "friction.runs_restarted", "Runs cut short", SERIES_COLORS.error, { zeros: true }),
            ]}
          />
        </ChartCard>
      </StatsSection>

      <StatsSection
        title="Breakdowns"
        description="The whole period split by category, largest first. A task with several labels counts under each."
      >
        <ChartCard title="Finished tasks by label">
          <Breakdown
            rows={breakdownRows(data.breakdowns.completed_by_label, (key) => key, "No label")}
            label="Finished tasks by label"
            previousLabel={previousLabel}
          />
        </ChartCard>
        <ChartCard title="Finished tasks by suggested model tier">
          <Breakdown
            rows={breakdownRows(data.breakdowns.completed_by_tier, capitalize, "No tier suggested")}
            label="Finished tasks by suggested model tier"
            previousLabel={previousLabel}
          />
        </ChartCard>
        <ChartCard title="Sessions by harness">
          <Breakdown
            rows={breakdownRows(data.breakdowns.sessions_by_harness, sessionSource, "Unknown")}
            label="Agent sessions and T3 Code threads by what ran them"
            previousLabel={previousLabel}
          />
        </ChartCard>
      </StatsSection>
    </>
  );
}

/** Sorted bars for a breakdown, or a line saying nothing fell in it. */
function Breakdown({
  rows,
  label,
  previousLabel,
}: {
  rows: ReturnType<typeof breakdownRows>;
  label: string;
  previousLabel: string;
}) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">Nothing in this period.</p>;
  return <SortedBars rows={rows} color={SERIES_COLORS.primary} label={label} previousLabel={previousLabel} />;
}

function StatsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Tiles({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4">
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      {children}
    </div>
  );
}

function AutomationTable({ rows }: { rows: ReturnType<typeof runsByAutomation> }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border/60 bg-card/40 p-4">
      <h3 className="mb-2 text-sm font-medium">Runs by automation</h3>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 pe-3 text-start font-normal">
              Automation
            </th>
            {RUN_STATUSES.map(([key, label]) => (
              <th key={key} scope="col" className="px-3 py-1 text-end font-normal">
                {label}
              </th>
            ))}
            <th scope="col" className="ps-3 py-1 text-end font-normal">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.automation} className="border-t border-border/40">
              <th scope="row" className="py-1.5 pe-3 text-start font-normal">
                {row.automation}
              </th>
              {RUN_STATUSES.map(([key, , , statuses]) => (
                <td key={key} className="px-3 py-1.5 text-end tabular-nums">
                  {runsInStatuses(row, statuses)}
                </td>
              ))}
              <td className="ps-3 py-1.5 text-end font-medium tabular-nums">{row.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
