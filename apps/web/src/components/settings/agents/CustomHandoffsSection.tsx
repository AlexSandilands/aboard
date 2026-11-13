// Settings → Agents → Custom hand-offs: the user's saved prompts for the tasks' hand-off menus. The same split card as
// Providers and Models: the hand-offs down the left in menu order (drag to reorder), the selected one's editor on the
// right. Every edit saves as it is made. See docs/features/agent-handoff.md#custom-hand-offs.
import {
  CUSTOM_HANDOFF_PLACEHOLDERS,
  CUSTOM_HANDOFFS_MAX,
  customHandoffModel,
  HandoffTarget,
  handoffTargetHarness,
  handoffTargetLabel,
  providerActive,
  PROVIDERS,
  type AppSettings,
  type CustomHandoff,
  type CustomHandoffWorkspace,
  type Project,
} from "@repo/contracts";
import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDownIcon, GripVerticalIcon, PlusIcon, StarIcon, ZapIcon } from "lucide-react";
import { useRef, useState } from "react";
import { HandoffTargetIcon } from "~/components/handoff/CustomHandoffMenu";
import { ModelChoicePicker } from "~/components/models/ModelChoicePicker";
import { ConfirmDialog } from "~/components/task/ConfirmDialog";
import { useSortableSensors } from "~/components/task/ManagedSections";
import { Button } from "~/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import { useUpdateSettings } from "~/state/mutations";
import { useBoard } from "~/state/queries";
import { useSettingsNav } from "~/state/ui";
import { BlurInput } from "../BlurInput";
import {
  createHandoffEdits,
  handoffDoes,
  handoffOfTarget,
  handoffProjectsLabel,
  handoffSummary,
  insertPlaceholder,
  nextHandoffId,
  saveHandoffEdit,
  selectedHandoff,
  WORKSPACE_OPTIONS,
  type HandoffEdit,
} from "../customHandoffs.logic";
import {
  SETTINGS_PICKER_WIDTH,
  SettingsGroup,
  SettingsLink,
  SettingsRow,
  SettingsSectionHeader,
  SettingsSubsection,
} from "../settingsLayout";
import { CONTROL_PICKER, DetailBody, DetailHeader, DetailSection, SplitCard, SplitListAction } from "./SplitCard";

/** What the section reads, so a change elsewhere doesn't re-render it. */
export type HandoffsSettings = Pick<
  AppSettings,
  "customHandoffs" | "providers" | "modelTiers" | "modelProfiles" | "operationModels"
>;

/** Picks HandoffsSettings for useSettingsSelect. */
export const selectHandoffsSettings = ({
  customHandoffs,
  providers,
  modelTiers,
  modelProfiles,
  operationModels,
}: AppSettings): HandoffsSettings => ({ customHandoffs, providers, modelTiers, modelProfiles, operationModels });

const NO_PROJECTS: Project[] = [];
const dragModifiers = [restrictToVerticalAxis, restrictToParentElement];

