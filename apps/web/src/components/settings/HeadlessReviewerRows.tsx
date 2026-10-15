import type { AppSettings } from "@repo/contracts";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { useTestReviewCli, useUpdateSettings } from "~/state/mutations";
import { BlurInput } from "./BlurInput";
import { SettingsRow } from "./settingsLayout";

/**
 * The board's own reviewer: a fallback for rounds no agent picks up (a card dragged to Review by hand, or an
 * agent that stopped early). It runs Claude Code headless and read-only in the task's worktree.
 */
export function HeadlessReviewerRows({ settings }: { settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  const testCli = useTestReviewCli();
  const check = testCli.data;
  return (
    <>
      <SettingsRow
        title="Board reviewer"
        description="When no agent reviews a round (after a T3 thread was nudged, if there is one), the board runs Claude Code headless and read-only to review it."
        control={
          <Switch
            aria-label="Board reviewer"
            checked={settings.headlessReviewEnabled}
            onCheckedChange={(checked) => updateSettings.mutate({ headlessReviewEnabled: checked })}
          />
        }
      />
      {settings.headlessReviewEnabled ? (
        <>
          <SettingsRow
            title="Claude Code CLI"
            description="Leave empty to use claude from your PATH."
            status={
              check ? (
                check.ok ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Badge variant="success">Found</Badge>
                    {check.version} · <span className="font-mono">{check.path}</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <Badge variant="warning">Not working</Badge>
                    {check.error}
                  </span>
                )
              ) : null
            }
            control={
              <>
                <BlurInput
                  aria-label="Claude Code CLI"
                  size="sm"
                  className="sm:w-56"
                  placeholder="claude"
                  value={settings.headlessReviewCli ?? ""}
                  onSave={(next) => {
                    testCli.reset();
                    updateSettings.mutate({ headlessReviewCli: next.trim() || null });
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={testCli.isPending}
                  onClick={() => testCli.mutate(undefined)}
                >
                  Test
                </Button>
              </>
            }
          />
          <SettingsRow
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
        </>
      ) : null}
    </>
  );
}
