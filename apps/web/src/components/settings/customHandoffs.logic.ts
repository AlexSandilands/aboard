// Pure helpers for Settings → Agents → Custom hand-offs: adding, editing, reordering and removing a hand-off, the
// list one edit sends, and the lines the list and the editor show.
import {
  CUSTOM_HANDOFF_NAME_MAX,
  CUSTOM_HANDOFF_PROMPT_MAX,
  CUSTOM_HANDOFFS_MAX,
  handoffTargetLabel,
  INHERIT,
  MODEL_TIERS,
  type CustomHandoff,
  type CustomHandoffWorkspace,
  type ModelChoice,
  type ModelProfile,
  type Project,
} from "@repo/contracts";

/** One edit to the list: a new hand-off, fields of one, a drag onto another's place, or a removal. */
export type HandoffEdit =
  | { kind: "add"; id: string }
  | { kind: "change"; id: string; patch: Partial<Omit<CustomHandoff, "id">> }
  | { kind: "reorder"; id: string; overId: string }
  | { kind: "remove"; id: string };

export const WORKSPACE_OPTIONS: ReadonlyArray<{ value: CustomHandoffWorkspace; label: string }> = [
  { value: "new_worktree", label: "New worktree" },
  { value: "task_worktree", label: "Task's worktree" },
  { value: "current", label: "Project checkout" },
];

const NEW_NAME = "New hand-off";

/** An id for a new hand-off from its name, e.g. "Sandbox check" -> "sandbox-check", not one the list already has. */
export function handoffIdFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "hand-off";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** The id the next added hand-off gets, so the caller can select it before the save returns. */
export const nextHandoffId = (list: readonly Pick<CustomHandoff, "id">[]): string =>
  handoffIdFor(NEW_NAME, new Set(list.map((h) => h.id)));

/** A new hand-off: a T3 Code thread through the dialog, with the task's reference to write under. */
export const newHandoff = (id: string): CustomHandoff => ({
  id,
  name: NEW_NAME,
  prompt: "{{task}}\n\n",
  target: "t3-code",
  skipDialog: false,
  model: INHERIT,
  workspace: "new_worktree",
  projectIds: null,
});

/** The list with the edit applied; unchanged when it names a hand-off that isn't there or the list is full. */
export function applyHandoffEdit(list: readonly CustomHandoff[], edit: HandoffEdit): CustomHandoff[] {
  switch (edit.kind) {
    case "add":
      if (list.length >= CUSTOM_HANDOFFS_MAX || list.some((h) => h.id === edit.id)) return [...list];
      return [...list, newHandoff(edit.id)];
    case "change":
      return list.map((handoff) => {
        if (handoff.id !== edit.id) return handoff;
        const { name, prompt, projectIds, ...rest } = edit.patch;
        return {
          ...handoff,
          ...rest,
          // A blank name keeps the old one: the menu has to call it something.
          ...(name !== undefined ? { name: name.trim().slice(0, CUSTOM_HANDOFF_NAME_MAX).trim() || handoff.name } : {}),
          ...(prompt !== undefined ? { prompt: prompt.slice(0, CUSTOM_HANDOFF_PROMPT_MAX) } : {}),
          // No project ticked would show it nowhere, so it reads as every project.
          ...(projectIds !== undefined ? { projectIds: projectIds?.length ? projectIds : null } : {}),
        };
      });
    case "reorder": {
      const from = list.findIndex((h) => h.id === edit.id);
      const to = list.findIndex((h) => h.id === edit.overId);
      if (from < 0 || to < 0 || from === to) return [...list];
      const next = [...list];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    }
    case "remove":
      return list.filter((h) => h.id !== edit.id);
  }
}

/**
 * Builds the list each edit sends. The server replaces the whole list and the cached settings only catch up once it
 * replies, so an edit made while another is saving builds on the list last sent (as createProfileEdits does).
 */