export function CustomHandoffsSection({ settings }: { settings: HandoffsSettings }) {
  const handoffs = settings.customHandoffs;
  const board = useBoard().data;
  const projects = board?.projects.filter((p) => p.archivedAt === null) ?? NO_PROJECTS;
  const updateSettings = useUpdateSettings();
  const edits = useRef(createHandoffEdits()).current;
  // mutateAsync, since mutate's per-call callbacks only run for the latest of overlapping saves, and each must settle.
  const save = (edit: HandoffEdit) => void saveHandoffEdit(edits, updateSettings.mutateAsync, handoffs, edit);

  // The hand-off the user picked; a reload keeps the one in the URL hash, and a link to one (search) picks it.
  const [picked, setPicked] = useState<string | null>(() =>
    handoffOfTarget(decodeURIComponent(window.location.hash.slice(1))),
  );
  const target = useSettingsNav((s) => s.scrollTarget);
  const [followed, setFollowed] = useState<number | null>(null);
  if (target && target.nonce !== followed) {
    setFollowed(target.nonce);
    const id = handoffOfTarget(target.id);
    if (id) setPicked(id);
  }
  const selected = selectedHandoff(picked, handoffs);

  const add = () => {
    const id = nextHandoffId(handoffs);
    // Selected before the save returns: the list gives the new hand-off this id.
    setPicked(id);
    save({ kind: "add", id });
  };
  const sensors = useSortableSensors();
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) save({ kind: "reorder", id: String(active.id), overId: String(over.id) });
  };
  const full = handoffs.length >= CUSTOM_HANDOFFS_MAX;

  return (
    <SettingsSubsection id="agents.handoffs">
      <section className="space-y-2.5">
        <SettingsSectionHeader title="Custom hand-offs" />
        {handoffs.length === 0 || !selected ? (
          <SettingsGroup>
            <Empty size="compact" className="min-h-0 gap-3 py-8 md:p-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <StarIcon />
                </EmptyMedia>
                <EmptyTitle>No custom hand-offs yet</EmptyTitle>
                <EmptyDescription>
                  Save a prompt you send often, like “run this task's worktree in a sandbox”. It shows in every task's
                  hand-off menu and starts a thread or a session, through the usual dialog filled in or straight away.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button size="sm" variant="outline" onClick={add}>
                  <PlusIcon />
                  Add hand-off
                </Button>
              </EmptyContent>
            </Empty>
          </SettingsGroup>
        ) : (
          <SplitCard
            wideList
            list={
              <div aria-label="Custom hand-offs, in menu order" className="[&>*+*]:border-t [&>*+*]:border-border/50">
                <div role="listbox" aria-label="Custom hand-offs" className="[&>*+*]:border-t [&>*+*]:border-border/50">
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    modifiers={dragModifiers}
                    onDragEnd={onDragEnd}
                  >
                    <SortableContext items={handoffs.map((h) => h.id)} strategy={verticalListSortingStrategy}>
                      {handoffs.map((handoff) => (
                        <HandoffRow
                          key={handoff.id}
                          handoff={handoff}
                          summary={handoffSummary(handoff, settings.modelProfiles, projects)}
                          selected={handoff.id === selected.id}
                          onSelect={() => setPicked(handoff.id)}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                </div>
                <SplitListAction
                  icon={<PlusIcon className="size-4 shrink-0" />}
                  label={full ? `Add hand-off (${CUSTOM_HANDOFFS_MAX} at most)` : "Add hand-off"}
                  disabled={full}
                  onClick={add}
                />
              </div>
            }
          >
            {/* Keyed per hand-off, so a field left mid-edit doesn't carry its draft into the next one's field. */}
            <HandoffEditor
              key={selected.id}
              handoff={selected}
              settings={settings}
              projects={projects}
              save={(patch) => save({ kind: "change", id: selected.id, patch })}
              remove={() => save({ kind: "remove", id: selected.id })}
            />
          </SplitCard>
        )}
      </section>
    </SettingsSubsection>
  );
}

/** One hand-off in the list: a grip to drag it by, what it starts, its name over a summary, and how it starts. */
function HandoffRow({
  handoff,
  summary,
  selected,
  onSelect,
}: {
  handoff: CustomHandoff;
  summary: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { setNodeRef, setActivatorNodeRef, transform, transition, isDragging, attributes, listeners } = useSortable({
    id: handoff.id,
  });
  return (
    <div
      ref={setNodeRef}
      id={`agents.handoffs.${handoff.id}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "relative flex scroll-mt-4 items-center pe-3 transition-colors sm:pe-4",
        selected ? "bg-accent/60" : "hover:bg-muted/25",
        isDragging && "z-10 bg-card shadow-md",
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        aria-label={`Reorder ${handoff.name}`}
        title="Drag to reorder"
        className="flex h-11 w-7 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground/60 outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon aria-hidden className="size-3.5" />
      </button>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-3 text-left outline-none focus-visible:bg-muted/25"
        onClick={onSelect}
      >
        <HandoffTargetIcon target={handoff.target} className="size-4 sm:size-4" />
        <span className="min-w-0 flex-1">
          {/* How it starts sits on the name's line, so the summary under it keeps the row's whole width. */}
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{handoff.name}</span>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-2xs whitespace-nowrap",
                handoff.skipDialog ? "border-primary/60 text-primary" : "border-input text-muted-foreground",
              )}
            >
              {handoff.skipDialog ? <ZapIcon aria-hidden className="size-2.5" /> : null}
              {handoff.skipDialog ? "No dialog" : "Dialog"}
            </span>
          </span>
          <span className="block truncate text-xs text-muted-foreground" title={summary}>
            {summary}
          </span>
        </span>
      </button>
    </div>
  );
}

function HandoffEditor({
  handoff,
  settings,
  projects,
  save,
  remove,
}: {
  handoff: CustomHandoff;
  settings: HandoffsSettings;
  projects: readonly Project[];
  save: (patch: Partial<Omit<CustomHandoff, "id">>) => void;
  remove: () => void;
}) {
  const harness = handoffTargetHarness(handoff.target);
  const targetName = PROVIDERS[handoff.target].label;
  const providerOn = providerActive(settings, handoff.target);
  const { warning } = customHandoffModel(handoff, null, settings);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  return (
    <DetailBody>
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete ${handoff.name}?`}
        description="It goes from every task's hand-off menu. Threads and sessions it started are kept."
        confirmLabel="Delete"
        onConfirm={remove}
      />
      <DetailHeader
        icon={<HandoffTargetIcon target={handoff.target} className="size-6 sm:size-6" />}
        title={handoff.name}
        subtitle={handoffDoes(handoff)}
        actions={
          <Button size="xs" variant="ghost-destructive" onClick={() => setConfirmingDelete(true)}>
            Delete
          </Button>
        }
      />
      <DetailSection title="Hand-off">
        <SettingsRow
          title="Name in the menu"
          control={
            <BlurInput
              size="sm"
              className={cn("w-full", SETTINGS_PICKER_WIDTH)}
              aria-label="Hand-off name"
              value={handoff.name}
              onSave={(name) => save({ name })}
            />
          }
        />
        <SettingsRow
          title="Starts"
          description="What a click on it starts."
          status={
            providerOn ? null : (
              <span className="text-warning-foreground">
                {targetName} isn't added and on in <SettingsLink to="agents.providers">Providers</SettingsLink>, so the
                menus don't offer this hand-off.
              </span>
            )
          }
          control={
            <Select
              items={HandoffTarget.options.map((value) => ({ value, label: handoffTargetLabel(value) }))}
              value={handoff.target}
              onValueChange={(value) => {
                const next = HandoffTarget.safeParse(value);
                if (next.success) save({ target: next.data });
              }}
            >
              <SelectTrigger size="sm" className={cn("w-full min-w-0", SETTINGS_PICKER_WIDTH)} aria-label="Starts">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {HandoffTarget.options.map((value) => (
                  <SelectItem key={value} value={value}>
                    <span className="flex items-center gap-2">
                      <HandoffTargetIcon target={value} className="size-4 sm:size-4" />
                      {handoffTargetLabel(value)}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Prompt"
          description="The first message. A placeholder is filled in for the task it starts on."
          info="{{task}} is the task's reference: its number and title, its link on the board and the get_task call that reads it. Without {{task}} in the prompt, that reference goes at the top, so the agent always knows which task it is on. {{task.branch}} is the branch of the task's pull request or thread, when it has one."
        >
          <PromptField value={handoff.prompt} onSave={(prompt) => save({ prompt })} />
        </SettingsRow>
      </DetailSection>
      <DetailSection title="Launch">
        <SettingsRow
          title="Runs in"
          description={
            handoff.workspace === "task_worktree"
              ? "The worktree the task's work is in. When it has none yet, a new one is made."
              : handoff.workspace === "current"
                ? "The project's own folder, on whatever branch is checked out."
                : "A new worktree from the default branch, or the epic's branch."
          }
          control={
            <Select
              items={WORKSPACE_OPTIONS}
              value={handoff.workspace}
              onValueChange={(value) => {
                const next = WORKSPACE_OPTIONS.find((o) => o.value === value);
                if (next) save({ workspace: next.value satisfies CustomHandoffWorkspace });
              }}
            >
              <SelectTrigger size="sm" className={cn("w-full min-w-0", SETTINGS_PICKER_WIDTH)} aria-label="Runs in">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {WORKSPACE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Start without the dialog"
          description={
            handoff.skipDialog
              ? harness
                ? "A click starts it straight away, on the model below."
                : "A click starts it straight away, on the model below. Access never goes above T3 Code's default."
              : "A click opens the launch dialog with all of this filled in, to change before sending."
          }
          control={
            <Switch
              aria-label="Start without the dialog"
              checked={handoff.skipDialog}
              onCheckedChange={(skipDialog) => save({ skipDialog })}
            />
          }
        />
        <SettingsRow
          title="Model"
          description={handoff.skipDialog ? "Used for every launch." : "Picked in the dialog when it opens."}
          info="Task's model runs each task on what a plain hand-off of it would: a custom model one of its labels picks, else its suggested tier. A tier or a custom model uses the model set for it in Models above."
          status={
            warning ? (
              <span role="note" className="text-warning-foreground">
                {warning}
              </span>
            ) : null
          }
          control={
            <ModelChoicePicker
              op="launch"
              value={handoff.model}
              inherit={{ label: "Task's model", detail: "A label's custom model, else the suggested tier" }}
              // A CLI can only start on its own models; T3 Code's come from the tier or custom model picked.
              lockedProvider={harness}
              ariaLabel={`${handoff.name} model`}
              size="sm"
              className={CONTROL_PICKER}
              onChange={(model) => save({ model: model ?? "inherit" })}
            />
          }
        />
        <SettingsRow
          title="Show on"
          description="The projects whose tasks offer it."
          control={
            <ProjectsPicker
              value={handoff.projectIds}
              projects={projects}
              onChange={(projectIds) => save({ projectIds })}
            />
          }
        />
      </DetailSection>
    </DetailBody>
  );
}

/**
 * The prompt, saved when the field is left, with the placeholders as chips under it: a chip puts its placeholder in at
 * the caret (over the selection) and saves at once.
 */
function PromptField({ value, onSave }: { value: string; onSave: (next: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  // The saved prompt changed under the field (another window): shown, unless this one holds an unsaved edit.
  if (value !== seen) {
    setSeen(value);
    if (draft === seen) setDraft(value);
  }
  const field = useRef<HTMLTextAreaElement>(null);
  const insert = (placeholder: string) => {
    const el = field.current;
    const next = insertPlaceholder(
      draft,
      el?.selectionStart ?? draft.length,
      el?.selectionEnd ?? draft.length,
      placeholder,
    );
    setDraft(next.text);
    onSave(next.text);
    // After the render that puts the text in, or the caret would land at the end.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  };
  return (
    <div className="mt-3 space-y-2">
      <textarea
        ref={field}
        aria-label="Prompt"
        spellCheck={false}
        value={draft}
        placeholder="{{task}}&#10;&#10;What the agent should do."
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) onSave(draft);
        }}
        className="field-sizing-content block max-h-96 min-h-32 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground shadow-xs/5 outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 focus-visible:ring-inset dark:bg-input/32"
      />
      <div role="group" aria-label="Insert a placeholder" className="flex flex-wrap items-center gap-1">
        <span className="me-1 text-xs text-muted-foreground">Insert</span>
        {CUSTOM_HANDOFF_PLACEHOLDERS.map((placeholder) => (
          <button
            key={placeholder}
            type="button"
            // Keeps the field's focus and selection, so the placeholder lands where the caret was.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insert(placeholder)}
            className="cursor-pointer rounded-md border border-border/70 bg-muted/40 px-1.5 py-px font-mono text-2xs text-foreground/80 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {placeholder}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Which projects a hand-off is shown on: all of them, or the ones ticked. */
function ProjectsPicker({
  value,
  projects,
  onChange,
}: {
  value: string[] | null;
  projects: readonly Project[];
  onChange: (next: string[] | null) => void;
}) {
  const toggle = (id: string, on: boolean) => {
    const current = (value ?? []).filter((p) => p !== id);
    onChange(on ? [...current, id] : current);
  };
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            aria-label="Show on"
            className={cn("w-full min-w-0 justify-between font-normal", SETTINGS_PICKER_WIDTH)}
          />
        }
      >
        <span className="truncate">{handoffProjectsLabel(value, projects)}</span>
        <ChevronDownIcon aria-hidden className="-me-1 size-3.5 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56">
        <MenuCheckboxItem checked={value === null} onCheckedChange={() => onChange(null)}>
          All projects
        </MenuCheckboxItem>
        {projects.length ? <MenuSeparator /> : null}
        {projects.map((project) => (
          <MenuCheckboxItem
            key={project.id}
            checked={value?.includes(project.id) ?? false}
            onCheckedChange={(on) => toggle(project.id, on)}
          >
            <span className="block truncate">{project.title}</span>
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
