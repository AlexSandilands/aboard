import {
  AUTOPILOT_RECURRING,
  type AutopilotScopeEntry,
  type CreateRecurringRuleInput,
  type CreateTemplateInput,
  type RecurringRuleView,
  type TaskTemplate,
  type UpdateRecurringRuleInput,
} from "@repo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "~/lib/api";
import { toastManager } from "~/components/ui/toast";
import { queryKeys } from "./queries";

/*
 * Recurring-task rules. Every change to one publishes `autopilot.changed`, and useBoardEvents refetches these
 * queries on it (so a rule created by a run, or edited in another window, shows up), which is why the mutations
 * here don't touch the cache.
 */

const enc = encodeURIComponent;

/** A project's rules, with when each is next due. */
export function useRecurringRules(projectId: string) {
  return useQuery({
    queryKey: queryKeys.recurringRules(projectId),
    queryFn: ({ signal }) => api<RecurringRuleView[]>(`/api/projects/${enc(projectId)}/recurring`, { signal }),
    staleTime: 0,
  });
}

/** Whether the Recurring tasks automation is on for the project, and where that came from. */
export function useRecurringAutomation(projectId: string) {
  return useQuery({
    queryKey: queryKeys.autopilotScope(projectId),
    queryFn: async ({ signal }) => {
      const entries = await api<AutopilotScopeEntry[]>(`/api/autopilot/projects/${enc(projectId)}`, { signal });
      return entries.find((entry) => entry.automation === AUTOPILOT_RECURRING) ?? null;
    },
    staleTime: 0,
  });
}

function useRecurringMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
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

export const useCreateRecurringRule = (projectId: string) =>
  useRecurringMutation((input: CreateRecurringRuleInput) =>
    api<RecurringRuleView>(`/api/projects/${enc(projectId)}/recurring`, { body: input }),
  );

export const useUpdateRecurringRule = () =>
  useRecurringMutation(({ id, ...input }: UpdateRecurringRuleInput & { id: string }) =>
    api<RecurringRuleView>(`/api/recurring/${enc(id)}`, { method: "PATCH", body: input }),
  );

export const useDeleteRecurringRule = () =>
  useRecurringMutation((id: string) => api<void>(`/api/recurring/${enc(id)}`, { method: "DELETE" }));

/** Turns the Recurring tasks automation on or off for one project (its own mode, whatever the board says). */
export function useSetRecurringAutomation(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) =>
      api<AutopilotScopeEntry[]>(`/api/autopilot/projects/${enc(projectId)}/${AUTOPILOT_RECURRING}`, {
        method: "PUT",
        body: { mode: on ? "on" : "off" },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotScope(projectId) }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Something went wrong",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
}

/**
 * Adds a suggested rule: the project's template of that name (made first, unless it is already there) and the rule
 * that uses it. Two requests, so a failure of the second leaves a template behind that the next try reuses.
 */
export function useAddSuggestedRule(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      name,
      template,
      schedule,
    }: {
      name: string;
      template: Pick<CreateTemplateInput, "titlePattern" | "description" | "labels">;
      schedule: CreateRecurringRuleInput["schedule"];
    }) => {
      const existing = (await api<TaskTemplate[]>(`/api/templates?projectId=${enc(projectId)}`)).find(
        (t) => t.projectId === projectId && t.name.toLowerCase() === name.toLowerCase(),
      );
      const made = existing ?? (await api<TaskTemplate>("/api/templates", { body: { ...template, name, projectId } }));
      void queryClient.invalidateQueries({ queryKey: queryKeys.templates });
      return api<RecurringRuleView>(`/api/projects/${enc(projectId)}/recurring`, {
        body: { name, templateId: made.id, schedule } satisfies CreateRecurringRuleInput,
      });
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't add the rule",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
}
