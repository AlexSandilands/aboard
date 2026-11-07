import { describeSchedule, type Project, type RecurringRuleView } from "@repo/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { DetailSection } from "~/components/settings/agents/SplitCard";
import { SettingsNote, SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { FROM_SETTINGS_LIST } from "~/components/settings/settingsNavigation";
import { ConfirmDialog } from "~/components/task/ConfirmDialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useAutopilotOverview, useBoard, useTemplates } from "~/state/queries";
import {
  useAddSuggestedRule,
  useDeleteRecurringRule,
  useRecurringRules,
  useUpdateRecurringRule,
} from "~/state/recurring";
import { anchorSchedule, lastTaskLabel, nextDueLabel, remainingSuggestions } from "./recurring.logic";

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

/**
 * A project's rules as rows, each with its switch, next run and last task, and the dialog that confirms a delete. It
 * is the body of the project's Recurring tasks section and of each project's group in Settings → Autopilot.
 */
export function ProjectRuleRows({ project, withAdd = false }: { project: Project; withAdd?: boolean }) {
  const navigate = useNavigate();
  const onEdit = (ruleId: string) =>
    void navigate({
      to: "/settings/project/recurring/$ruleId",
      params: { ruleId },
      search: { project: project.id },
      state: FROM_SETTINGS_LIST,
    });
  const rules = useRecurringRules(project.id);
  const templates = useTemplates();
  const paused = useBoard().data?.autopilot.paused ?? false;
  const dryRun = useAutopilotOverview().data?.engine.dryRun ?? false;
  // A rule has no switch above it any more: it acts unless Autopilot is paused or only previewing.
  const running = !paused && !dryRun;
  const update = useUpdateRecurringRule();
  const remove = useDeleteRecurringRule();
  const [deleting, setDeleting] = useState<RecurringRuleView | null>(null);
  const list = rules.data ?? [];
  const templateName = (rule: RecurringRuleView) =>
    rule.templateId
      ? (templates.data?.find((t) => t.id === rule.templateId)?.name ?? "A template")
      : "Template deleted: pick another";

  return (
    <>
      {list.length === 0 ? (
        <SettingsRow
          title={rules.error ? "Couldn't load the rules" : "No recurring tasks"}
          description={
            rules.error ? rules.error.message : "Add a rule, or start from an example. Each needs a template."
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
                  <IconAction label={`Edit ${rule.name}`} onClick={() => onEdit(rule.id)}>
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
      {withAdd ? (
        <SettingsRow
          title="Add a rule"
          description={`Makes a task in ${project.title} from a template on a schedule.`}
          control={
            <Button size="xs" variant="outline" onClick={() => onEdit("new")}>
              <PlusIcon />
              New rule
            </Button>
          }
        />
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

/**
 * Every project's recurring rules, a group each with its own New rule: the Recurring tasks detail in Settings →
 * Autopilot. The automation has no switch; each rule has its own.
 */
export function RecurringRulesByProject() {
  const projects = useBoard().data?.projects.filter((p) => p.archivedAt === null);
  if (!projects) return <SettingsNote>Loading projects...</SettingsNote>;
  if (projects.length === 0) return <SettingsNote>Add a project to give it recurring rules.</SettingsNote>;
  return (
    <>
      {projects.map((project) => (
        <DetailSection key={project.id} title={project.title}>
          <ProjectRuleRows project={project} withAdd />
        </DetailSection>
      ))}
    </>
  );
}

/**
 * A project's recurring-task rules (the Recurring tasks automation of Autopilot): the rules and a few example rules to
 * start from. The rule editor is a sub-page.
 */
export function RecurringSection({ project }: { project: Project }) {
  const navigate = useNavigate();
  const addSuggested = useAddSuggestedRule(project.id);
  const rules = useRecurringRules(project.id);
  const suggestions = remainingSuggestions(rules.data ?? []);
  const onNew = () =>
    void navigate({
      to: "/settings/project/recurring/$ruleId",
      params: { ruleId: "new" },
      search: { project: project.id },
      state: FROM_SETTINGS_LIST,
    });

  return (
    <>
      <SettingsSection
        id="project.recurring.rules"
        title="Recurring tasks"
        headerAction={
          <Button size="xs" variant="outline" onClick={onNew}>
            <PlusIcon />
            New rule
          </Button>
        }
      >
        <ProjectRuleRows project={project} />
      </SettingsSection>
      {suggestions.length > 0 ? (
        <SettingsSection id="project.recurring.examples" title="Examples">
          {suggestions.map((suggestion) => (
            <SettingsRow
              key={suggestion.id}
              title={suggestion.name}
              description={`${suggestion.summary}.`}
              info="Adds a template for this project, which you can edit."
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
    </>
  );
}
