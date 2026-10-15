import { LabelHue, normalizeLabel, normalizeLabels, type LabelUsage } from "@repo/contracts";
import { AppError } from "../errors.ts";
import type { Core, Effects } from "./core.ts";
import type { LabelsService } from "./types.ts";

/** Normalised, deduped labels; anything normalizeLabels rejects becomes a VALIDATION error. */
export function toLabels(raw: readonly string[]): string[] {
  try {
    return normalizeLabels(raw);
  } catch (error) {
    throw new AppError("VALIDATION", error instanceof Error ? error.message : "Invalid labels");
  }
}

function toLabel(raw: string): string {
  const [label] = toLabels([raw]);
  return label!;
}

export interface LabelsModule {
  service: LabelsService;
  /** Replaces a task's labels inside an existing write, logging labels_changed when the set differs. */
  setIn(taskId: string, raw: readonly string[], actor: string, fx: Effects): void;
}

/** Task labels and their board-wide colour overrides. */
export function createLabelsService(core: Core): LabelsModule {
  const { repos } = core;

  const service: LabelsService = {
    usage(): LabelUsage[] {
      const colors = repos.labels.colors();
      return repos.labels.usage().map((u) => ({ ...u, hue: colors[u.name] ?? null }));
    },

    colors: () => repos.labels.colors(),

    setColor(raw, hue) {
      const label = toLabel(raw);
      const parsed = LabelHue.safeParse(hue);
      if (!parsed.success) throw new AppError("VALIDATION", "Hue must be a whole number from 0 to 359");
      core.write((fx) => {
        repos.labels.setColor(label, parsed.data);
        fx.labelColors();
      });
      return repos.labels.colors();
    },

    clearColor(raw) {
      const label = normalizeLabel(raw);
      core.write((fx) => {
        if (repos.labels.clearColor(label)) fx.labelColors();
      });
      return repos.labels.colors();
    },
  };

  return {
    service,
    setIn(taskId, raw, actor, fx) {
      const next = toLabels(raw);
      const current = repos.labels.forTasks([taskId]).get(taskId) ?? [];
      const added = next.filter((l) => !current.includes(l));
      const removed = current.filter((l) => !next.includes(l));
      if (added.length === 0 && removed.length === 0) return;
      repos.labels.replace(taskId, next);
      fx.log(taskId, actor, "labels_changed", { added, removed });
    },
  };
}
