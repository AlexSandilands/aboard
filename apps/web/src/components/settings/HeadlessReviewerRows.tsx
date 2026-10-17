import type { AppSettings } from "@repo/contracts";
import { Switch } from "~/components/ui/switch";
import { useUpdateSettings } from "~/state/mutations";
import { BlurInput } from "./BlurInput";
import { SettingsLink, SettingsRow } from "./settingsLayout";

/**
 * The board's own reviewer: a fallback for rounds no agent picks up (a card dragged to Review by hand, or an
 * agent that stopped early). It runs Claude Code headless and read-only in the task's worktree, with the CLI set
 * under Integrations.
 */
export function HeadlessReviewerRows({ settings }: { settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  return (
    <>
      <SettingsRow
        id="tasks.review.board-reviewer"
        title="Board reviewer"
        description={
          <>
            When no agent reviews a round (after a T3 thread was nudged, if there is one), the board runs Claude Code
            headless and read-only to review it. It uses the CLI set under{" "}
            <SettingsLink to="integrations.claude-code.cli-path">Integrations › Claude Code</SettingsLink>.
          </>
        }
        control={
          <Switch
            aria-label="Board reviewer"
            checked={settings.headlessReviewEnabled}
            onCheckedChange={(checked) => updateSettings.mutate({ headlessReviewEnabled: checked })}
          />
        }
      />
      {settings.headlessReviewEnabled ? (
        <SettingsRow
          id="tasks.review.budget"
          title="Budget per review"
          description="The most one board review may spend, in US dollars (claude --max-budget-usd)."
          control={
            <BlurInput
              aria-label="Budget per review in US dollars"
              size="sm"
              className="sm:w-24"
              inputMode="decimal"
              value={String(settings.headlessReviewBudgetUsd)}
              onSave={(next) => {
                const amount = Number(next);
                if (Number.isFinite(amount) && amount > 0 && amount <= 100) {
                  updateSettings.mutate({ headlessReviewBudgetUsd: amount });
                }
              }}
            />
          }
        />
      ) : null}
    </>
  );
}
