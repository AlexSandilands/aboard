import type { Project } from "@taskboard/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toastManager } from "~/components/ui/toast";
import { api } from "~/lib/api";

const archivedKey = ["projects", "archived"] as const;

/** Archived projects aren't in the board snapshot; Settings lists them so they can be restored. */
export function useArchivedProjects(enabled: boolean) {
  return useQuery({
    queryKey: archivedKey,
    queryFn: async ({ signal }) => {
      const projects = await api<Project[]>("/api/projects?includeArchived=true", { signal });
      return projects.filter((p) => p.archivedAt !== null);
    },
    enabled,
    staleTime: 0,
  });
}

export function useUnarchiveProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<Project>(`/api/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: { archived: false } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: archivedKey }),
    onError: (error) => toastManager.add({ type: "error", title: "Couldn't restore project", description: error.message }),
  });
}
