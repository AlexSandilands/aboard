import {
  BOARD_HISTORY,
  CustomAutomation,
  isRetried,
  MachineAutopilotConfig,
  RETRIED_PREFIX,
  type AutopilotRun,
  type AutopilotSetting,
  type CopiedProject,
  type MachineAutopilotAck,
} from "@repo/contracts";
import { AUTOPILOT_ENGINE_KEY, AUTOPILOT_PAUSED_KEY } from "./autopilotKeys.ts";
import type { Core } from "./core.ts";
import { swapId } from "./workingCopies.ts";

// A runner's side of Autopilot on the machine (docs/features/remote-machines.md#autopilot-on-the-machine): the board
// sends what its Autopilot is, and the runner takes it as its own, so the same engine runs here over the tasks it
// holds, by the board's switches and automations, with this machine's limits. Kept as sent, so a project adopted
// later (a hand-over) gets its switches then.

/** Where the config last sent is kept, in `runner_state`. */
const STATE_KEY = "autopilot";
/** Why an automation is paused here, when the board paused it. */
const PAUSED_ON_BOARD = "Paused on the board after failing in a row";

export interface RunnerAutopilotService {
  /**
   * Takes the board's Autopilot as this runner's own: switches and config under this runner's ids for the board's
   * projects, the engine settings, the custom automations, Pause all and where automations paused themselves.
   * Answers with the revision taken, and the projects a pinned automation needs that this runner hasn't cloned.
   */
  apply(config: MachineAutopilotConfig): MachineAutopilotAck & { missing: CopiedProject[] };
  /** Applies the config last sent again: a project adopted since gets its switches. Nothing when none was sent. */
  reapply(): void;
  /** The revision last taken; null when the board never sent one. */
  revision(): string | null;
}

