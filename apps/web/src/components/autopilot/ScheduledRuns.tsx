import { customAutomationKey, type Project } from "@repo/contracts";
import { Badge } from "~/components/ui/badge";
import { formatElapsedDurationLabel } from "~/lib/timestampFormat";
import { useAutopilotRuns } from "~/state/queries";
import { runStatusLabel, runStatusVariant, scheduledAgentRuns, scheduledAnswerOf } from "./autopilot.logic";

const SHOWN = 3;

/**
 * The latest runs of a scheduled agent in each project it runs in, with what each said it did and the handover it left
 * for the next run. A scheduled run has no task, so this is where its answer can be read.
 */
export function ScheduledRuns({ customId, projects }: { customId: string; projects: readonly Project[] }) {
  return (
    <div className="flex flex-col gap-3">
      {projects.map((project) => (
        <ProjectRuns key={project.id} customId={customId} project={project} />
      ))}
    </div>
  );
}

function ProjectRuns({ customId, project }: { customId: string; project: Project }) {
  const runs = scheduledAgentRuns(
    useAutopilotRuns({ projectId: project.id }).data,
    customAutomationKey(customId),
    SHOWN,
  );
  if (runs.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-foreground/80">{project.title}</span>
      <ul className="flex flex-col gap-1.5">
        {runs.map((run) => {
          const answer = scheduledAnswerOf(run);
          const at = run.finishedAt ?? run.startedAt ?? run.createdAt;
          return (
            <li key={run.id} className="flex flex-col gap-0.5 text-xs">
              <div className="flex min-w-0 items-center gap-1.5">
                <Badge variant={runStatusVariant(run.status)} size="sm">
                  {runStatusLabel(run)}
                </Badge>
                <span
                  className="ms-auto shrink-0 tabular-nums text-secondary-label"
                  title={new Date(at).toLocaleString()}
                >
                  {formatElapsedDurationLabel(at)}
                </span>
              </div>
              {run.error ? <p className="text-destructive-foreground [overflow-wrap:anywhere]">{run.error}</p> : null}
              {answer?.summary ? (
                <p className="text-muted-foreground [overflow-wrap:anywhere]">{answer.summary}</p>
              ) : null}
              {answer ? (
                <details className="text-2xs text-muted-foreground">
                  <summary className="w-fit cursor-pointer rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                    Handover
                  </summary>
                  <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted/60 px-2 py-1.5 font-mono whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/85">
                    {answer.handover || "Nothing passed on."}
                  </pre>
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
