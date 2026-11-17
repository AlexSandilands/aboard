import { MachineT3Offer, type BoardSnapshot, type MachinesResponse } from "@repo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useOpenSettings } from "~/components/settings/settingsNavigation";
import { toastManager } from "~/components/ui/toast";
import { ApiError, api } from "~/lib/api";
import { useMachineFocus } from "~/state/machines";
import { queryKeys } from "~/state/queries";
import { useDialogs } from "~/state/ui";
import { t3OfferAction, type T3OfferAction } from "./t3Offer.logic";

/**
 * An error toast for a session that couldn't start or open on a machine, with what to do instead when the error offers
 * it (t3Offer.logic.ts): start a T3 Code thread there, or connect that machine's T3 Code first. `before` runs as the
 * action is taken, to close the dialog the toast came from.
 */
export function useT3OfferToast() {
  const queryClient = useQueryClient();
  const openSettings = useOpenSettings();
  const openT3Launch = useDialogs((s) => s.openT3Launch);

  const actionFor = useCallback(
    async (error: unknown, taskId: string): Promise<T3OfferAction | null> => {
      const details = error instanceof ApiError ? error.details : null;
      if (!MachineT3Offer.safeParse(details).success) return null;
      const hold = queryClient.getQueryData<BoardSnapshot>(queryKeys.board)?.tasks.find((t) => t.id === taskId)?.hold;
      // The machines are read only on the Machines page; a recent read is enough to tell whether T3 Code is connected.
      let machines: MachinesResponse | null = null;
      try {
        machines = await queryClient.fetchQuery({
          queryKey: queryKeys.machines,
          queryFn: ({ signal }) => api<MachinesResponse>("/api/machines", { signal }),
          staleTime: 10_000,
        });
      } catch {
        // Not known: the action connects it, where the Machines page says how it stands.
      }
      const offer = MachineT3Offer.parse(details);
      return t3OfferAction(
        details,
        hold,
        machines?.machines.find((m) => m.id === offer.machineId),
      );
    },
    [queryClient],
  );

  return useCallback(
    async (title: string, error: unknown, taskId: string, before?: () => void) => {
      const action = await actionFor(error, taskId);
      const take = (id: string) => {
        toastManager.close(id);
        before?.();
        if (action?.kind === "start") {
          openT3Launch(taskId);
        } else if (action) {
          useMachineFocus.getState().focus(action.machineId);
          openSettings("integrations.machines.list");
        }
      };
      const toastId: string = toastManager.add({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
        ...(action ? { actionProps: { children: action.label, onClick: () => take(toastId) } } : {}),
      });
    },
    [actionFor, openSettings, openT3Launch],
  );
}
