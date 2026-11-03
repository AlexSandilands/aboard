import { normalizeWorkspaceKey, workspaceBasename, type Project } from "@repo/contracts";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { nowIso } from "../db/database.ts";
import { AppError, notFound } from "../errors.ts";
import type { Core } from "./core.ts";
import type { ProjectRef, ProjectsService } from "./types.ts";

/** True when `key` is `root` or lies inside it (segment-boundary aware). */
export function isWithinWorkspace(key: string, root: string): boolean {
  if (key === root) return true;
  return key.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * The enclosing git repository root of `path` (nearest ancestor containing `.git`), or `path`
 * itself when it isn't inside a repository or doesn't exist on this machine. Agents often work
 * in a subfolder; auto-created projects should be the whole repo.
 */
export function repositoryRootOf(path: string): string {
  let dir = resolve(path);
  if (!existsSync(dir)) return path;
  for (;;) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return path;
    dir = parent;
  }
}

/** Where a path inside a linked git worktree sits: the worktree's root, the main checkout's, and the same path there. */
export interface WorktreeLocation {
  worktree: string;
  main: string;
  path: string;
}

/**
 * When `path` lies inside a linked git worktree (`git worktree add`, T3 Code, Claude Code), where it is and the
 * same relative path in the repository's main checkout; otherwise null. Reads git's files rather than running
 * git, so it stays synchronous and needs no git on PATH. Submodules (no `commondir`), worktrees of bare
 * repositories and anything unreadable are not mapped.
 */
export function mainCheckoutOf(path: string): WorktreeLocation | null {
  try {
    const start = resolve(path);
    if (!existsSync(start)) return null;
    let root = start;
    for (;;) {
      const dotGit = resolve(root, ".git");
      if (existsSync(dotGit)) {
        // A directory is a main checkout (or a plain repo): nothing to map.
        if (!statSync(dotGit).isFile()) return null;
        const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
        if (!gitdir) return null;
        const adminDir = resolve(root, gitdir);
        const commondirFile = resolve(adminDir, "commondir");
        if (!existsSync(commondirFile)) return null;
        const commonDir = resolve(adminDir, readFileSync(commondirFile, "utf8").trim());
        if (basename(commonDir) !== ".git") return null;
        const main = dirname(commonDir);
        if (main === root || !existsSync(main)) return null;
        return { worktree: root, main, path: join(main, relative(root, start)) };
      }
      const parent = dirname(root);
      if (parent === root) return null;
      root = parent;
    }
  } catch {
    return null;
  }
}

/** The settings key holding the id of the General project (see `ProjectsService.general`). */
export const GENERAL_PROJECT_KEY = "generalProjectId";

/** A plain word, not the product name, so it reads right whatever the app is called. */
const GENERAL_TITLE = "General";

