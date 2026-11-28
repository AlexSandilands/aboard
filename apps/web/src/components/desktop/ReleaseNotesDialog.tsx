import { DesktopReleaseList, type DesktopRelease } from "@repo/contracts";
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Markdown } from "~/components/markdown/Markdown";
import { Badge } from "~/components/ui/badge";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Spinner } from "~/components/ui/spinner";
import { useDialogs } from "~/state/ui";
import {
  closeAction,
  defaultRelease,
  detailsSummary,
  groupReleases,
  highlightSections,
  releaseDate,
  releaseNotesHeading,
  type ReleaseNotesBridge,
  type ReleaseNotesMode,
} from "./releaseNotes.logic";

type Loaded =
  | { status: "loading" }
  | { status: "error"; error: string; url: string | null }
  | { status: "ok"; releases: DesktopRelease[] };

/**
 * The desktop app's release notes (mockup B, docs/features/desktop.md#release-notes): the versions on the left, the
 * selected one's notes on the right. After an update the new releases come first, marked; from Settings it is the
 * whole history. Driven by useDialogs().releaseNotes.
 */
export function ReleaseNotesDialog({
  bridge,
  currentVersion,
  showReleaseNotes,
  onShowReleaseNotesChange,
}: {
  bridge: ReleaseNotesBridge;
  currentVersion: string;
  /** The shell's preference, for the footer's checkbox. */
  showReleaseNotes: boolean;
  onShowReleaseNotesChange: (enabled: boolean) => void;
}) {
  const dialog = useDialogs((s) => s.releaseNotes);
  const close = useDialogs((s) => s.closeReleaseNotes);
  // After an update the box is "Don't show after updates", applied when the dialog closes.
  const [stopShowing, setStopShowing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // Try again remounts the content, which asks the shell again; the shell keeps no failure, so it asks GitHub.
  const [attempt, setAttempt] = useState(0);
  const mode: ReleaseNotesMode = dialog?.mode ?? "history";

  const onOpenChange = (open: boolean) => {
    if (open || !dialog) return;
    const action = closeAction(dialog.mode, loadFailed, stopShowing);
    if (action) {
      bridge.dismissWhatsNew(action.stopShowing);
      if (action.stopShowing) onShowReleaseNotesChange(false);
    }
    setStopShowing(false);
    setLoadFailed(false);
    close();
  };

  return (
    <Dialog open={dialog !== null} onOpenChange={onOpenChange}>
      <DialogPopup className="h-[min(40rem,100%)] max-w-3xl" bottomStickOnMobile>
        {dialog ? (
          <ReleaseNotesContent
            key={attempt}
            bridge={bridge}
            mode={mode}
            since={dialog.mode === "update" ? dialog.since : null}
            currentVersion={currentVersion}
            onLoadFailedChange={setLoadFailed}
            onRetry={() => setAttempt((n) => n + 1)}
            footer={
              <label className="flex cursor-pointer items-center gap-2 text-muted-foreground text-sm">
                <input
                  type="checkbox"
                  className="size-3.5 cursor-pointer accent-primary"
                  checked={mode === "update" ? stopShowing : showReleaseNotes}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    if (mode === "update") setStopShowing(checked);
                    else onShowReleaseNotesChange(checked);
                  }}
                />
                {mode === "update" ? "Don't show after updates" : "Show after updates"}
              </label>
            }
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function ReleaseNotesContent({
  bridge,
  mode,
  since,
  currentVersion,
  onLoadFailedChange,
  onRetry,
  footer,
  onClose,
}: {
  bridge: ReleaseNotesBridge;
  mode: ReleaseNotesMode;
  since: string | null;
  currentVersion: string;
  onLoadFailedChange: (failed: boolean) => void;
  onRetry: () => void;
  footer: React.ReactNode;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      let next: Loaded;
      try {
        // A shell newer or older than the page can't hand it a shape it doesn't know.
        const parsed = DesktopReleaseList.safeParse(await bridge.listReleases());
        if (!parsed.success)
          next = { status: "error", error: "The app sent releases this page can't read.", url: null };
        else if (parsed.data.ok) next = { status: "ok", releases: parsed.data.releases };
        else next = { status: "error", error: parsed.data.error, url: parsed.data.url };
      } catch {
        next = { status: "error", error: "The app couldn't read the releases.", url: null };
      }
      if (!live) return;
      setLoaded(next);
      onLoadFailedChange(next.status === "error");
    };
    void load();
    return () => {
      live = false;
    };
  }, [bridge, onLoadFailedChange]);

  const groups = useMemo(
    () => groupReleases(loaded.status === "ok" ? loaded.releases : [], mode === "update" ? since : null),
    [loaded, mode, since],
  );
  const release =
    (selected && [...groups.fresh, ...groups.earlier].find((r) => r.version === selected)) ||
    defaultRelease(groups, currentVersion);
  const heading = releaseNotesHeading(mode, currentVersion, since, groups.fresh.length);
  const githubUrl = release?.url ?? (loaded.status === "error" ? loaded.url : null);

  return (
    <>
      <DialogHeader className="border-b pb-4 max-sm:pb-4">
        <DialogTitle className="text-lg">{heading.title}</DialogTitle>
        <DialogDescription>{heading.description}</DialogDescription>
      </DialogHeader>
      <div
        className={
          loaded.status === "error"
            ? "flex min-h-0 flex-1 flex-col"
            : "grid min-h-0 flex-1 grid-rows-[auto_1fr] sm:grid-cols-[12rem_1fr] sm:grid-rows-1"
        }
      >
        {/* With nothing to list, the error gets the whole width. */}
        {loaded.status === "error" ? null : (
          <VersionList
            loaded={loaded}
            groups={groups}
            since={mode === "update" ? since : null}
            selected={release?.version ?? null}
            onSelect={setSelected}
          />
        )}
        <div className="min-h-0 min-w-0 overflow-y-auto px-6 pt-4 pb-6">
          {loaded.status === "loading" ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner aria-hidden /> Reading the releases from GitHub…
            </div>
          ) : loaded.status === "error" ? (
            <Alert variant="error">
              <AlertTitle>Couldn't load the release notes</AlertTitle>
              <AlertDescription>
                {loaded.error}
                {loaded.url ? " View on GitHub opens them in the browser." : null}
              </AlertDescription>
              <AlertAction>
                <Button size="sm" variant="outline" onClick={onRetry}>
                  Try again
                </Button>
              </AlertAction>
            </Alert>
          ) : release ? (
            <ReleaseNotes release={release} />
          ) : (
            <p className="text-muted-foreground text-sm">No releases are published yet.</p>
          )}
        </div>
      </div>
      <DialogFooter className="items-center sm:justify-between">
        {footer}
        <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
          {githubUrl ? (
            <Button
              variant="outline"
              render={<a href={githubUrl} target="_blank" rel="noreferrer" aria-label="View on GitHub" />}
            >
              View on GitHub
              <ExternalLinkIcon />
            </Button>
          ) : null}
          <Button onClick={onClose}>{mode === "update" ? "Got it" : "Close"}</Button>
        </div>
      </DialogFooter>
    </>
  );
}

