import { describeSchedule, type Project, type RecurringRuleView } from "@repo/contracts";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { ConfirmDialog } from "~/components/task/ConfirmDialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useBoard, useTemplates } from "~/state/queries";
import {
  useAddSuggestedRule,
  useDeleteRecurringRule,
  useRecurringAutomation,
  useRecurringRules,
  useSetRecurringAutomation,
  useUpdateRecurringRule,
} from "~/state/recurring";
import {
  anchorSchedule,
  emptyRuleForm,
  formFromRule,
  lastTaskLabel,
  nextDueLabel,
  remainingSuggestions,
  type RuleForm,
} from "./recurring.logic";

export interface RuleEdit {
  ruleId: string | null;
  initial: RuleForm;
}

function IconAction({
  label,
  onClick,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant={destructive ? "ghost-destructive" : "ghost-muted"}
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Why the switch reads as it does: where the effective mode comes from. */
const sourceNote = (source: string, enabled: boolean): string => {
  if (source === "board") return enabled ? " On for the whole board." : " Off for the whole board.";
  if (source === "default") return " Off until you switch it on.";
  return "";
};

/**
 * A project's recurring-task rules (the Recurring tasks automation of Autopilot): the project-level switch, the
 * rules and a few example rules to start from. The editor is the caller's, so it can take over the dialog.
 */
export function RecurringSection({ project, onEdit }: { project: Project; onEdit: (edit: RuleEdit) => void }) {
  const rules = useRecurringRules(project.id);
  const automation = useRecurringAutomation(project.id);
  const setAutomation = useSetRecurringAutomation(project.id);
  const templates = useTemplates();
  const paused = useBoard().data?.autopilot.paused ?? false;
  const running = (automation.data?.enabled ?? false) && !paused;
  const update = useUpdateRecurringRule();
  const remove = useDeleteRecurringRule();
  const addSuggested = useAddSuggestedRule(project.id);
  const [deleting, setDeleting] = useState<RecurringRuleView | null>(null);
  const list = rules.data ?? [];
  const suggestions = remainingSuggestions(list);
  const templateName = (rule: RecurringRuleView) =>
    rule.templateId
      ? (templates.data?.find((t) => t.id === rule.templateId)?.name ?? "A template")
      : "Template deleted: pick another";

  return (
    <>
      <SettingsSection
        title="Recurring tasks"
        headerAction={
          <Button size="xs" variant="outline" onClick={() => onEdit({ ruleId: null, initial: emptyRuleForm() })}>
            <PlusIcon />
            New rule
          </Button>
        }
      >
        <SettingsRow
          title="Create recurring tasks here"
          description={`Makes a task from a template on a schedule: a weekly dependency bump, an audit. No agent is involved.${
            automation.data ? sourceNote(automation.data.source, automation.data.enabled) : ""
          }`}
          control={
            <Switch
              aria-label="Create recurring tasks in this project"
              checked={automation.data?.enabled ?? false}
              disabled={!automation.data || setAutomation.isPending}
              onCheckedChange={(checked) => setAutomation.mutate(checked)}
            />
          }
        />
        {list.length === 0 ? (
          <SettingsRow
            title={rules.error ? "Couldn't load the rules" : "No recurring tasks"}
            description={
              rules.error
                ? rules.error.message
                : "Add a rule, or start from one of the examples below. Each needs a template, which says what the task is."
            }
          />
        ) : (
          list.map((rule) => {
            const last = lastTaskLabel(rule);
            return (
              <SettingsRow
                key={rule.id}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{rule.name}</span>
                    {rule.enabled ? null : (
                      <Badge variant="outline" size="sm">
                        Paused
                      </Badge>
                    )}
                    {rule.templateId ? null : (
                      <Badge variant="warning" size="sm">
                        No template
                      </Badge>
                    )}
                  </span>
                }
                description={[
                  describeSchedule(rule.schedule),
                  templateName(rule),
                  rule.enabled ? `Next: ${nextDueLabel(rule, running)}` : null,
                  last ? `Last: ${last}` : null,
                  rule.flagAutopilot ? "Flagged for Autopilot" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                control={
                  <div className="flex items-center gap-1">
                    <Switch
                      aria-label={`${rule.enabled ? "Pause" : "Enable"} ${rule.name}`}
                      checked={rule.enabled}
                      disabled={update.isPending}
                      onCheckedChange={(enabled) => update.mutate({ id: rule.id, enabled })}
                    />
                    <IconAction
                      label={`Edit ${rule.name}`}
                      onClick={() => onEdit({ ruleId: rule.id, initial: formFromRule(rule) })}
                    >
                      <PencilIcon />
                    </IconAction>
                    <IconAction destructive label={`Delete ${rule.name}`} onClick={() => setDeleting(rule)}>
                      <Trash2Icon />
                    </IconAction>
                  </div>
                }
              />
            );
          })
        )}
      </SettingsSection>
      {suggestions.length > 0 ? (
        <SettingsSection title="Examples">
          {suggestions.map((suggestion) => (
            <SettingsRow
              key={suggestion.id}
              title={suggestion.name}
              description={`${suggestion.summary}. Adds a template for this project, which you can edit.`}
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={addSuggested.isPending}
                  onClick={() =>
                    addSuggested.mutate({
                      name: suggestion.name,
                      template: suggestion.template,
                      schedule: anchorSchedule(suggestion.schedule),
                    })
                  }
                >
                  Add
                </Button>
              }
            />
          ))}
        </SettingsSection>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "rule"}?`}
        description="Tasks it already made stay. Its template stays too."
        confirmLabel="Delete"
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </>
  );
}
