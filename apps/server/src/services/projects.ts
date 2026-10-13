import { normalizeWorkspaceKey, workspaceBasename, type Project } from "@taskboard/contracts";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { randomUUID } from "node:crypto";
import { nowIso } from "../db/database.ts";
import { AppError, notFound } from "../errors.ts";
import type { Core } from "./core.ts";
import type { ProjectsService } from "./types.ts";

/** True when `key` is `root` or lies inside it (segment-boundary aware). */
export function isWithinWorkspace(key: string, root: string): boolean {
  if (key === root) return true;
  return key.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Projects: lanes on the board, optionally bound to a workspace folder. */
export function createProjectsService(core: Core): ProjectsService {
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

  const service: ProjectsService = {
    list: (opts) => repos.projects.list(opts?.includeArchived ?? false),
    get,

    resolve(ref, opts) {
      if (ref.projectId) return get(ref.projectId);
      if (!ref.workspacePath?.trim()) {
        throw new AppError("VALIDATION", "Provide projectId or workspacePath to identify the project");
      }
      const key = normalizeWorkspaceKey(ref.workspacePath);
      const match = repos.projects
        .withWorkspace()
        .filter((p) => isWithinWorkspace(key, p.workspaceKey!))
        .sort((a, b) => b.workspaceKey!.length - a.workspaceKey!.length)[0];
      if (match) return match;
      if (!opts?.autoCreate) throw notFound("Project for workspace", ref.workspacePath);
      return service.create({ workspaceRoot: ref.workspacePath.trim() });
    },

    create(input) {
      return core.write((fx) => {
        const workspaceRoot = input.workspaceRoot ?? null;
        const title = input.title ?? (workspaceRoot ? workspaceBasename(workspaceRoot) : null);
        if (!title) throw new AppError("VALIDATION", "A project needs a title or a workspace folder");
        const workspaceKey = workspaceRoot ? normalizeWorkspaceKey(workspaceRoot) : null;
        assertKeyFree(workspaceKey);
        const now = nowIso();
        const project: Project = {
          id: randomUUID(),
          title,
          workspaceRoot,
          workspaceKey,
          icon: input.icon ?? null,
          t3ProjectId: input.t3ProjectId ?? null,
          position: generateKeyBetween(repos.projects.lastPosition(), null),
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
        if (input.collapsed !== undefined) next.collapsed = input.collapsed;
        if (input.archived !== undefined) next.archivedAt = input.archived ? (current.archivedAt ?? next.updatedAt) : null;
        repos.projects.update(next);
        fx.project(id);
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
      core.write((fx) => {
        get(id);
        for (const taskId of repos.tasks.idsForProject(id)) fx.taskDeleted(taskId);
        repos.projects.delete(id);
        fx.projectDeleted(id);
      });
    },
  };
  return service;
}
