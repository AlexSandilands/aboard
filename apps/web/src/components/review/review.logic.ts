import {
  BUILTIN_REVIEW_SKILL_NAME,
  isGatingSeverity,
  type FindingSeverity,
  type ReviewFinding,
  type ReviewSkillRef,
  type SkillInfo,
  type TaskReview,
  type TaskReviewSummary,
} from "@repo/contracts";

type BadgeVariant = "info" | "warning" | "error" | "success" | "outline";

/** Mid-loop states read as information; ones that need the user read as warnings or errors. */
export function reviewBadgeVariant(summary: TaskReviewSummary): BadgeVariant {
  switch (summary.state) {
    case "pending":
    case "running":
    case "fixed":
      return "info";
    case "changes_requested":
    case "stalled":
    case "stuck":
      return "warning";
    case "failed":
      return "error";
    case "clean":
      return "success";
  }
}

export const SEVERITY_VARIANT: Record<FindingSeverity, BadgeVariant> = {
  blocking: "error",
  major: "warning",
  minor: "outline",
  nit: "outline",
};

/** "src/a.ts:12", "src/a.ts", or null. */
export function findingLocation(finding: Pick<ReviewFinding, "file" | "line">): string | null {
  if (!finding.file) return null;
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}

/**
 * Findings worth showing for a round: the latest round shows everything, earlier rounds only what is still
 * open (the rest is history the activity log already has).
 */
export function visibleFindings(review: TaskReview, isLatest: boolean): ReviewFinding[] {
  return isLatest ? review.findings : review.findings.filter((f) => f.status === "open");
}

/** Open gating findings first, then by severity, then the round order. */
export function sortFindings(findings: ReadonlyArray<ReviewFinding>): ReviewFinding[] {
  const rank = (f: ReviewFinding) =>
    (f.status === "open" ? 0 : 10) + ["blocking", "major", "minor", "nit"].indexOf(f.severity);
  return [...findings].sort((a, b) => rank(a) - rank(b));
}

export const hasOpenGating = (findings: ReadonlyArray<ReviewFinding>): boolean =>
  findings.some((f) => f.status === "open" && isGatingSeverity(f.severity));

// ── Auto-review override ────────────────────────────────────────────────

export type AutoReviewChoice = "inherit" | "on" | "off";

export const autoReviewChoice = (value: boolean | null): AutoReviewChoice =>
  value === null ? "inherit" : value ? "on" : "off";

export const autoReviewValue = (choice: AutoReviewChoice): boolean | null =>
  choice === "inherit" ? null : choice === "on";

export function autoReviewOptions(globalOn: boolean): Array<{ value: AutoReviewChoice; label: string }> {
  return [
    { value: "inherit", label: `Default (${globalOn ? "on" : "off"})` },
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];
}

// ── Skill picker ─────────────────────────────────────────────────────────

/** Select values: "builtin", or "skill:<path>". Paths are unique, names may not be. */
export function skillKey(skill: ReviewSkillRef | null): string {
  if (!skill) return "inherit";
  return skill.source === "builtin" ? "builtin" : `skill:${skill.path}`;
}

export interface SkillOption {
  value: string;
  label: string;
  /** Where it comes from, shown muted next to the name. */
  detail: string;
  skill: ReviewSkillRef | null;
}

/**
 * Options for a skill select: optionally "inherit" (project override), the built-in skill, then the discovered
 * skills. A configured skill that is no longer on disk stays listed so the select can show it.
 */
export function skillOptions(
  discovered: ReadonlyArray<SkillInfo>,
  current: ReviewSkillRef | null,
  opts: { inheritLabel?: string } = {},
): SkillOption[] {
  const options: SkillOption[] = [];
  if (opts.inheritLabel !== undefined) {
    options.push({ value: "inherit", label: opts.inheritLabel, detail: "", skill: null });
  }
  options.push({
    value: "builtin",
    label: BUILTIN_REVIEW_SKILL_NAME,
    detail: "Built in",
    skill: { source: "builtin" },
  });
  for (const s of discovered) {
    options.push({
      value: `skill:${s.path}`,
      label: s.name,
      detail: s.root,
      skill: { source: s.source, name: s.name, path: s.path },
    });
  }
  if (current && current.source !== "builtin" && !options.some((o) => o.value === skillKey(current))) {
    options.push({ value: skillKey(current), label: current.name, detail: "Not found", skill: current });
  }
  return options;
}
