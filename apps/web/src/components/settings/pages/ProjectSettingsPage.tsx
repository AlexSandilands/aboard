import type { Project } from "@repo/contracts";
import { FolderIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { withTrailingSeparator } from "~/components/command/palette.logic";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { useDeleteProject, useUpdateProject } from "~/state/mutations";
import { useBoard } from "~/state/queries";
import { FolderPicker } from "../FolderPicker";
import { useSettingsScope } from "../SettingsScope";
import { SettingsGroup, SettingsLink, SettingsRow, SettingsSection, SettingsSubsection } from "../settingsLayout";
import { SettingsScroller, SettingsTopBar } from "../SettingsShell";
import { useUnarchiveProject } from "../useArchivedProjects";

// The picker pulls in lucide's full icon index; load it only when someone picks an icon.
const ProjectIconPickerDialog = lazy(() =>
  import("~/components/project/ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

/**
 * Settings → Project: the project chosen in the scope sentence, itself (name, icon, folder) and its danger zone. Its
 * other settings are where the board's are, on Tasks, Agents and Autopilot in the same scope. With All projects
 * chosen it asks for one.
 */
export function ProjectSettingsPage() {
  const board = useBoard();
  const { project, projects } = useSettingsScope();
  return (
    <>
      <SettingsTopBar group="project" />
      <SettingsScroller>
        {!board.data ? (
          <p className="px-3 text-sm text-muted-foreground sm:px-4">
            {board.error ? board.error.message : "Loading projects..."}
          </p>
        ) : projects.length === 0 ? (
          <p className="px-3 text-sm text-muted-foreground sm:px-4">
            No projects yet. Add one from the board&apos;s sidebar or the command palette.
          </p>
        ) : !project ? (
          <SettingsGroup>
            <Empty size="compact" className="min-h-0 gap-3 py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderIcon />
                </EmptyMedia>
                <EmptyTitle>Choose a project</EmptyTitle>
                <EmptyDescription>
                  Pick one in &ldquo;Applying settings for&rdquo; above to rename it, change its icon or folder, or
                  archive it. Archived projects are under{" "}
                  <SettingsLink to="board.data.archived-projects">Board › Data</SettingsLink>.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </SettingsGroup>
        ) : (
          // Keyed so per-project drafts (the name field, the folder browser) start fresh on a switch.
          <ProjectSections key={project.id} project={project} />
        )}
      </SettingsScroller>
    </>
  );
}

function ProjectSections({ project }: { project: Project }) {
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const unarchive = useUnarchiveProject();
  const { setScope } = useSettingsScope();
  const [title, setTitle] = useState(project.title);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const board = useBoard();
  const taskCount = board.data?.tasks.filter((t) => t.projectId === project.id).length ?? 0;
  // After archiving or deleting, the scope goes back to All projects.
  const clearProject = () => setScope(null);

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
          clearProject();
          toastManager.add({
            type: "success",
            title: "Project archived",
            description: `${project.title} is hidden from the board. Restore it from Settings › Board › Data.`,
            actionProps: { children: "Undo", onClick: () => unarchive.mutate(project.id) },
          });
        },
      },
    );
  }

  return (
    <>
      <SettingsSubsection id="project.general" scope="any">
        <SettingsSection id="project.general.settings" title="General">
          <SettingsRow
            id="project.general.name"
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
            id="project.general.icon"
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
            id="project.general.folder"
            title="Workspace folder"
            description={
              project.workspaceRoot ? (
                <span className="break-all font-mono">{project.workspaceRoot}</span>
              ) : (
                "No folder, so agents can't match it by working directory."
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
            id="project.general.t3-project"
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
      </SettingsSubsection>
      <SettingsSubsection id="project.danger-zone" scope="any">
        <SettingsSection id="project.danger-zone.settings" title="Danger zone">
          <SettingsRow
            id="project.danger-zone.archive"
            title="Archive project"
            description={
              <>
                Hides the lane and its tasks. Restore it any time from{" "}
                <SettingsLink to="board.data.archived-projects">Board › Data</SettingsLink>.
              </>
            }
            control={
              <Button size="sm" variant="outline" disabled={updateProject.isPending} onClick={archive}>
                Archive
              </Button>
            }
          />
          <SettingsRow
            id="project.danger-zone.delete"
            title="Delete project"
            description="Permanently deletes the project and all of its tasks."
            control={
              <Button size="sm" variant="destructive-outline" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            }
          />
        </SettingsSection>
      </SettingsSubsection>
      {iconPickerOpen ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            projectId={project.id}
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
                    clearProject();
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
