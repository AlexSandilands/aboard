import {
  customAutomationKey,
  type ApplyAutomationDraftInput,
  type AutomationBundle,
  type AutomationDraft,
  type CreateCustomAutomationInput,
  type CustomAutomation,
  type ImportAutomationInput,
  type ImportedAutomation,
  type TestScriptInput,
  type TestScriptResult,
  type UpdateCustomAutomationInput,
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

/**
 * "Save and turn on" for one just saved in Preview: On where it was made to start, the board for everywhere or each of
 * its projects for Only in…, one write after another as Where it runs sends them.
 */
export const useTurnOnCustomAutomation = () =>
  useCustomMutation(async ({ id, projectIds }: { id: string; projectIds: readonly string[] }) => {
    const key = enc(customAutomationKey(id));
    const paths = projectIds.length > 0 ? projectIds.map((p) => `projects/${enc(p)}`) : ["board"];
    for (const path of paths) await api(`/api/autopilot/${path}/${key}`, { method: "PUT", body: { mode: "on" } });
  });

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

/** Applies a draft that replaces a custom automation: it changes in place, keeping its id and history. */
export const useApplyAutomationDraft = () =>
  useCustomMutation(({ id, ...input }: ApplyAutomationDraftInput & { id: string }) =>
    api<ImportedAutomation>(`/api/autopilot/drafts/${enc(id)}/apply`, { body: input }),
  );

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
