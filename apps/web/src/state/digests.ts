import { AUTOPILOT_DIGEST, type Digest, type DigestList } from "@repo/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toastManager } from "~/components/ui/toast";
import { api, ApiError } from "~/lib/api";
import { queryKeys, useAutopilotStatus } from "./queries";

/*
 * The Autopilot digest. Every change to one publishes `autopilot.changed`, and useBoardEvents refetches the list on
 * it, which is why the mutations here don't touch the cache.
 */

/** The kept digests, newest first, with how many are unread. */
export function useDigests() {
  return useQuery({
    queryKey: queryKeys.digests,
    queryFn: ({ signal }) => api<DigestList>("/api/autopilot/digests", { signal }),
    staleTime: 0,
  });
}

/** Whether an agent is writing a digest right now: it shows as an active run, which also covers a scheduled one. */
export function useDigestWriting(): boolean {
  return useAutopilotStatus()?.active.some((run) => run.automation === AUTOPILOT_DIGEST) ?? false;
}

/** Marks one digest read. Silent: reading it isn't something to interrupt for. */
export function useMarkDigestRead() {
  return useMutation({
    mutationFn: (id: string) =>
      api<Digest>(`/api/autopilot/digests/${encodeURIComponent(id)}/read`, { method: "POST" }),
  });
}

/**
 * Makes a digest now. A plain one comes back done; one an agent writes comes back with `digest: null` and arrives
 * later, shown by `useDigestWriting`. A second request while one is being written is a 409, told as information.
 */
export function useGenerateDigest() {
  return useMutation({
    mutationFn: () => api<{ digest: Digest | null }>("/api/autopilot/digests", { method: "POST" }),
    onError: (error) => {
      if (error instanceof ApiError && error.code === "CONFLICT") {
        toastManager.add({ type: "info", title: "Already writing a digest", description: error.message });
        return;
      }
      toastManager.add({
        type: "error",
        title: "Couldn't make a digest",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
}
