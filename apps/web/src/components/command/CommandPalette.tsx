// View-stack command palette, modelled on T3 Code's CommandPalette (MIT) — see NOTICE.
import { TASK_STATUSES, type Project, type T3ProjectCandidate, type TaskSummary } from "@taskboard/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  CornerLeftUpIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderPlusIcon,
  LayersIcon,
  LightbulbIcon,
  ListTodoIcon,
  SearchIcon,
  SettingsIcon,
  SunMoonIcon,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import { ProjectFavicon } from "~/components/project/ProjectFavicon";
import { Button } from "~/components/ui/button";
import { CommandDialog, CommandDialogPopup, CommandFooterAction } from "~/components/ui/command";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useTheme } from "~/hooks/useTheme";
import { ApiError } from "~/lib/api";
import { useCreateTask, useImportT3Projects } from "~/state/mutations";
import { useArchivedTasks, useBoard, useT3ProjectCandidates } from "~/state/queries";
import { type PaletteIntent, useDialogs, usePalette, usePanel } from "~/state/ui";
import { PaletteContent } from "./PaletteContent";
import {
  enabledItemValues,
  ITEM_ICON_CLASS,
  PaletteEmptyState,
  type PaletteGroup,
  type PaletteItem,
  PaletteResults,
} from "./PaletteResults";
import { filterItems, queryForEntry, queryForParent, startsBrowseFromRoot, taskSearchTerms } from "./palette.logic";
import { useAddProject, useFolderBrowse } from "./useFolderBrowse";

type TaskFlow = "idea" | "task";

type PaletteView =
  | { kind: "root" }
  | { kind: "sources" }
  | { kind: "browse"; initialQuery: string }
  | { kind: "import-t3" }
  | { kind: "no-folder" }
  | { kind: "pick-project"; flow: TaskFlow }
  | { kind: "title"; flow: TaskFlow; projectId: string }
  | { kind: "go-to-task" }
  | { kind: "go-to-project" };

function initialStack(intent: PaletteIntent): PaletteView[] {
  const root: PaletteView = { kind: "root" };
  switch (intent.kind) {
    case "root":
      return [root];
    case "add-project":
      return [root, { kind: "sources" }];
    case "import-t3":
      return [root, { kind: "import-t3" }];
    case "go-to-task":
      return [root, { kind: "go-to-task" }];
    case "new-idea":
    case "new-task": {
      const flow: TaskFlow = intent.kind === "new-idea" ? "idea" : "task";
      return intent.projectId
        ? [root, { kind: "title", flow, projectId: intent.projectId }]
        : [root, { kind: "pick-project", flow }];
    }
  }
}

function initialQueryFor(view: PaletteView): string {
  return view.kind === "browse" ? view.initialQuery : "";
}

const intentKeys = new WeakMap<PaletteIntent, number>();
let nextIntentKey = 0;
/** A fresh key per openPalette() call, so each open starts from its intent. */
function intentKey(intent: PaletteIntent): number {
  let key = intentKeys.get(intent);
  if (key === undefined) {
    key = nextIntentKey++;
    intentKeys.set(intent, key);
  }
  return key;
}

const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform);
const MOD_LABEL = isMac ? "⌘" : "Ctrl";

function isPrimaryModifier(event: KeyboardEvent<HTMLInputElement>): boolean {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

function isComposing(event: KeyboardEvent<HTMLInputElement>): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** Stops Base UI from also handling the key (e.g. clicking the highlighted row on Enter). */
function claimKey(event: KeyboardEvent<HTMLInputElement>): void {
  (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
  event.preventDefault();
  event.stopPropagation();
}

const STATUS_LABEL = new Map(TASK_STATUSES.map((s) => [s.value, s.label]));

/** Global command palette (Ctrl/Cmd+K), driven by usePalette(). Mounted once at the root. */
export function CommandPalette() {
  const open = usePalette((s) => s.open);
  const intent = usePalette((s) => s.intent);
  const closePalette = usePalette((s) => s.closePalette);

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closePalette();
      }}
    >
      <CommandDialogPopup aria-label="Command palette" className="overflow-hidden" data-command-palette="true">
        {open ? <PaletteBody key={intentKey(intent)} intent={intent} /> : null}
      </CommandDialogPopup>
    </CommandDialog>
  );
}