/** The versions: a column beside the notes, a scrolling strip above them on a narrow window. */
function VersionList({
  loaded,
  groups,
  since,
  selected,
  onSelect,
}: {
  loaded: Loaded;
  groups: ReturnType<typeof groupReleases>;
  since: string | null;
  selected: string | null;
  onSelect: (version: string) => void;
}) {
  const item = (release: DesktopRelease, fresh: boolean) => (
    <button
      key={release.version}
      type="button"
      aria-current={release.version === selected ? "true" : undefined}
      onClick={() => onSelect(release.version)}
      className="flex shrink-0 cursor-pointer flex-col rounded-md px-2 py-1.5 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-primary/12"
    >
      <span className="flex items-center gap-1.5 font-mono font-semibold text-[0.8125rem]">
        v{release.version}
        {fresh ? <span className="size-1.5 rounded-full bg-primary" aria-label="new" /> : null}
      </span>
      {release.publishedAt ? (
        <span className="text-muted-foreground text-xs">{releaseDate(release.publishedAt)}</span>
      ) : null}
    </button>
  );
  const heading = (text: string) => (
    <div className="px-2 pt-2 pb-1 font-semibold text-[0.6875rem] text-muted-foreground uppercase tracking-wider max-sm:hidden">
      {text}
    </div>
  );
  return (
    <nav
      aria-label="Versions"
      className="flex min-h-0 gap-0.5 overflow-auto border-b p-2 max-sm:flex-row sm:flex-col sm:border-e sm:border-b-0"
    >
      {loaded.status === "loading" ? (
        <Spinner aria-hidden className="m-2 text-muted-foreground" />
      ) : since !== null && groups.fresh.length > 0 ? (
        <>
          {heading(`New since v${since}`)}
          {groups.fresh.map((release) => item(release, true))}
          {groups.earlier.length > 0 ? heading("Earlier") : null}
          {groups.earlier.map((release) => item(release, false))}
        </>
      ) : (
        groups.earlier.map((release) => item(release, false))
      )}
    </nav>
  );
}

function ReleaseNotes({ release }: { release: DesktopRelease }) {
  return (
    <article className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="font-mono font-semibold text-base">v{release.version}</h3>
        {release.publishedAt ? (
          <span className="text-muted-foreground text-xs">{releaseDate(release.publishedAt)}</span>
        ) : null}
      </div>
      {release.highlights ? (
        <Highlights markdown={release.highlights} />
      ) : (
        <p className="text-muted-foreground text-sm italic">
          This release has no highlights, only the list of changes.
        </p>
      )}
      {release.details ? (
        // Keyed by version so each release opens with its own default: folded when there are highlights to read.
        <Collapsible key={release.version} defaultOpen={!release.highlights} className="rounded-lg border bg-muted/40">
          <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-3 py-2 text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
            {detailsSummary(release.details)}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="px-3 pb-3">
              <Markdown size="xs" images={false}>
                {release.details}
              </Markdown>
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </article>
  );
}

/** The Highlights, with New, Improved and Fixed as tinted pills above their bullets; other headings stay plain. */
function Highlights({ markdown }: { markdown: string }) {
  const sections = useMemo(() => highlightSections(markdown), [markdown]);
  return (
    <div className="flex flex-col gap-4">
      {sections.map((section, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- sections are derived from fixed text and never reorder
        <section key={index} className="flex flex-col gap-1.5">
          {section.heading === null ? null : section.tone ? (
            <h4 className="m-0">
              <Badge variant={section.tone} className="rounded-full px-2 font-semibold tracking-wide">
                {section.heading}
              </Badge>
            </h4>
          ) : (
            <h4 className="m-0 font-semibold text-sm">{section.heading}</h4>
          )}
          {section.body ? <Markdown images={false}>{section.body}</Markdown> : null}
        </section>
      ))}
    </div>
  );
}
