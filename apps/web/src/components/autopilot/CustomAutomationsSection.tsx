import { customBlockedReason, describeCustomTrigger, type CustomAutomation } from "@repo/contracts";
import { useNavigate } from "@tanstack/react-router";
import { DownloadIcon, FileUpIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { SettingsNote, SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { FROM_SETTINGS_LIST } from "~/components/settings/settingsNavigation";
import { ConfirmDialog } from "~/components/task/ConfirmDialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { toastManager } from "~/components/ui/toast";
import { downloadText } from "~/lib/download";
import { useCustomAutomations, useDeleteCustomAutomation, useExportCustomAutomation } from "~/state/customAutomations";
import { bundleFilename } from "./customAutomationImport.logic";
import { BlockedWarning } from "./InputsAndSlots";

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

const blockedOf = (custom: CustomAutomation) => customBlockedReason(custom.action);

const actionLabel = (custom: CustomAutomation) =>
  custom.action.kind === "agent" ? "starts an agent" : `runs ${custom.action.command.split("\n")[0]}`;

/**
 * The automations the user defined: what each watches for and does, with edit and delete. Their switches and
 * runner settings are in the automation list like the built-in ones. The editor is a sub-page.
 */
export function CustomAutomationsSection() {
  const navigate = useNavigate();
  const onEdit = (customId: string) =>
    void navigate({ to: "/settings/autopilot/custom/$customId", params: { customId }, state: FROM_SETTINGS_LIST });
  const customs = useCustomAutomations();
  const remove = useDeleteCustomAutomation();
  const exporting = useExportCustomAutomation();
  const onExport = (custom: CustomAutomation) =>
    exporting.mutate(custom.id, {
      onSuccess: (bundle) => {
        downloadText(bundleFilename(custom.name), `${JSON.stringify(bundle, null, 2)}\n`);
        if (bundle.skill) {
          toastManager.add({
            type: "info",
            title: `The skill ${bundle.skill.name} is in the file`,
            description: "Only its SKILL.md travels, not other files beside it. Check it for anything private.",
          });
        }
      },
    });
  const [deleting, setDeleting] = useState<CustomAutomation | null>(null);
  const list = customs.data ?? [];
  return (
    <SettingsSection
      title="Custom automations"
      headerAction={
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            onClick={() => void navigate({ to: "/settings/autopilot/custom/import", state: FROM_SETTINGS_LIST })}
          >
            <FileUpIcon />
            Import
          </Button>
          <Button size="xs" variant="outline" onClick={() => onEdit("new")}>
            <PlusIcon />
            New automation
          </Button>
        </div>
      }
    >
      {customs.isPending ? (
        <SettingsNote>Loading custom automations...</SettingsNote>
      ) : list.length === 0 ? (
        <SettingsRow
          title={customs.error ? "Couldn't load custom automations" : "No custom automations"}
          description={
            customs.error
              ? customs.error.message
              : "Pick a trigger, then start an agent with your prompt or run a command."
          }
        />
      ) : (
        list.map((custom) => (
          <SettingsRow
            key={custom.id}
            title={
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{custom.name}</span>
                <Badge variant="outline" size="sm">
                  {custom.action.kind === "agent" ? "Agent" : "Command"}
                </Badge>
              </span>
            }
            description={`${describeCustomTrigger(custom.trigger)}, ${actionLabel(custom)}`}
            control={
              <div className="flex items-center gap-1">
                <IconAction label={`Export ${custom.name}`} onClick={() => onExport(custom)}>
                  <DownloadIcon />
                </IconAction>
                <IconAction label={`Edit ${custom.name}`} onClick={() => onEdit(custom.id)}>
                  <PencilIcon />
                </IconAction>
                <IconAction destructive label={`Delete ${custom.name}`} onClick={() => setDeleting(custom)}>
                  <Trash2Icon />
                </IconAction>
              </div>
            }
          >
            {blockedOf(custom) ? (
              <div className="mt-2">
                <BlockedWarning reason={blockedOf(custom)!} />
              </div>
            ) : null}
          </SettingsRow>
        ))
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "automation"}?`}
        description="Its switches go with it. Its past runs stay in the history."
        confirmLabel="Delete"
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </SettingsSection>
  );
}