export function createHandoffEdits() {
  let pending: { value: CustomHandoff[]; inflight: number } | null = null;
  return {
    compose(cached: readonly CustomHandoff[], edit: HandoffEdit): CustomHandoff[] {
      const value = applyHandoffEdit(pending?.value ?? cached, edit);
      pending = { value, inflight: (pending?.inflight ?? 0) + 1 };
      return value;
    },
    settle(): void {
      if (!pending) return;
      if (pending.inflight <= 1) pending = null;
      else pending.inflight -= 1;
    },
  };
}

export type HandoffEdits = ReturnType<typeof createHandoffEdits>;

/** Saves one edit, settling when the save ends either way; whoever owns `send` reports a failure. */
export function saveHandoffEdit(
  edits: HandoffEdits,
  send: (update: { customHandoffs: CustomHandoff[] }) => Promise<unknown>,
  cached: readonly CustomHandoff[],
  edit: HandoffEdit,
): Promise<void> {
  const next = edits.compose(cached, edit);
  return send({ customHandoffs: next }).then(
    () => edits.settle(),
    () => edits.settle(),
  );
}

/** "Task's model", "Deep tier", "Codex 6.1", "gpt-5.5": a hand-off's model in a few words. */
export function handoffModelLabel(model: ModelChoice, profiles: readonly Pick<ModelProfile, "id" | "name">[]): string {
  if (model === INHERIT) return "Task's model";
  if ("tier" in model) return `${MODEL_TIERS.find((t) => t.value === model.tier)!.label} tier`;
  if ("profile" in model) return profiles.find((p) => p.id === model.profile)?.name ?? "Deleted model";
  return model.model;
}

/** "All projects", "aboard only", "3 projects": where a hand-off is shown. Projects since deleted aren't counted. */
export function handoffProjectsLabel(
  projectIds: readonly string[] | null,
  projects: readonly Pick<Project, "id" | "title">[],
): string {
  if (!projectIds) return "All projects";
  const shown = projects.filter((p) => projectIds.includes(p.id));
  if (shown.length === 0) return "No project";
  return shown.length === 1 ? `${shown[0]!.title} only` : `${shown.length} projects`;
}

/** The line under a hand-off in the list: where it runs, on what, and for which projects. */
export function handoffSummary(
  handoff: Pick<CustomHandoff, "workspace" | "model" | "projectIds">,
  profiles: readonly Pick<ModelProfile, "id" | "name">[],
  projects: readonly Pick<Project, "id" | "title">[],
): string {
  return [
    WORKSPACE_OPTIONS.find((w) => w.value === handoff.workspace)!.label,
    handoffModelLabel(handoff.model, profiles),
    handoffProjectsLabel(handoff.projectIds, projects).replace(/^All projects$/, "all projects"),
  ].join(" · ");
}

/** What the editor's header says a hand-off does: "Starts a T3 Code thread at once." */
export const handoffDoes = (handoff: Pick<CustomHandoff, "target" | "skipDialog">): string => {
  const what = handoffTargetLabel(handoff.target);
  const a = /^[AEIOU]/.test(what) ? "an" : "a";
  return handoff.skipDialog ? `Starts ${a} ${what} at once.` : `Opens the ${what} dialog filled in.`;
};

/** The text with a placeholder put in over the selection, and where the caret goes after it. */
export function insertPlaceholder(
  text: string,
  start: number,
  end: number,
  placeholder: string,
): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return { text: text.slice(0, from) + placeholder + text.slice(to), caret: from + placeholder.length };
}

/** The hand-off a settings target (a link, a search result) names, or null when it names none. */
export function handoffOfTarget(target: string | null | undefined): string | null {
  const prefix = "agents.handoffs.";
  return target?.startsWith(prefix) && target.length > prefix.length ? target.slice(prefix.length) : null;
}

/** The hand-off the editor shows: the one picked while it is still there, else the first. */
export const selectedHandoff = (picked: string | null, list: readonly CustomHandoff[]): CustomHandoff | null =>
  list.find((h) => h.id === picked) ?? list[0] ?? null;
