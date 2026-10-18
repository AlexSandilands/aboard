import type { Suggestion, SuggestionList } from "@repo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "~/lib/api";
import { toastManager } from "~/components/ui/toast";
import { queryKeys } from "./queries";

/*
 * Agents' suggested changes to prompts and skills. Every change publishes `suggestions.changed`, and useBoardEvents
 * refetches the list on it, so the mutations here don't touch its cache.
 */

const enc = encodeURIComponent;

export function useSuggestions() {
  return useQuery({
    queryKey: queryKeys.suggestions,
    queryFn: ({ signal }) => api<SuggestionList>("/api/suggestions", { signal }),
  });
}

function useDecide(path: "accept" | "reject") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<Suggestion>(`/api/suggestions/${enc(id)}/${path}`, { method: "POST" }),
    // Accepting a change to a built-in skill switches the board's and projects' skill settings to the saved copy.
    onSuccess: (suggestion) => {
      if (suggestion.status === "accepted" && suggestion.target.kind === "builtin") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      }
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: path === "accept" ? "Couldn't apply the change" : "Couldn't reject the suggestion",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
}

export const useAcceptSuggestion = () => useDecide("accept");
export const useRejectSuggestion = () => useDecide("reject");
