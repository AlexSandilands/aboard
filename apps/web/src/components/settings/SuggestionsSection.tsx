import type { SuggestionStatus, SuggestionView } from "@repo/contracts";
import { useMemo, useState } from "react";
import { Markdown } from "~/components/markdown/Markdown";
import { useTaskLinks } from "~/components/markdown/useTaskLinks";
import type { TaskLinks } from "~/components/markdown/Markdown";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { useAcceptSuggestion, useRejectSuggestion, useSuggestions } from "~/state/suggestions";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { foldDiff, lineDiff, parseEvidence, type DiffHunkLine } from "./suggestions.logic";

const STATUS: Record<
  Exclude<SuggestionStatus, "open">,
  { label: string; variant: "success" | "outline" | "warning" }
> = {
  accepted: { label: "Accepted", variant: "success" },
  rejected: { label: "Rejected", variant: "outline" },
  stale: { label: "Out of date", variant: "warning" },
  superseded: { label: "Replaced", variant: "outline" },
};

/**
 * Agents' suggested changes to the prompts and skills the board runs them with. Each open one shows the diff, the
 * agent's reasons and evidence; nothing is written until the user accepts. Decided ones are listed below as history.
 */
export function SuggestionsSection() {
  const suggestions = useSuggestions();
  const taskLinks = useTaskLinks();
  const items = suggestions.data?.items ?? [];
  const open = items.filter((s) => s.status === "open");
  const decided = items.filter((s) => s.status !== "open");
  return (
    <>
      <SettingsSection title={open.length > 0 ? `Suggested changes (${open.length})` : "Suggested changes"}>
        {open.length === 0 ? (
          <SettingsRow
            title={suggestions.error ? "Couldn't load suggestions" : "No suggestions"}
            description={
              suggestions.error
                ? suggestions.error.message
                : "Agents can suggest changes to the review and planning skills you use and to your custom automations' prompts. Each one waits here until you accept or reject it: nothing changes without you."
            }
          />
        ) : (
          open.map((s) => <OpenSuggestion key={s.id} suggestion={s} taskLinks={taskLinks} />)
        )}
      </SettingsSection>
      {decided.length > 0 ? (
        <SettingsSection title="Earlier suggestions">
          {decided.map((s) => (
            <DecidedSuggestion key={s.id} suggestion={s} />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}

function OpenSuggestion({ suggestion: s, taskLinks }: { suggestion: SuggestionView; taskLinks: TaskLinks }) {
  const accept = useAcceptSuggestion();
  const reject = useRejectSuggestion();
  const [full, setFull] = useState(false);
  const busy = accept.isPending || reject.isPending;
  const onAccept = () =>
    accept.mutate(s.id, {
      onSuccess: (result) =>
        toastManager.add(
          result.status === "accepted"
            ? { type: "success", title: "Change applied", description: result.outcome ?? undefined }
            : { type: "warning", title: "Not applied: out of date", description: result.outcome ?? undefined },
        ),
    });
  return (
    <SettingsRow
      title={s.title}
      description={`Suggested by ${s.actor} ${formatRelativeTimeLabel(s.createdAt)}`}
      control={
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant="outline" disabled={busy} onClick={() => reject.mutate(s.id)}>
            Reject
          </Button>
          <Button size="xs" disabled={busy || s.current !== "same"} onClick={onAccept}>
            {s.builtin ? "Save as my own skill" : "Accept"}
          </Button>
        </div>
      }
    >
      <div className="mt-3 space-y-3">
        <Markdown size="xs" images={false} taskLinks={taskLinks}>
          {s.rationale}
        </Markdown>
        {s.evidence.length > 0 ? <EvidenceList evidence={s.evidence} taskLinks={taskLinks} /> : null}
        <Notes suggestion={s} />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{full ? "Proposed text" : "Changes"}</span>
          <Button size="micro" variant="ghost-muted" onClick={() => setFull(!full)}>
            {full ? "Show changes" : "Show the whole proposed text"}
          </Button>
        </div>
        {full ? (
          <pre className="max-h-[32rem] overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap">
            {s.proposed}
          </pre>
        ) : (
          <Diff before={s.baseText} after={s.proposed} />
        )}
      </div>
    </SettingsRow>
  );
}

/** What accepting will do, and why it may not be possible. */
function Notes({ suggestion: s }: { suggestion: SuggestionView }) {
  const notes: Array<{ tone: "warning" | "info"; text: string }> = [];
  if (s.current === "changed") {
    notes.push({
      tone: "warning",
      text: "The text has changed since the agent read it, so this can't be applied. Reject it, or ask the agent to suggest it again.",
    });
  }
  if (s.current === "missing") {
    notes.push({ tone: "warning", text: "This prompt or skill is no longer in use, or its file can't be read." });
  }
  if (s.builtin) {
    notes.push({
      tone: "info",
      text: "This is a built-in skill, which can't be edited. Accepting saves the changed text as your own global skill and switches Settings to it.",
    });
  }
  if (s.inRepo && s.target.kind === "skill") {
    notes.push({
      tone: "info",
      text: `Accepting changes ${s.target.path}, a file in a project's repository: commit it there.`,
    });
  }
  if (notes.length === 0) return null;
  return (
    <ul className="space-y-1">
      {notes.map((note) => (
        <li
          key={note.text}
          className={cn("text-xs", note.tone === "warning" ? "text-warning-foreground" : "text-muted-foreground")}
        >
          {note.text}
        </li>
      ))}
    </ul>
  );
}

function EvidenceList({ evidence, taskLinks }: { evidence: string[]; taskLinks: TaskLinks }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">Evidence:</span>
      {evidence.map((item) => {
        const parsed = parseEvidence(item);
        if (parsed.kind === "task" && taskLinks.isKnown(parsed.number)) {
          return (
            <button
              key={item}
              type="button"
              className="cursor-pointer rounded-sm text-info-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => taskLinks.onOpen(parsed.number)}
            >
              {parsed.text}
            </button>
          );
        }
        if (parsed.kind === "url") {
          return (
            <a
              key={item}
              href={parsed.url}
              target="_blank"
              rel="noreferrer"
              className="text-info-foreground wrap-anywhere hover:underline"
            >
              {parsed.url}
            </a>
          );
        }
        return (
          <span key={item} className="text-foreground/80">
            {parsed.text}
          </span>
        );
      })}
    </div>
  );
}

const LINE_CLASS: Record<Exclude<DiffHunkLine["kind"], "skipped">, string> = {
  same: "text-foreground/70",
  added: "bg-success/10 text-success-foreground",
  removed: "bg-destructive/10 text-destructive-foreground",
};
const LINE_MARK = { same: " ", added: "+", removed: "-" } as const;

/** The change as a line diff, unchanged stretches folded. Every changed line is shown. */
function Diff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => foldDiff(lineDiff(before, after)), [before, after]);
  return (
    <div className="max-h-[32rem] overflow-auto rounded-lg border border-border/60 bg-muted/30 py-2 font-mono text-xs leading-relaxed">
      {lines.map((line, index) =>
        line.kind === "skipped" ? (
          // oxlint-disable-next-line react/no-array-index-key -- lines have no identity; the list is rebuilt whole
          <div key={index} className="px-3 py-0.5 text-muted-foreground/70 italic">
            {line.count} unchanged line{line.count === 1 ? "" : "s"}
          </div>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- lines have no identity; the list is rebuilt whole
          <div key={index} className={cn("flex gap-2 px-3 whitespace-pre-wrap wrap-anywhere", LINE_CLASS[line.kind])}>
            <span aria-hidden className="shrink-0 select-none">
              {LINE_MARK[line.kind]}
            </span>
            <span className="min-w-0">{line.text || " "}</span>
          </div>
        ),
      )}
    </div>
  );
}

function DecidedSuggestion({ suggestion: s }: { suggestion: SuggestionView }) {
  const status = STATUS[s.status as Exclude<SuggestionStatus, "open">];
  const when = s.resolvedAt ?? s.createdAt;
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{s.title}</span>
          <Badge variant={status.variant} size="sm">
            {status.label}
          </Badge>
        </span>
      }
      description={[
        `Suggested by ${s.actor}`,
        s.resolvedBy ? `${status.label.toLowerCase()} by ${s.resolvedBy} ${formatRelativeTimeLabel(when)}` : null,
      ]
        .filter(Boolean)
        .join(", ")}
      status={s.outcome}
    />
  );
}
