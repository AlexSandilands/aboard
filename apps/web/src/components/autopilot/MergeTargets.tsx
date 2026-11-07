// Merge ready PRs' detail in Settings → Autopilot: its two targets, each with one line, one fact from the board and an
// example behind its info button, and what "ready" means. What an integration branch is sits behind the heading's
// info button (https://claude.ai/artifact/A4spyfjoiAbSSCExN16Tzy, tab 3).
import type { AutopilotAutomation, AutopilotScopeEntry } from "@repo/contracts";
import { SettingsRow } from "~/components/settings/settingsLayout";
import { DetailSection } from "~/components/settings/agents/SplitCard";
import { Badge } from "~/components/ui/badge";
import { useBoard } from "~/state/queries";
import { AutomationField, type ConfigUpdate } from "./AutomationRows";
import { epicsStatus, flaggedStatus, mergeTargetsInfo } from "./mergeTargets.logic";

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
  const field = automation.fields.find((f) => f.key === "intoMain");

  return (
    <>
      <DetailSection
        title="Merges into"
        info="An epic with an integration branch (set on the epic under Delivery) collects its tasks there and reaches main in one pull request at the end, which you merge. Every other task's pull request goes to main."
      >
        <SettingsRow
          title="Epic branches"
          description="Tasks in an epic with its own branch merge into it."
          info="For example: #12 Card vault is in epic #5 One-page checkout, which delivers through epic/5-one-page-checkout. When #12's pull request is ready it merges into that branch, not main. The epic's own pull request into main stays yours to merge."
          status={epicsStatus(info)}
          control={
            <Badge variant="success" size="sm">
              On with this automation
            </Badge>
          }
        />
        {field ? (
          <AutomationField
            automation={automation}
            field={{ ...field, label: "Main" }}
            entry={entry}
            projectId={null}
            rejected={rejected}
            onConfig={onConfig}
            description="Only tasks flagged Auto-merge. Off by default."
            info="Their pull request merges into main when it's ready, one at a time per repository: the same check the merge_task_pr tool uses. Flag a task in its panel's Autopilot section (Autopilot may: merge it), or ask an agent to. After each merge it reads the repository's other pull requests again, so one the merge left conflicting waits for a fix."
            status={flaggedStatus(info)}
          />
        ) : null}
      </DetailSection>
      <DetailSection title="Ready means">
        <SettingsRow
          title="Reviewed, green, mergeable"
          description="Nothing major open, checks pass, no conflicts."
          info="The task is in Review; its local review and Autopilot's review left nothing at or above major open at the latest commit; nobody requested changes; its checks pass; and it merges without conflicts. Anything else waits, and when only you can settle it, the task says why under Needs attention."
        />
      </DetailSection>
    </>
  );
}
