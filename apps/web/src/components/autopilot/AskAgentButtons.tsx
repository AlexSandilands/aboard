// "Ask an agent" on Settings → Autopilot, in the places it fits: to change an automation (its detail header) and to fix a
// failed run (Needs you, the run history). Each builds its prompt when the menu is used (see automationPrompts.ts).
import {
  changeAutomationPrompt,
  customAutomationId,
  fixRunPrompt,
  type AutopilotAutomation,
  type AutopilotRun,
  type CustomAutomation,
} from "@repo/contracts";
import { AskAgentMenu } from "~/components/handoff/HandoffActions";
import { useCustomAutomations } from "~/state/customAutomations";

export function AskToChange({
  automation,
  custom,
  sentence,
}: {
  automation: Pick<AutopilotAutomation, "key" | "title">;
  custom: CustomAutomation | null;
  sentence: string;
}) {
  return (
    <AskAgentMenu
      label={`Ask an agent to change ${automation.title}`}
      threadLabel={`Change ${automation.title}`}
      prompt={() => changeAutomationPrompt({ boardUrl: window.location.origin, automation, custom, sentence })}
      triggerLabel="Ask an agent to change this"
    />
  );
}

/** Beside a failed run: "Ask an agent to fix". `task` is "#12 Title" when the run was on a task. */
export function AskToFix({
  run,
  automationTitle,
  task,
  variant = "ghost-muted",
}: {
  run: AutopilotRun;
  automationTitle: string;
  task: string | null;
  variant?: "ghost-muted" | "outline";
}) {
  const customs = useCustomAutomations().data;
  return (
    <AskAgentMenu
      label={`Ask an agent to fix the failed ${automationTitle} run`}
      threadLabel={`Fix the failed ${automationTitle} run`}
      prompt={() =>
        fixRunPrompt({
          boardUrl: window.location.origin,
          run,
          automation: { key: run.automation, title: automationTitle },
          custom: customs?.find((c) => c.id === customAutomationId(run.automation)) ?? null,
          task,
        })
      }
      projectId={run.projectId}
      writesCode
      variant={variant}
      triggerLabel="Ask an agent to fix"
    />
  );
}