export function createRunnerAutopilotService(
  core: Core,
  deps: {
    /** Logs one of this runner's own runs for the board, as the autopilot service does when it writes one. */
    logRun?: (run: AutopilotRun) => void;
  } = {},
): RunnerAutopilotService {
  const { repos } = core;

  /** This runner's project for one of the board's ids; null when it has none. */
  const projectFor = (boardId: string): string | null =>
    repos.workingCopies.projectFor(boardId, null)?.projectId ?? null;

  const write = (config: MachineAutopilotConfig): CopiedProject[] => {
    core.write((fx) => {
      // Switches: the board's, by this runner's project ids. A project this runner doesn't have has no tasks here.
      const wanted: AutopilotSetting[] = config.settings.flatMap((setting) => {
        if (setting.scopeKind !== "project") return [setting];
        const projectId = setting.scopeId ? projectFor(setting.scopeId) : null;
        return projectId ? [{ ...setting, scopeId: projectId }] : [];
      });
      const key = (s: Pick<AutopilotSetting, "scopeKind" | "scopeId" | "automation">) =>
        `${s.scopeKind}:${s.scopeId ?? ""}:${s.automation}`;
      const keep = new Set(wanted.map(key));
      for (const own of repos.autopilotSettings.all()) {
        if (!keep.has(key(own))) repos.autopilotSettings.delete(own.scopeKind, own.scopeId, own.automation);
      }
      for (const setting of wanted) repos.autopilotSettings.upsert(setting);

      repos.settings.set(AUTOPILOT_ENGINE_KEY, config.engine);
      repos.settings.set(AUTOPILOT_PAUSED_KEY, config.paused);

      // Custom automations under the board's ids. One a newer board shaped differently is left out until updated.
      const custom = config.custom.flatMap((sent) => {
        const parsed = CustomAutomation.safeParse(sent);
        if (!parsed.success) return [];
        const armedProjects = Object.fromEntries(
          Object.entries(parsed.data.armedProjects).flatMap(([scope, at]) => {
            // An epic's key is its id, the same on both sides; a project's is the board's id.
            if (scope.startsWith("epic:")) return [[scope, at]];
            const projectId = projectFor(scope);
            return projectId ? [[projectId, at]] : [];
          }),
        );
        return [
          {
            ...parsed.data,
            armedProjects,
            machineId: parsed.data.machineId ?? null,
          },
        ];
      });
      const sentIds = new Set(custom.map((c) => c.id));
      // Gone first, so a name freed by one and taken by another doesn't clash.
      for (const own of repos.autopilotCustom.all()) if (!sentIds.has(own.id)) repos.autopilotCustom.delete(own.id);
      for (const automation of custom) {
        if (repos.autopilotCustom.get(automation.id)) repos.autopilotCustom.update(automation);
        else {
          const clash = repos.autopilotCustom.byName(automation.name);
          if (clash) repos.autopilotCustom.delete(clash.id);
          repos.autopilotCustom.insert(automation);
        }
      }

      // Paused where the board says, and only there.
      const paused = new Set(
        config.autoPaused.flatMap((p) => {
          const projectId = projectFor(p.projectId);
          return projectId ? [`${p.automation}\n${projectId}`] : [];
        }),
      );
      const at = core.now().toISOString();
      for (const own of repos.autopilotAutoPauses.paused()) {
        if (!paused.has(`${own.automation}\n${own.projectId}`)) {
          repos.autopilotAutoPauses.resume(own.automation, own.projectId, at);
        }
      }
      for (const entry of paused) {
        const [automation, projectId] = entry.split("\n") as [string, string];
        if (!repos.autopilotAutoPauses.get(automation, projectId)?.pausedAt) {
          repos.autopilotAutoPauses.pause(automation, projectId, at, PAUSED_ON_BOARD);
        }
      }

      // The values custom automations read, the board's and each project's, under this runner's ids.
      repos.settings.set("automationVariables", config.variables.board);
      for (const mapping of repos.workingCopies.allProjects()) {
        const project = repos.projects.get(mapping.projectId);
        if (!project || mapping.boardId === null) continue;
        const variables = config.variables.projects[mapping.boardId] ?? [];
        if (JSON.stringify(variables) !== JSON.stringify(project.variables)) {
          repos.projects.update({ ...project, variables });
        }
      }

      // What a pinned automation did on the board: history this engine counts, with its keys in this runner's ids.
      for (const run of config.history) {
        const projectId = run.projectId ? projectFor(run.projectId) : null;
        if (!projectId || !run.projectId || repos.autopilotRuns.get(run.id)) continue;
        const dedupeKey = swapId(run.dedupeKey, run.projectId, projectId);
        if (repos.autopilotRuns.exists(run.automation, dedupeKey, run.dryRun)) continue;
        repos.autopilotRuns.insert({ ...run, taskId: null, projectId, dedupeKey, machine: BOARD_HISTORY });
      }
      // Its own task-less runs the board retried: retired here too, so the engine acts on the work again.
      for (const id of config.retried) {
        const run = repos.autopilotRuns.get(id);
        if (!run || isRetried(run.dedupeKey) || run.machine) continue;
        const retired: AutopilotRun = {
          ...run,
          dedupeKey: `${RETRIED_PREFIX}${run.id}:${run.dedupeKey}`,
          needsAttention: false,
          updatedAt: core.now().toISOString(),
        };
        repos.autopilotRuns.update(retired);
        deps.logRun?.(retired);
      }

      repos.workingCopies.setState(STATE_KEY, JSON.stringify(config));
      fx.autopilot();
    });
    return config.projects.filter((p) => !projectFor(p.id));
  };

  const stored = (): MachineAutopilotConfig | null => {
    const raw = repos.workingCopies.state(STATE_KEY);
    if (!raw) return null;
    try {
      return MachineAutopilotConfig.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  };

  return {
    apply(config) {
      const missing = write(config);
      return { revision: config.revision, missing };
    },
    reapply() {
      const config = stored();
      if (config) write(config);
    },
    revision: () => stored()?.revision ?? null,
  };
}
