import type { Project } from "@repo/contracts";
import { lazy, Suspense, useState } from "react";
import { withTrailingSeparator } from "~/components/command/palette.logic";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { RecurringSection, type RuleEdit } from "~/components/recurring/RecurringSection";
import { RuleEditorForm } from "~/components/recurring/RuleEditorForm";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { useDeleteProject, useUpdateProject } from "~/state/mutations";
import { useBoard } from "~/state/queries";
import { useDialogs } from "~/state/ui";
import { FolderPicker } from "./FolderPicker";
import { ProjectReviewSection } from "./ProjectReviewSection";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useUnarchiveProject } from "./useArchivedProjects";

// The picker pulls in lucide's full icon index; load it only when someone picks an icon.
const ProjectIconPickerDialog = lazy(() =>
  import("~/components/project/ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

/** Project settings, opened from the sidebar gear via useDialogs().openProjectSettings(id). */
export function ProjectSettingsDialog() {
  const projectId = useDialogs((s) => s.projectSettingsId);
  const close = useDialogs((s) => s.closeProjectSettings);
  const board = useBoard();
  const project = projectId ? board.data?.projects.find((p) => p.id === projectId) : undefined;

  return (
    <Dialog
      open={project !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="max-w-xl">
        {project ? <ProjectSettingsBody key={project.id} project={project} onClose={close} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function ProjectSettingsBody({ project, onClose }: { project: Project; onClose: () => void }) {
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const unarchive = useUnarchiveProject();
  const [title, setTitle] = useState(project.title);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The rule editor takes over the dialog, so it doesn't stack a second modal on this one.
  const [editingRule, setEditingRule] = useState<RuleEdit | null>(null);
  const board = useBoard();
  const taskCount = board.data?.tasks.filter((t) => t.projectId === project.id).length ?? 0;

  function saveTitle() {
    const next = title.trim();
    if (!next) {
      setTitle(project.title);
      return;
    }
    if (next !== project.title) updateProject.mutate({ id: project.id, title: next });
  }

  function archive() {
    updateProject.mutate(
      { id: project.id, archived: true },
      {
        onSuccess: () => {
          onClose();
          toastManager.add({
            type: "success",
            title: "Project archived",
            description: `${project.title} is hidden from the board. Restore it from Settings.`,
            actionProps: { children: "Undo", onClick: () => unarchive.mutate(project.id) },
          });
        },
      },
    );
  }

  if (editingRule) {
    return (
      <RuleEditorForm
        projectId={project.id}
        ruleId={editingRule.ruleId}
        initial={editingRule.initial}
        onCancel={() => setEditingRule(null)}
        onDone={() => setEditingRule(null)}
      />
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Project settings</DialogTitle>
        <DialogDescription>{project.title}</DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-6">
        <SettingsSection title="General">
          <SettingsRow
            title="Name"
            description="Shown on the lane header and in the sidebar."
            control={
              <Input
                aria-label="Project name"
                size="sm"
                className="sm:w-56"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={saveTitle}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
              />
            }
          />
          <SettingsRow
            title="Icon"
            description={project.icon ? "A custom icon." : "Automatic, from the project name."}
            control={
              <>
                <span className="inline-flex size-7 items-center justify-center">
                  <ProjectFavicon title={project.title} icon={project.icon} className="size-5" />
                </span>
                {project.icon ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => updateProject.mutate({ id: project.id, icon: null })}
                  >
                    Reset
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => setIconPickerOpen(true)}>
                  Choose icon
                </Button>
              </>
            }
          />
          <SettingsRow
            title="Workspace folder"
            description={
              project.workspaceRoot ? (
                <span className="break-all font-mono">{project.workspaceRoot}</span>
              ) : (
                "No folder. Agents can't match this project by working directory."
              )
            }
            control={
              browsing ? null : (
                <>
                  {project.workspaceRoot ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => updateProject.mutate({ id: project.id, workspaceRoot: null })}
                    >
                      Clear
                    </Button>
                  ) : null}
                  <Button size="sm" variant="outline" onClick={() => setBrowsing(true)}>
                    {project.workspaceRoot ? "Change" : "Choose"}
                  </Button>
                </>
              )
            }
          >
            {browsing ? (
              <FolderPicker
                initialPath={project.workspaceRoot ? withTrailingSeparator(project.workspaceRoot) : "~/"}
                pending={updateProject.isPending}
                onCancel={() => setBrowsing(false)}
                onPick={(path) =>
                  updateProject.mutate({ id: project.id, workspaceRoot: path }, { onSuccess: () => setBrowsing(false) })
                }
              />
            ) : null}
          </SettingsRow>
          <SettingsRow
            title="Linked T3 project"
            description="Set when the project is imported from T3 Code."
            control={
              project.t3ProjectId ? (
                <span className="truncate font-mono text-xs text-muted-foreground">{project.t3ProjectId}</span>
              ) : (
                <span className="text-xs text-muted-foreground">Not linked</span>
              )
            }
          />
        </SettingsSection>
        <ProjectReviewSection project={project} />
        <RecurringSection project={project} onEdit={setEditingRule} />
        <SettingsSection title="Danger zone">
          <SettingsRow
            title="Archive project"
            description="Hides the lane and its tasks. Restore it any time from Settings."
            control={
              <Button size="sm" variant="outline" disabled={updateProject.isPending} onClick={archive}>
                Archive
              </Button>
            }
          />
          <SettingsRow
            title="Delete project"
            description="Permanently deletes the project and all of its tasks."
            control={
              <Button size="sm" variant="destructive-outline" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            }
          />
        </SettingsSection>
      </DialogPanel>
      {iconPickerOpen ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            title={project.title}
            value={project.icon}
            open={iconPickerOpen}
            onOpenChange={setIconPickerOpen}
            onSave={(icon) => updateProject.mutate({ id: project.id, icon })}
          />
        </Suspense>
      ) : null}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogPopup className="max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete {project.title}?</DialogTitle>
            <DialogDescription>
              {taskCount === 0
                ? "The project will be deleted. This can't be undone."
                : `The project and its ${taskCount === 1 ? "1 task" : `${taskCount} tasks`} will be deleted, including plans, links and activity. This can't be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteProject.isPending}
              onClick={() =>
                deleteProject.mutate(project.id, {
                  onSuccess: () => {
                    setConfirmDelete(false);
                    onClose();
                    toastManager.add({ type: "success", title: "Project deleted", description: project.title });
                  },
                })
              }
            >
              Delete project
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
