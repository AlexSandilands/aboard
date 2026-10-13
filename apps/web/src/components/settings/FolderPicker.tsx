import { CornerLeftUpIcon, FolderIcon } from "lucide-react";
import { useState } from "react";
import { queryForEntry, queryForParent } from "~/components/command/palette.logic";
import { useFolderBrowse } from "~/components/command/useFolderBrowse";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

const ROW_CLASS =
  "flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-sm text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** Inline folder browser with the palette's path-typing UX, for changing a project's folder. */
export function FolderPicker(props: { initialPath: string; pending: boolean; onCancel: () => void; onPick: (path: string) => void }) {
  const [query, setQuery] = useState(props.initialPath);
  const browse = useFolderBrowse(query, true);
  const listing = browse.listing;
  const parentPath = listing?.parentPath ?? null;

  function submit() {
    if (browse.resolved.ok && !props.pending) props.onPick(browse.resolved.path);
  }

  return (
    <div className="mt-3 space-y-2">
      <Input
        aria-label="Folder path"
        autoFocus
        font="mono"
        size="sm"
        value={query}
        placeholder="Enter path (e.g. ~/projects/my-app)"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onCancel();
          }
        }}
      />
      <div className="max-h-48 overflow-y-auto rounded-lg border border-border/60">
          <div className="p-1">
            {browse.error ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">{browse.error.message}</p>
            ) : browse.isPending && !listing ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading folders...</p>
            ) : listing ? (
              <>
                {parentPath !== null && browse.leaf === "" ? (
                  <button type="button" className={ROW_CLASS} onClick={() => setQuery(queryForParent(parentPath))}>
                    <CornerLeftUpIcon className="size-4 text-icon-muted" />
                    ..
                  </button>
                ) : null}
                {browse.entries.map((entry) => (
                  <button
                    key={entry.fullPath}
                    type="button"
                    className={ROW_CLASS}
                    onClick={() => setQuery(queryForEntry(query, entry, listing.path))}
                  >
                    <FolderIcon className="size-4 text-icon-muted" />
                    <span className="truncate">{entry.name}</span>
                  </button>
                ))}
                {browse.entries.length === 0 ? <p className="px-2 py-1.5 text-xs text-muted-foreground">No sub-folders.</p> : null}
              </>
            ) : null}
          </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {browse.resolved.ok ? browse.resolved.path : browse.resolved.reason}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={!browse.resolved.ok || props.pending} onClick={submit}>
            Use this folder
          </Button>
        </div>
      </div>
    </div>
  );
}