function SetupBadge({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  return (
    <span className="ml-auto">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="warning-outline" size="micro" onClick={onClick}>
              {label}
            </Button>
          }
        />
        <TooltipPopup align="end" side="left">
          {hint}
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}

function InputAction(props: { label: string; shortcut: string; disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            tabIndex={-1}
            className="absolute inset-e-2.5 top-1/2 -translate-y-1/2"
            aria-label={`${props.label} (${props.shortcut})`}
            disabled={props.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={props.onClick}
          />
        }
      >
        <span>{props.label}</span>
        <KbdGroup className="pointer-events-none -me-0.5">
          <Kbd>{props.shortcut}</Kbd>
        </KbdGroup>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {props.label} ({props.shortcut})
      </TooltipPopup>
    </Tooltip>
  );
}

/** A non-interactive context row above the results, e.g. the project a new idea goes to. */
function ContextRow(props: { icon: ReactNode; title: ReactNode; description: ReactNode }) {
  return (
    <div className="p-2">
      <div className="flex min-h-8 items-center gap-2 rounded-sm px-2 py-1.5">
        {props.icon}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-foreground text-sm">{props.title}</span>
          <span className="truncate text-muted-foreground/85 text-xs">{props.description}</span>
        </span>
      </div>
    </div>
  );
}

function projectIcon(project: Pick<Project, "title" | "icon">) {
  return <ProjectFavicon title={project.title} icon={project.icon} className="size-4" />;
}

function PaletteBody({ intent }: { intent: PaletteIntent }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const closePalette = usePalette((s) => s.closePalette);
  const lastProjectId = usePalette((s) => s.lastProjectId);
  const setLastProjectId = usePalette((s) => s.setLastProjectId);
  const setAppSettingsOpen = useDialogs((s) => s.setAppSettingsOpen);
  const { resolvedTheme, setTheme } = useTheme();

  const board = useBoard();
  const projects = useMemo(
    () => (board.data?.projects ?? []).filter((p) => p.archivedAt === null).sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0)),
    [board.data?.projects],
  );
  const projectById = useMemo(() => new Map((board.data?.projects ?? []).map((p) => [p.id, p])), [board.data?.projects]);
  const tasks = useMemo(
    () => (board.data?.tasks ?? []).filter((t) => t.archivedAt === null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [board.data?.tasks],
  );
  const t3Detected = board.data?.integrations.t3.detected ?? false;

  const [stack, setStack] = useState<PaletteView[]>(() => initialStack(intent));
  const view = stack.at(-1) ?? { kind: "root" };
  const [query, setQuery] = useState(() => initialQueryFor(view));
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [selectedImports, setSelectedImports] = useState<ReadonlySet<string>>(() => new Set());

  const addProject = useAddProject();
  const createTask = useCreateTask();
  const importProjects = useImportT3Projects();
  const candidates = useT3ProjectCandidates(view.kind === "import-t3" && t3Detected);
  const browse = useFolderBrowse(query, view.kind === "browse");
  // The board snapshot leaves archived tasks out; Go to task lists them in their own group.
  const archivedTasks = useArchivedTasks(view.kind === "go-to-task").data;

  // ── Navigation ─────────────────────────────────────────────────────────

  function pushView(next: PaletteView): void {
    setStack((current) => [...current, next]);
    setQuery(initialQueryFor(next));
    setHighlighted(null);
  }

  function popView(): void {
    if (stack.length <= 1) return;
    setStack((current) => current.slice(0, -1));
    setQuery("");
    setHighlighted(null);
  }

  /** Replaces the query and remounts the input so Base UI drops its highlight. */
  function replaceQuery(next: string): void {
    setQuery(next);
    setHighlighted(null);
    setGeneration((g) => g + 1);
  }

  function handleQueryChange(next: string): void {
    if (view.kind === "root" && startsBrowseFromRoot(next)) {
      pushView({ kind: "browse", initialQuery: next });
      return;
    }
    setQuery(next);
    if (next === "" && view.kind === "browse") popView();
  }

  function openSettings(): void {
    closePalette();
    setAppSettingsOpen(true);
  }

  function openTask(taskId: string): void {
    void navigate({ to: "/", search: (prev) => ({ ...prev, task: taskId }) });
  }

  // ── Actions ────────────────────────────────────────────────────────────

  function submitFolder(): void {
    if (!browse.resolved.ok || addProject.isPending) return;
    addProject.mutate(
      { workspaceRoot: browse.resolved.path },
      {
        onSuccess: (project) => {
          // Re-adding an archived project's folder restores that project (with its tasks).
          const restored = project.createdAt !== project.updatedAt;
          toastManager.add({ type: "success", title: restored ? "Project restored" : "Project added", description: project.title });
          closePalette();
        },
        onError: (error) => {
          // Only an active project can conflict now; archived ones are restored instead.
          if (error instanceof ApiError && error.code === "CONFLICT") {
            toastManager.add({ type: "info", title: "Already on the board", description: error.message });
            closePalette();
            return;
          }
          toastManager.add({ type: "error", title: "Couldn't add project", description: error.message });
        },
      },
    );
  }

  function submitPathlessProject(): void {
    const title = query.trim();
    if (!title || addProject.isPending) return;
    addProject.mutate(
      { title },
      {
        onSuccess: (project) => {
          toastManager.add({ type: "success", title: "Project added", description: project.title });
          closePalette();
        },
        onError: (error) => toastManager.add({ type: "error", title: "Couldn't add project", description: error.message }),
      },
    );
  }

  function submitTitle(keepOpen: boolean): void {
    if (view.kind !== "title") return;
    const title = query.trim();
    if (!title || createTask.isPending) return;
    const { flow, projectId } = view;
    createTask.mutate(
      { projectId, title },
      {
        onSuccess: (task) => {
          setLastProjectId(projectId);
          if (flow === "task") {
            closePalette();
            void navigate({ to: "/", search: (prev) => ({ ...prev, task: task.id }) }).then(() =>
              usePanel.getState().requestPlanEditor(),
            );
            return;
          }
          toastManager.add({
            type: "success",
            title: "Idea added",
            description: `#${task.number} ${task.title}`,
            actionProps: { children: "Open", onClick: () => openTask(task.id) },
          });
          if (keepOpen) replaceQuery("");
          else closePalette();
        },
      },
    );
  }

  function submitImport(): void {
    const ids = [...selectedImports];
    if (ids.length === 0 || importProjects.isPending) return;
    importProjects.mutate(ids, {
      onSuccess: (imported) => {
        toastManager.add({
          type: "success",
          title: imported.length === 1 ? "Imported 1 project" : `Imported ${imported.length} projects`,
          description: imported.map((p) => p.title).join(", ") || undefined,
        });
        closePalette();
      },
    });
  }

  function toggleImport(id: string): void {
    setSelectedImports((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ── Items ──────────────────────────────────────────────────────────────

  const t3Badge = (
    <SetupBadge label="Not detected" hint="Start T3 Code to import its projects. Open Settings for details." onClick={openSettings} />
  );

  function taskItem(task: TaskSummary): PaletteItem {
    const project = projectById.get(task.projectId);
    return {
      value: `task:${task.id}`,
      title: task.title,
      searchTerms: taskSearchTerms(task, project?.title),
      leading: <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">#{task.number}</span>,
      description: [project?.title, STATUS_LABEL.get(task.status)].filter(Boolean).join(" · "),
      icon: project ? projectIcon(project) : <ListTodoIcon className={ITEM_ICON_CLASS} />,
      run: () => {
        closePalette();
        openTask(task.id);
      },
    };
  }

  function projectJumpItem(project: Project): PaletteItem {
    return {
      value: `project:${project.id}`,
      title: project.title,
      searchTerms: [project.workspaceRoot ?? ""],
      description: project.workspaceRoot ?? undefined,
      icon: projectIcon(project),
      run: () => {
        closePalette();
        void navigate({ to: "/", search: (prev) => ({ ...prev, project: project.id }) });
      },
    };
  }

  function buildGroups(): PaletteGroup[] {
    switch (view.kind) {
      case "root": {
        const actions: PaletteItem[] = [
          {
            value: "action:new-idea",
            title: "New idea…",
            searchTerms: ["create", "capture", "add", "task"],
            icon: <LightbulbIcon className={ITEM_ICON_CLASS} />,
            submenu: true,
            run: () => pushView({ kind: "pick-project", flow: "idea" }),
          },
          {
            value: "action:new-task",
            title: "New task with plan…",
            searchTerms: ["create", "plan", "add"],
            icon: <ListTodoIcon className={ITEM_ICON_CLASS} />,
            submenu: true,
            run: () => pushView({ kind: "pick-project", flow: "task" }),
          },
          {
            value: "action:add-project",
            title: "Add project…",
            searchTerms: ["new", "folder", "workspace", "create"],
            icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
            submenu: true,
            run: () => pushView({ kind: "sources" }),
          },
          {
            value: "action:import-t3",
            title: "Import projects from T3 Code…",
            searchTerms: ["t3", "import", "projects"],
            icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
            submenu: true,
            disabled: !t3Detected,
            ...(t3Detected ? {} : { trailing: t3Badge }),
            run: () => pushView({ kind: "import-t3" }),
          },
          {
            value: "action:go-to-task",
            title: "Go to task…",
            searchTerms: ["open", "find", "search", "jump"],
            icon: <SearchIcon className={ITEM_ICON_CLASS} />,
            submenu: true,
            run: () => pushView({ kind: "go-to-task" }),
          },
          {
            value: "action:go-to-project",
            title: "Go to project…",
            searchTerms: ["filter", "jump", "lane"],
            icon: <LayersIcon className={ITEM_ICON_CLASS} />,
            submenu: true,
            run: () => pushView({ kind: "go-to-project" }),
          },
          {
            value: "action:toggle-theme",
            title: "Toggle theme",
            searchTerms: ["dark", "light", "appearance", "mode"],
            icon: <SunMoonIcon className={ITEM_ICON_CLASS} />,
            run: () => {
              closePalette();
              setTheme(resolvedTheme === "dark" ? "light" : "dark");
            },
          },
          {
            value: "action:settings",
            title: "Settings",
            searchTerms: ["preferences", "integrations", "mcp", "github", "jira", "t3"],
            icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
            run: openSettings,
          },
        ];
        const groups: PaletteGroup[] = [{ value: "actions", label: "Actions", items: filterItems(actions, query) }];
        if (query.trim()) {
          groups.push({ value: "tasks", label: "Tasks", items: filterItems(tasks.map(taskItem), query).slice(0, 8) });
          groups.push({ value: "projects", label: "Projects", items: filterItems(projects.map(projectJumpItem), query).slice(0, 6) });
        }
        return groups;
      }
      case "sources": {
        const items: PaletteItem[] = [
          {
            value: "source:local",
            title: "Local folder",
            description: "Browse a folder on disk",
            searchTerms: ["local", "folder", "directory", "browse"],
            icon: <FolderPlusIcon className={ITEM_ICON_CLASS} />,
            run: () => pushView({ kind: "browse", initialQuery: "~/" }),
          },
          {
            value: "source:t3",
            title: "From T3 Code",
            description: "Import projects T3 Code already knows",
            searchTerms: ["t3", "import"],
            icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
            submenu: true,
            disabled: !t3Detected,
            ...(t3Detected ? {} : { trailing: t3Badge }),
            run: () => pushView({ kind: "import-t3" }),
          },
          {
            value: "source:none",
            title: "Without a folder",
            description: "Title only",
            searchTerms: ["pathless", "title", "empty"],
            icon: <FolderIcon className={ITEM_ICON_CLASS} />,
            submenu: true,
            run: () => pushView({ kind: "no-folder" }),
          },
        ];
        return [{ value: "sources", label: "Add project", items: filterItems(items, query) }];
      }
      case "browse": {
        const listing = browse.listing;
        if (!listing) return [];
        const items: PaletteItem[] = [];
        if (listing.parentPath !== null && browse.leaf === "") {
          const parentPath = listing.parentPath;
          items.push({
            value: "browse:up",
            title: "..",
            searchTerms: [],
            icon: <CornerLeftUpIcon className={ITEM_ICON_CLASS} />,
            run: () => replaceQuery(queryForParent(parentPath)),
          });
        }
        for (const entry of browse.entries) {
          items.push({
            value: `browse:${entry.fullPath}`,
            title: entry.name,
            searchTerms: [],
            icon: <FolderIcon className={ITEM_ICON_CLASS} />,
            run: () => replaceQuery(queryForEntry(query, entry, listing.path)),
          });
        }
        return [{ value: "directories", label: "Directories", items }];
      }
      case "import-t3": {
        const list: ReadonlyArray<T3ProjectCandidate> = candidates.data ?? [];
        const items = filterItems(
          list.map((candidate): PaletteItem => {
            const onBoard = candidate.existingProjectId !== null;
            const selected = selectedImports.has(candidate.t3ProjectId);
            return {
              value: `t3:${candidate.t3ProjectId}`,
              title: candidate.title,
              description: candidate.workspaceRoot,
              searchTerms: [candidate.workspaceRoot],
              icon: projectIcon(candidate),
              disabled: onBoard,
              trailing: onBoard ? (
                <span className="ms-auto shrink-0 text-muted-foreground text-xs">On board</span>
              ) : (
                <span className="ms-auto inline-flex size-4 shrink-0 items-center justify-center">
                  {selected ? <CheckIcon className="size-4 text-primary" /> : null}
                </span>
              ),
              run: () => toggleImport(candidate.t3ProjectId),
            };
          }),
          query,
        );
        // Importing is a footer action (and Mod+Enter) rather than a row, so toggling a
        // selection never shifts the highlighted row.
        return [{ value: "candidates", label: "T3 Code projects", items }];
      }
      case "pick-project": {
        const preferredId =
          (search.project && projectById.has(search.project) ? search.project : null) ??
          (lastProjectId && projectById.has(lastProjectId) ? lastProjectId : null);
        const ordered = preferredId
          ? [...projects.filter((p) => p.id === preferredId), ...projects.filter((p) => p.id !== preferredId)]
          : projects;
        const flow = view.flow;
        const items = ordered.map(
          (project): PaletteItem => ({
            value: `pick:${project.id}`,
            title: project.title,
            description:
              project.id === preferredId
                ? search.project === project.id
                  ? "Current filter"
                  : "Last used"
                : (project.workspaceRoot ?? undefined),
            searchTerms: [project.workspaceRoot ?? ""],
            icon: projectIcon(project),
            submenu: true,
            run: () => pushView({ kind: "title", flow, projectId: project.id }),
          }),
        );
        return [{ value: "projects", label: flow === "idea" ? "New idea in…" : "New task in…", items: filterItems(items, query) }];
      }
      case "go-to-task": {
        const limit = (items: PaletteItem[]) => (query.trim() ? items : items.slice(0, 50));
        const groups = [{ value: "tasks", label: "Tasks", items: limit(filterItems(tasks.map(taskItem), query)) }];
        const archived = limit(filterItems((archivedTasks ?? []).map(taskItem), query));
        if (archived.length > 0) groups.push({ value: "archived-tasks", label: "Archived tasks", items: archived });
        return groups;
      }
      case "go-to-project": {
        const items: PaletteItem[] = [];
        if (search.project) {
          items.push({
            value: "project:all",
            title: "All projects",
            searchTerms: ["clear", "filter", "everything"],
            icon: <LayersIcon className={ITEM_ICON_CLASS} />,
            run: () => {
              closePalette();
              void navigate({ to: "/", search: (prev) => ({ ...prev, project: undefined }) });
            },
          });
        }
        items.push(...projects.map(projectJumpItem));
        return [{ value: "projects", label: "Projects", items: filterItems(items, query) }];
      }
      case "title":
      case "no-folder":
        return [];
    }
  }

  const groups = buildGroups();
  const itemValues = enabledItemValues(groups);
  const isSubmenu = stack.length > 1;
  const hasHighlightedFolder = view.kind === "browse" && highlighted !== null && highlighted.startsWith("browse:");
  const titleProject = view.kind === "title" ? projectById.get(view.projectId) : undefined;

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Backspace" && query === "" && isSubmenu) {
      claimKey(event);
      popView();
      return;
    }
    if (event.key !== "Enter" || isComposing(event)) return;
    switch (view.kind) {
      case "title":
        claimKey(event);
        submitTitle(event.shiftKey);
        return;
      case "no-folder":
        claimKey(event);
        submitPathlessProject();
        return;
      case "browse":
        if (!hasHighlightedFolder || isPrimaryModifier(event)) {
          claimKey(event);
          submitFolder();
        }
        return;
      case "import-t3":
        if (isPrimaryModifier(event)) {
          claimKey(event);
          submitImport();
        }
        return;
      default:
        return;
    }
  }

  // ── View chrome ────────────────────────────────────────────────────────

  let placeholder = "Search commands, tasks, and projects...";
  let footerActionLabel: string | undefined = "Select";
  let inputAccessory: ReactNode = null;
  let inputClassName: string | undefined;
  let footerTrailing: ReactNode = null;
  let preamble: ReactNode = null;
  let emptyStateMessage: ReactNode = "No matching commands.";

  switch (view.kind) {
    case "sources":
      placeholder = "Search sources...";
      break;
    case "browse": {
      placeholder = "Enter path (e.g. ~/projects/my-app)";
      footerActionLabel = hasHighlightedFolder ? "Select" : undefined;
      const shortcut = hasHighlightedFolder ? `${MOD_LABEL} Enter` : "Enter";
      inputAccessory = (
        <InputAction
          label={addProject.isPending ? "Adding" : "Add"}
          shortcut={shortcut}
          disabled={!browse.resolved.ok || addProject.isPending}
          onClick={submitFolder}
        />
      );
      inputClassName = hasHighlightedFolder ? "*:data-[slot=autocomplete-input]:pe-30!" : "*:data-[slot=autocomplete-input]:pe-24!";
      if (browse.error) {
        preamble = (
          <div role="alert" className="px-4 py-3 text-sm text-muted-foreground">
            {browse.error.message}
          </div>
        );
      } else if (browse.isPending && !browse.listing) {
        preamble = (
          <div role="status" className="px-4 py-3 text-sm text-muted-foreground">
            Loading folders...
          </div>
        );
      }
      emptyStateMessage = browse.error || browse.isPending ? undefined : browse.resolved.ok ? "Press Enter to add this folder." : browse.resolved.reason;
      break;
    }
    case "import-t3":
      placeholder = "Search T3 Code projects...";
      footerActionLabel = "Toggle";
      footerTrailing =
        selectedImports.size > 0 ? (
          <CommandFooterAction disabled={importProjects.isPending} onClick={submitImport}>
            {importProjects.isPending ? "Importing…" : `Import ${selectedImports.size}`}
            <Kbd>{MOD_LABEL} Enter</Kbd>
          </CommandFooterAction>
        ) : null;
      emptyStateMessage = !t3Detected
        ? "T3 Code not detected. Start T3 Code to import its projects."
        : candidates.isPending
          ? "Loading T3 Code projects..."
          : candidates.error
            ? candidates.error.message
            : (candidates.data?.length ?? 0) === 0
              ? "T3 Code has no projects."
              : "No matching projects.";
      break;
    case "no-folder":
      placeholder = "Project title";
      footerActionLabel = "Add";
      inputAccessory = (
        <InputAction
          label={addProject.isPending ? "Adding" : "Add"}
          shortcut="Enter"
          disabled={!query.trim() || addProject.isPending}
          onClick={submitPathlessProject}
        />
      );
      inputClassName = "*:data-[slot=autocomplete-input]:pe-24!";
      preamble = (
        <ContextRow
          icon={<FolderIcon className={ITEM_ICON_CLASS} />}
          title={query.trim() || "New project"}
          description="A project without a workspace folder"
        />
      );
      emptyStateMessage = undefined;
      break;
    case "pick-project":
      placeholder = "Search projects...";
      emptyStateMessage = projects.length === 0 ? "Add a project first." : "No matching projects.";
      break;
    case "title":
      placeholder = view.flow === "idea" ? "Idea title…" : "Task title…";
      footerActionLabel = "Create";
      inputAccessory = (
        <InputAction
          label={createTask.isPending ? "Creating" : "Create"}
          shortcut="Enter"
          disabled={!query.trim() || createTask.isPending}
          onClick={() => submitTitle(false)}
        />
      );
      inputClassName = "*:data-[slot=autocomplete-input]:pe-32!";
      preamble = (
        <ContextRow
          icon={titleProject ? projectIcon(titleProject) : <FolderIcon className={ITEM_ICON_CLASS} />}
          title={titleProject?.title ?? "Unknown project"}
          description={
            view.flow === "idea" ? "Lands in Ideas · Shift+Enter to add another" : "Opens the task with the plan editor"
          }
        />
      );
      emptyStateMessage = undefined;
      break;
    case "go-to-task":
      placeholder = "Search tasks by #number or title...";
      emptyStateMessage = tasks.length === 0 ? "No tasks yet." : "No matching tasks.";
      break;
    case "go-to-project":
      placeholder = "Search projects...";
      emptyStateMessage = "No matching projects.";
      break;
    case "root":
      break;
  }

  const startAddon = isSubmenu ? (
    <button type="button" className="flex cursor-pointer items-center" aria-label="Back" onClick={popView}>
      <ArrowLeftIcon />
    </button>
  ) : undefined;
  const autoHighlight = view.kind !== "browse" && view.kind !== "title" && view.kind !== "no-folder";

  return (
    <PaletteContent
      key={`${stack.length}-${view.kind}-${generation}`}
      aria-label="Command palette"
      autoHighlight={autoHighlight ? "always" : false}
      footerActionLabel={footerActionLabel}
      footerTrailing={footerTrailing}
      inputAccessory={inputAccessory}
      inputProps={{
        placeholder,
        className: inputClassName,
        onKeyDown: handleKeyDown,
        ...(startAddon ? { startAddon } : {}),
      }}
      mode="none"
      items={itemValues}
      onItemHighlighted={(value) => setHighlighted(typeof value === "string" ? value : null)}
      onValueChange={handleQueryChange}
      showBackHint={isSubmenu}
      value={query}
    >
      {preamble}
      {view.kind === "import-t3" && !t3Detected ? (
        <PaletteEmptyState>{emptyStateMessage}</PaletteEmptyState>
      ) : (
        <PaletteResults groups={groups} emptyStateMessage={emptyStateMessage} />
      )}
    </PaletteContent>
  );
}
