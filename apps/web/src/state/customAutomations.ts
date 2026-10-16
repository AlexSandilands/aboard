import type { CreateCustomAutomationInput, CustomAutomation, UpdateCustomAutomationInput } from "@repo/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "~/lib/api";
import { toastManager } from "~/components/ui/toast";
import { queryKeys } from "./queries";

/*
 * Custom Autopilot automations. Every change publishes `autopilot.changed`, and useBoardEvents refetches this query
 * and the catalogue on it, so the mutations here don't touch the cache.
 */

const enc = encodeURIComponent;

export function useCustomAutomations() {
  return useQuery({
    queryKey: queryKeys.customAutomations,
    queryFn: ({ signal }) => api<CustomAutomation[]>("/api/autopilot/custom", { signal }),
    staleTime: 0,
  });
}

function useCustomMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
  return useMutation({
    mutationFn: fn,
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Something went wrong",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
}

export const useCreateCustomAutomation = () =>
  useCustomMutation((input: CreateCustomAutomationInput) =>
    api<CustomAutomation>("/api/autopilot/custom", { body: input }),
  );

export const useUpdateCustomAutomation = () =>
  useCustomMutation(({ id, ...input }: UpdateCustomAutomationInput & { id: string }) =>
    api<CustomAutomation>(`/api/autopilot/custom/${enc(id)}`, { method: "PATCH", body: input }),
  );

export const useDeleteCustomAutomation = () =>
  useCustomMutation((id: string) => api<void>(`/api/autopilot/custom/${enc(id)}`, { method: "DELETE" }));
