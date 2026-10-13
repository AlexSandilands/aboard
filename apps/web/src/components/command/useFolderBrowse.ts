import type { CreateProjectInput, Project } from "@repo/contracts";
import { useMutation } from "@tanstack/react-query";
import { useFsBrowse } from "~/state/queries";
import { api } from "~/lib/api";
import { filterBrowseEntries, isPathQuery, resolveSubmitPath, splitBrowseQuery } from "./palette.logic";

/**
 * T3-style path typing: the directory part of `query` is listed, the leaf filters it,
 * and `resolved` is the absolute folder Enter would pick.
 */
export function useFolderBrowse(query: string, enabled: boolean) {
  const { directory, leaf } = splitBrowseQuery(query);
  const browse = useFsBrowse(directory, enabled && directory.length > 0 && isPathQuery(query));
  const listing = browse.data;
  return {
    leaf,
    listing,
    entries: listing ? filterBrowseEntries(listing.entries, leaf) : [],
    isPending: browse.isPending && browse.fetchStatus !== "idle",
    error: browse.error,
    resolved: resolveSubmitPath(query, listing),
  };
}

/**
 * Creates a project without the shared mutation's error toast, so callers can treat
 * CONFLICT ("already on the board") as information rather than failure.
 */
export function useAddProject() {
  return useMutation({
    mutationFn: (input: CreateProjectInput) => api<Project>("/api/projects", { body: input }),
  });
}
