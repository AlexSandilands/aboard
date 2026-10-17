import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { Button } from "~/components/ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useArchivedProjects, useUnarchiveProject } from "./useArchivedProjects";

/** Archived projects, each with Restore. */
export function ArchivedProjectsSection() {
  const archived = useArchivedProjects(true);
  const unarchive = useUnarchiveProject();
  const projects = archived.data ?? [];
  return (
    <SettingsSection id="board.data.archived-projects" title="Archived projects">
      {projects.length === 0 ? (
        <SettingsRow
          title={archived.error ? "Couldn't load archived projects" : "No archived projects"}
          description={archived.error ? archived.error.message : "Archived projects can be restored here."}
        />
      ) : null}
      {projects.map((project) => (
        <SettingsRow
          key={project.id}
          title={
            <span className="flex min-w-0 items-center gap-2">
              <ProjectFavicon title={project.title} icon={project.icon} className="size-4" />
              <span className="truncate">{project.title}</span>
            </span>
          }
          description={
            project.workspaceRoot ? <span className="break-all font-mono">{project.workspaceRoot}</span> : undefined
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={unarchive.isPending && unarchive.variables === project.id}
              onClick={() => unarchive.mutate(project.id)}
            >
              Restore
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}
