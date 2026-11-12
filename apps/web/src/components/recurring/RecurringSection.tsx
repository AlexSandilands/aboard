import { describeSchedule, type Project, type RecurringRuleView } from "@repo/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { DetailSection } from "~/components/settings/agents/SplitCard";
import { useRowScope, useScopeParam } from "~/components/settings/SettingsScope";
import { SettingsNote, SettingsRow } from "~/components/settings/settingsLayout";
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
 * is the body of each project's group in the Recurring tasks detail in Settings → Autopilot.
 */
export function ProjectRuleRows({ project, withAdd = false }: { project: Project; withAdd?: boolean }) {
  const navigate = useNavigate();
  const scope = useScopeParam();
  const onEdit = (ruleId: string) =>
    void navigate({
      to: "/settings/project/recurring/$ruleId",
      params: { ruleId },
      search: { project: project.id },
      // The editor's `?project=` is the rule's project; leaving it goes back to the scope the list was in.
      state: { ...FROM_SETTINGS_LIST, settingsScope: scope ?? null },
    });
  const rules = useRecurringRules(project.id);
  const templates = useTemplates();
  const paused = useBoard().data?.autopilot.paused ?? false;
  const dryRun = useAutopilotOverview().data?.engine.dryRun ?? false;
  // A rule has no switch above it any more: it acts unless Autopilot is paused or previewing everything.
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
          scope="project"
          title={rules.error ? "Couldn't load the rules" : "No recurring tasks"}
          description={
            rules.error
              ? rules.error.message
              : withAdd
                ? "Add a rule below. Each needs a template."
                : "Add a rule, or start from an example. Each needs a template."
          }
        />
      ) : (
        list.map((rule) => {
          const last = lastTaskLabel(rule);
          return (
            <SettingsRow
              key={rule.id}
              scope="project"
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
          scope="project"
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
 * The recurring rules, the Recurring tasks detail in Settings → Autopilot: every project's, a group each with its own
 * New rule, or with a project chosen in the scope sentence only that project's, with example rules to start from.
 * The automation has no switch; each rule has its own.
 */
export function RecurringRulesByProject() {
  const { project } = useRowScope();
  const projects = useBoard().data?.projects.filter((p) => p.archivedAt === null);
  if (project) {
    return (
      <>
        <DetailSection title={project.title}>
          <ProjectRuleRows project={project} withAdd />
        </DetailSection>
        <RuleExamples project={project} />
      </>
    );
  }
  if (!projects) return <SettingsNote>Loading projects...</SettingsNote>;
  if (projects.length === 0) return <SettingsNote>Add a project to give it recurring rules.</SettingsNote>;
  return (
    <>
      {projects.map((p) => (
        <DetailSection key={p.id} title={p.title}>
          <ProjectRuleRows project={p} withAdd />
        </DetailSection>
      ))}
    </>
  );
}

/** Example rules the project doesn't have yet, each added with a template of its own. */
function RuleExamples({ project }: { project: Project }) {
  const addSuggested = useAddSuggestedRule(project.id);
  const rules = useRecurringRules(project.id);
  const suggestions = remainingSuggestions(rules.data ?? []);
  if (suggestions.length === 0) return null;
  return (
    <DetailSection title="Examples" info="Each adds a template for this project, which you can edit.">
      {suggestions.map((suggestion) => (
        <SettingsRow
          key={suggestion.id}
          scope="project"
          title={suggestion.name}
          description={`${suggestion.summary}.`}
          control={
            <Button
              size="xs"
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
    </DetailSection>
  );
}