/** Projects: lanes on the board, optionally bound to a workspace folder. */
export function createProjectsService(
  core: Core,
  hooks: { onUnarchived?: (projectId: string) => void; onTasksDeleted?: (taskIds: readonly string[]) => void } = {},
): ProjectsService {
  const { repos } = core;

  const get = (id: string): Project => {
    const project = repos.projects.get(id);
    if (!project) throw notFound("Project", id);
    return project;
  };

  const assertKeyFree = (key: string | null, selfId?: string) => {
    if (!key) return;
    const existing = repos.projects.byKey(key);
    if (existing && existing.id !== selfId) {
      throw new AppError("CONFLICT", `A project already uses this workspace: ${existing.title}`, {
        projectId: existing.id,
      });
    }
  };

  const storedGeneralId = (): string | null => {
    const id = repos.settings.all().get(GENERAL_PROJECT_KEY);
    return typeof id === "string" ? id : null;
  };

  /**
   * Where a new lane goes: the end, except that the General lane stays last while it is still there, so projects
   * added later don't push it into the middle. A user who moved it keeps it wherever they put it.
   */
  const nextPosition = (): string => {
    const last = repos.projects.lastPosition();
    const generalId = storedGeneralId();
    const general = generalId ? repos.projects.get(generalId) : null;
    if (general && general.position === last) {
      return generateKeyBetween(repos.projects.positionBefore(general.position), general.position);
    }
    return generateKeyBetween(last, null);
  };

  const matchWorkspace = (path: string): Project | undefined => {
    const key = normalizeWorkspaceKey(path);
    return repos.projects
      .withWorkspace()
      .filter((p) => isWithinWorkspace(key, p.workspaceKey!))
      .sort((a, b) => b.workspaceKey!.length - a.workspaceKey!.length)[0];
  };

  /**
   * The project `ref` names, or null for an unknown path when `writing` (the caller creates it); a read throws
   * NOT_FOUND instead. Inside a linked worktree the same path in the main checkout is matched, unless a project is
   * bound to the worktree itself (or a folder in it). A plain match of the worktree path isn't enough: a worktree
   * inside the main repo (Claude Code's `.claude/worktrees/`) lies in the repo's root project, which would hide
   * a deeper project such as `<main>/apps/web`.
   */
  function find(ref: ProjectRef, writing: true): Project | null;
  function find(ref: ProjectRef, writing: false): Project;
  function find(ref: ProjectRef, writing: boolean): Project | null {
    if (ref.projectId) return get(ref.projectId);
    if (!ref.workspacePath?.trim()) {
      throw new AppError("VALIDATION", "Provide projectId or workspacePath to identify the project");
    }
    const path = ref.workspacePath.trim();
    const literal = matchWorkspace(path);
    const location = mainCheckoutOf(path);
    const boundToWorktree =
      literal && location && isWithinWorkspace(literal.workspaceKey!, normalizeWorkspaceKey(location.worktree));
    const match = location && !boundToWorktree ? (matchWorkspace(location.path) ?? literal) : literal;
    if (match) {
      // Writing tools bring an archived lane back rather than silently filing into a hidden one.
      if (writing && match.archivedAt) return service.update(match.id, { archived: false });
      return match;
    }
    if (!writing) throw notFound("Project for workspace", ref.workspacePath);
    return null;
  }

  const service: ProjectsService = {
    list: (opts) => repos.projects.list(opts?.includeArchived ?? false),
    get,

    general() {
      return core.write(() => {
        const id = storedGeneralId();
        const existing = id ? repos.projects.get(id) : null;
        if (existing) return existing.archivedAt ? service.update(existing.id, { archived: false }) : existing;
        // Never stored, or deleted since.
        const created = service.create({ title: GENERAL_TITLE });
        repos.settings.set(GENERAL_PROJECT_KEY, created.id);
        return created;
      });
    },

    findGeneral() {
      const id = storedGeneralId();
      return (id && repos.projects.get(id)) || null;
    },

    ensureGeneral() {
      // Stored once and never checked again: a General the user archived or deleted stays that way.
      if (!storedGeneralId()) service.general();
    },

    resolve(ref, opts) {
      return opts?.autoCreate ? service.resolveOrCreate(ref).project : find(ref, false);
    },

    resolveOrCreate(ref) {
      const found = find(ref, true);
      if (found) return { project: found, created: false };
      const path = ref.workspacePath!.trim();
      // Never a lane named after a worktree: the project is the main repo's, however the agent got here.
      // The main checkout's root, not the mapped path: a folder that exists only on the worktree's branch isn't there.
      const project = service.create({ workspaceRoot: mainCheckoutOf(path)?.main ?? repositoryRootOf(path) });
      return { project, created: true };
    },

    create(input) {
      return core.write((fx) => {
        const workspaceRoot = input.workspaceRoot ?? null;
        const title = input.title ?? (workspaceRoot ? workspaceBasename(workspaceRoot) : null);
        if (!title) throw new AppError("VALIDATION", "A project needs a title or a workspace folder");
        const workspaceKey = workspaceRoot ? normalizeWorkspaceKey(workspaceRoot) : null;
        // Re-adding an archived project's folder brings that project back instead of conflicting.
        const archived = workspaceKey ? repos.projects.byKey(workspaceKey) : null;
        if (archived?.archivedAt) return service.update(archived.id, { archived: false });
        assertKeyFree(workspaceKey);
        const now = nowIso();
        const project: Project = {
          id: randomUUID(),
          title,
          workspaceRoot,
          workspaceKey,
          icon: input.icon ?? null,
          t3ProjectId: input.t3ProjectId ?? null,
          reviewSkill: null,
          reviewModel: null,
          planSkill: null,
          variables: [],
          position: nextPosition(),
          collapsed: false,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        repos.projects.insert(project);
        fx.project(project.id);
        return project;
      });
    },

    update(id, input) {
      return core.write((fx) => {
        const current = get(id);
        const next: Project = { ...current, updatedAt: nowIso() };
        if (input.title !== undefined) next.title = input.title;
        if (input.workspaceRoot !== undefined) {
          next.workspaceRoot = input.workspaceRoot;
          next.workspaceKey = input.workspaceRoot ? normalizeWorkspaceKey(input.workspaceRoot) : null;
          assertKeyFree(next.workspaceKey, id);
        }
        if (input.icon !== undefined) next.icon = input.icon;
        if (input.reviewSkill !== undefined) next.reviewSkill = input.reviewSkill;
        if (input.reviewModel !== undefined) next.reviewModel = input.reviewModel;
        if (input.planSkill !== undefined) next.planSkill = input.planSkill;
        // Which projects a custom automation still needs a variable in shows on its row.
        if (input.variables !== undefined) {
          next.variables = input.variables;
          fx.autopilot();
        }
        if (input.collapsed !== undefined) next.collapsed = input.collapsed;
        if (input.archived !== undefined)
          next.archivedAt = input.archived ? (current.archivedAt ?? next.updatedAt) : null;
        repos.projects.update(next);
        fx.project(id);
        // Clients drop an archived lane's tasks; unarchiving must send them back.
        if (current.archivedAt && !next.archivedAt) {
          for (const task of repos.tasks.list({ projectId: id })) fx.task(task.id);
          hooks.onUnarchived?.(id);
        }
        return next;
      });
    },

    reorder(ids) {
      core.write((fx) => {
        const all = repos.projects.list(true);
        const byId = new Map(all.map((p) => [p.id, p]));
        for (const id of ids) if (!byId.has(id)) throw notFound("Project", id);
        const listed = new Set(ids);
        const order = [...ids, ...all.filter((p) => !listed.has(p.id)).map((p) => p.id)];
        const keys = generateNKeysBetween(null, null, order.length);
        const now = nowIso();
        order.forEach((id, i) => {
          const project = byId.get(id)!;
          if (project.position === keys[i]) return;
          repos.projects.update({ ...project, position: keys[i]!, updatedAt: now });
          fx.project(id);
        });
      });
    },

    delete(id) {
      const deleted = core.write((fx) => {
        get(id);
        const taskIds = repos.tasks.idsForProject(id);
        for (const taskId of taskIds) fx.taskDeleted(taskId);
        // Tasks elsewhere that blocked, or were blocked by, these lose the relation (ON DELETE CASCADE).
        for (const other of repos.relations.neighbours(taskIds)) if (!taskIds.includes(other)) fx.task(other);
        // Tasks elsewhere that were closed against these lose the link (ON DELETE SET NULL); refresh their cards.
        for (const resolved of repos.tasks.resolvedBy(taskIds)) {
          if (resolved.projectId !== id) fx.task(resolved.id);
        }
        // ...and resolvers elsewhere drop these from their "Also resolved" list.
        for (const task of repos.tasks.getMany(taskIds)) {
          if (task.resolvedByTaskId && !taskIds.includes(task.resolvedByTaskId)) fx.detail(task.resolvedByTaskId);
        }
        repos.projects.delete(id);
        fx.projectDeleted(id);
        return taskIds;
      });
      // After the commit: a delete that rolled back keeps its images.
      hooks.onTasksDeleted?.(deleted);
    },
  };
  return service;
}
