import { useGeneralProject } from "~/state/mutations";
import { usePalette } from "~/state/ui";

/** Opens the new-task form in the General project, which the server unarchives or makes again when needed. */
export function useNewGeneralTask(): { start: () => void; pending: boolean } {
  const general = useGeneralProject();
  return {
    pending: general.isPending,
    start: () => {
      if (general.isPending) return;
      general.mutate(undefined, {
        onSuccess: (project) => usePalette.getState().openPalette({ kind: "new-task", projectId: project.id }),
      });
    },
  };
}
