// Merge ready PRs' detail in Settings → Autopilot: what an integration branch is, then its two targets, each with one
// sentence, what the board has for it now and an example, and what "ready" means. The mockup it follows is the
// "Opus v2" tab of https://claude.ai/artifact/KBETikzDmZ7zQe6DQzM2qD.
import type { AutopilotAutomation, AutopilotScopeEntry } from "@repo/contracts";
import { ArrowRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SettingsRow } from "~/components/settings/settingsLayout";
import { DetailSection } from "~/components/settings/agents/SplitCard";
import { Badge } from "~/components/ui/badge";
import { useBoard } from "~/state/queries";
import { AutomationField, type ConfigUpdate } from "./AutomationRows";
import { epicsStatus, flaggedStatus, mergeTargetsInfo } from "./mergeTargets.logic";

/** An example of where a task's PR goes, as chips: a task, its branch, and where that ends up. */
function Flow({ children }: { children: ReactNode }) {
  return <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">{children}</div>;
}

function Chip({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <span
      className={`rounded-md border border-border/60 bg-background/60 px-1.5 py-0.5 text-foreground ${mono ? "font-mono" : ""}`}
    >
      {children}
    </span>
  );
}

const Arrow = () => <ArrowRightIcon aria-hidden className="size-3 shrink-0" />;

export function MergeTargets({
  automation,
  entry,
  rejected,
  onConfig,
}: {
  automation: AutopilotAutomation;
  entry: AutopilotScopeEntry;
  rejected: number;
  onConfig: ConfigUpdate;
}) {
  const board = useBoard().data;
  const info = mergeTargetsInfo(board?.tasks ?? []);
  const intoMain = entry.effectiveConfig.intoMain === true;
  const field = automation.fields.find((f) => f.key === "intoMain");
  const epic = info.epics[0];
  const flagged = info.flagged[0];

  return (
    <>
      <p className="px-3 text-sm leading-relaxed text-muted-foreground sm:px-4">
        Some epics collect their tasks on a branch of their own, an{" "}
        <span className="text-foreground">integration branch</span> set on the epic under Delivery, and reach main in
        one pull request at the end. Every other task&apos;s pull request goes straight to main.
      </p>
      <DetailSection title="Merges into">
        <SettingsRow
          title="Into epic branches"
          description="A task in an epic with its own branch merges into that branch when its PR is ready. Main isn't touched."
          info="For example: #12 Card vault is in epic #5 One-page checkout, which delivers through epic/5-one-page-checkout. When #12's pull request is ready it merges into that branch, not main. The epic's own pull request into main stays yours to merge."
          status={epicsStatus(info)}
          control={
            <Badge variant="success" size="sm">
              On with this automation
            </Badge>
          }
        >
          <Flow>
            <Chip>{epic ? `A task of epic #${epic.number}` : "#12 Card vault"}</Chip>
            <Arrow />
            <Chip mono>{epic?.branch ?? "epic/5-one-page-checkout"}</Chip>
            <span className="inline-flex items-center gap-1.5">
              <Arrow />
              main, in one pull request at the end (yours)
            </span>
          </Flow>
        </SettingsRow>
        {field ? (
          <AutomationField
            automation={automation}
            field={field}
            entry={entry}
            projectId={null}
            rejected={rejected}
            onConfig={onConfig}
            description={
              <>
                Only tasks you&apos;ve flagged <span className="text-foreground">Auto-merge</span>: their PR merges into
                main when it&apos;s ready, one at a time per repository. Off unless you switch it on.
              </>
            }
            info="The same check the merge_task_pr tool uses. Flag a task in its panel's Autopilot section (Autopilot may: merge it), or ask an agent to flag it. After each merge it reads the repository's other pull requests again, so one the merge left conflicting waits for a fix."
            status={flaggedStatus(info, intoMain)}
          >
            <Flow>
              <Chip>{flagged ? `#${flagged.number} ${flagged.title}` : "#4 Fix currency rounding"}</Chip>
              <Badge variant="info" size="sm">
                Auto-merge
              </Badge>
              <Arrow />
              <Chip mono>main</Chip>
            </Flow>
          </AutomationField>
        ) : null}
      </DetailSection>
      <DetailSection title="Ready means">
        <SettingsRow
          title="Reviewed, green, mergeable"
          description="The task is in Review, its local review and Autopilot's review left nothing at or above major open at the latest commit, nobody requested changes, its checks pass and it merges without conflicts. Anything else waits; when only you can settle it, the task says why under Needs attention."
        />
      </DetailSection>
    </>
  );
}
