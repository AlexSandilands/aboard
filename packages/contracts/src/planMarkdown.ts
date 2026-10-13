import type { PlanInput, StepStatus } from "./schemas.ts";

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[( |x|X|~|-|!)\]\s+)?(.+)$/;

const CHECK_STATUS: Record<string, StepStatus> = {
  " ": "todo",
  x: "done",
  X: "done",
  "~": "in_progress",
  "-": "skipped",
  "!": "blocked",
};

/**
 * Parses a markdown plan into phases and steps.
 * - Headings become phases (the shallowest heading level used for phases; a single
 *   top-level title heading above other headings is treated as the plan title and skipped).
 * - Top-level list items become steps; `[x]`, `[~]`, `[-]`, `[!]` set status.
 * - Nested list items and paragraphs under an item become that step's notes.
 * - Text before the first phase/step becomes the plan context.
 * Returns null when no steps are found.
 */
export function parsePlanMarkdown(markdown: string): PlanInput | null {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");

  const headingLevels = lines
    .map((l) => HEADING.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]!.length);
  let phaseLevel = headingLevels.length ? Math.min(...headingLevels) : 0;
  // A lone top-level heading followed by deeper headings is a document title.
  if (phaseLevel && headingLevels.filter((l) => l === phaseLevel).length === 1 && headingLevels.some((l) => l > phaseLevel)) {
    phaseLevel = Math.min(...headingLevels.filter((l) => l > phaseLevel));
  }

  type DraftStep = { title: string; status: StepStatus; notes: string[] };
  type DraftPhase = { title: string; steps: DraftStep[] };
  const phases: DraftPhase[] = [];
  const context: string[] = [];
  let currentPhase: DraftPhase | null = null;
  let currentStep: DraftStep | null = null;
  let stepIndent = 0;
  let inFence = false;

  const ensurePhase = (): DraftPhase => {
    if (!currentPhase) {
      currentPhase = { title: "Plan", steps: [] };
      phases.push(currentPhase);
    }
    return currentPhase;
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    const heading = inFence ? null : HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (level === phaseLevel) {
        currentPhase = { title: heading[2]!.trim(), steps: [] };
        phases.push(currentPhase);
        currentStep = null;
        continue;
      }
      if (level < phaseLevel) {
        currentStep = null;
        continue; // document title
      }
    }

    const item = inFence ? null : LIST_ITEM.exec(line);
    if (item) {
      const indent = item[1]!.replace(/\t/g, "    ").length;
      if (!currentStep || indent <= stepIndent) {
        currentStep = {
          title: item[3]!.trim(),
          status: item[2] ? (CHECK_STATUS[item[2]] ?? "todo") : "todo",
          notes: [],
        };
        stepIndent = indent;
        ensurePhase().steps.push(currentStep);
        continue;
      }
    }

    if (currentStep) {
      currentStep.notes.push(line.slice(Math.min(stepIndent + 2, line.length - line.trimStart().length)));
    } else if (!currentPhase || currentPhase.steps.length === 0) {
      if (!currentPhase) context.push(line);
    }
  }

  const result = phases
    .filter((p) => p.steps.length > 0)
    .map((p) => ({
      title: p.title,
      steps: p.steps.map((s) => {
        const notes = s.notes.join("\n").trim();
        return { title: s.title, status: s.status, ...(notes ? { notes } : {}) };
      }),
    }));
  if (result.length === 0) return null;
  const ctx = context.join("\n").trim();
  return { ...(ctx ? { context: ctx } : {}), phases: result };
}
