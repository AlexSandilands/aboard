import type { TaskTemplate } from "@repo/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CopyIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "~/components/task/ConfirmDialog";
import { scopeLabel, templateSummary } from "~/components/templates/templates.logic";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useDeleteTemplate, useDuplicateTemplate } from "~/state/mutations";
import { useBoard, useTemplates } from "~/state/queries";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { FROM_SETTINGS_LIST } from "./settingsNavigation";

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

/** Templates for new tasks: Bug, Spike and Feature to start with, and any the user adds. Edited on a sub-page. */
export function TemplatesSection() {
  const navigate = useNavigate();
  const onEdit = (templateId: string) =>
    void navigate({
      to: "/settings/tasks/templates/$templateId",
      params: { templateId },
      state: FROM_SETTINGS_LIST,
    });
  const templates = useTemplates();
  const projects = useBoard().data?.projects ?? [];
  const duplicate = useDuplicateTemplate();
  const remove = useDeleteTemplate();
  const [deleting, setDeleting] = useState<TaskTemplate | null>(null);
  const list = templates.data ?? [];

  return (
    <SettingsSection
      id="tasks.new-tasks.templates"
      title="Templates"
      headerAction={
        <Button size="xs" variant="outline" onClick={() => onEdit("new")}>
          <PlusIcon />
          New template
        </Button>
      }
    >
      {list.length === 0 ? (
        <SettingsRow
          title={templates.error ? "Couldn't load templates" : "No templates"}
          description={templates.error ? templates.error.message : "A template pre-fills a new task."}
        />
      ) : (
        list.map((template) => (
          <SettingsRow
            key={template.id}
            title={template.name}
            description={`${scopeLabel(template, projects)} · ${templateSummary(template)}`}
            control={
              <div className="flex items-center gap-0.5">
                <IconAction label={`Edit ${template.name}`} onClick={() => onEdit(template.id)}>
                  <PencilIcon />
                </IconAction>
                <IconAction label={`Duplicate ${template.name}`} onClick={() => duplicate.mutate(template.id)}>
                  <CopyIcon />
                </IconAction>
                <IconAction destructive label={`Delete ${template.name}`} onClick={() => setDeleting(template)}>
                  <Trash2Icon />
                </IconAction>
              </div>
            }
          />
        ))
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "template"}?`}
        description="Tasks already made from it keep what they copied."
        confirmLabel="Delete"
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </SettingsSection>
  );
}
