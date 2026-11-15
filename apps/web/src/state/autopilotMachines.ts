import type { AutopilotLimits, AutopilotMachine, CustomAutomation, UpdateAutopilotLimitsInput } from "@repo/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toastManager } from "~/components/ui/toast";
import { api } from "~/lib/api";
import { queryKeys } from "./queries";

/*
 * Autopilot on connected machines (docs/features/remote-machines.md#autopilot-on-the-machine): each machine's limits
 * and whether the board's latest settings and Pause all reached it. Under the overview's key, so every
 * autopilot.changed refetches it; machines.changed does too (useBoardEvents). The mutations publish
 * autopilot.changed, so they don't touch the cache.
 */

const enc = encodeURIComponent;

export const autopilotMachinesKey = [...queryKeys.autopilot, "machines"] as const;

export function useAutopilotMachines(enabled = true) {
  return useQuery({
    queryKey: autopilotMachinesKey,
    queryFn: ({ signal }) => api<AutopilotMachine[]>("/api/autopilot/machines", { signal }),
    enabled,
    staleTime: 10_000,
  });
}

const errorToast = (title: string) => (error: unknown) =>
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });

/** Changes a machine's own limits, or with `reset` puts it back on the board's. */
export function useUpdateMachineLimits(machineId: string) {
  return useMutation({
    mutationFn: (input: UpdateAutopilotLimitsInput) =>
      api<{ limits: AutopilotLimits; own: boolean }>(`/api/autopilot/machines/${enc(machineId)}/limits`, {
        method: "PUT",
        body: input,
      }),
    onError: errorToast("Couldn't save the machine's limits"),
  });
}

/** Pins a scheduled custom automation to a machine (null: the board). */
export function useSetAutomationMachine(automationId: string) {
  return useMutation({
    mutationFn: (machineId: string | null) =>
      api<CustomAutomation>(`/api/autopilot/custom/${enc(automationId)}/machine`, {
        method: "PUT",
        body: { machineId },
      }),
    onError: errorToast("Couldn't change where it runs"),
  });
}
