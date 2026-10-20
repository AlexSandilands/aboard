import type {
  AutomationBundle,
  AutomationDraft,
  CreateCustomAutomationInput,
  CustomAutomation,
  ImportAutomationInput,
  ImportedAutomation,
  TestScriptInput,
  TestScriptResult,
  UpdateCustomAutomationInput,
} from "@repo/contracts";
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

export const useImportCustomAutomation = () =>
  useCustomMutation((input: ImportAutomationInput) =>
    api<ImportedAutomation>("/api/autopilot/custom/import", { body: input }),
  );

/** The file for an automation: what it shares, without its projects and the tools filling its slots. */
export const useExportCustomAutomation = () =>
  useCustomMutation((id: string) => api<AutomationBundle>(`/api/autopilot/custom/${enc(id)}/export`));

export const useDeleteCustomAutomation = () =>
  useCustomMutation((id: string) => api<void>(`/api/autopilot/custom/${enc(id)}`, { method: "DELETE" }));

/** Automations agents drafted for the user to review and import, newest first. */
export function useAutomationDrafts() {
  return useQuery({
    queryKey: queryKeys.automationDrafts,
    queryFn: ({ signal }) => api<AutomationDraft[]>("/api/autopilot/drafts", { signal }),
    staleTime: 0,
  });
}

/** One draft; an error once it was imported, dismissed or expired. */
export function useAutomationDraft(id: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.automationDrafts, id],
    queryFn: ({ signal }) => api<AutomationDraft>(`/api/autopilot/drafts/${enc(id ?? "")}`, { signal }),
    enabled: Boolean(id),
    staleTime: 0,
    retry: false,
  });
}

export const useDismissAutomationDraft = () =>
  useCustomMutation((id: string) => api<void>(`/api/autopilot/drafts/${enc(id)}`, { method: "DELETE" }));

/**
 * Runs a draft script once, for real (it can act): the result is shown where it was asked for, so a failure is
 * the panel's to show, not a toast.
 */
export const useTestScript = () =>
  useMutation({
    mutationFn: (input: TestScriptInput) => api<TestScriptResult>("/api/autopilot/custom/test-script", { body: input }),
  });
