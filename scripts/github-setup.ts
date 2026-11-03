/**
 * Applies the GitHub settings kept in this repo: the rulesets in `.github/rulesets/` and the repo options below.
 * Safe to re-run: a ruleset is matched by name and only sent when it differs. Needs `gh`, signed in as an admin.
 *
 *   node scripts/github-setup.ts            apply
 *   node scripts/github-setup.ts --dry-run  print what would change
 *   node scripts/github-setup.ts --check    offline: every required check is a job a pull request runs
 *
 * `--check` runs in `pnpm check`. A required check that no workflow produces (a job renamed, a matrix value
 * changed) leaves every PR waiting for it forever. How it fits together: docs/features/github-setup.md.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const rulesetsDir = join(root, ".github/rulesets");
const workflowsDir = join(root, ".github/workflows");

/** Squash only, titled by the PR (which CI lints), so `main` gets one Conventional commit per PR. */
const REPO_OPTIONS = {
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  squash_merge_commit_title: "PR_TITLE",
  squash_merge_commit_message: "COMMIT_MESSAGES",
  allow_auto_merge: true,
  allow_update_branch: true,
  delete_branch_on_merge: true,
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Rule {
  type: string;
  parameters?: Record<string, Json>;
}

interface Ruleset {
  name: string;
  target: "branch" | "tag" | "push";
  enforcement: string;
  conditions?: Record<string, Json>;
  bypass_actors?: Json[];
  rules: Rule[];
}

function readRulesets(): { file: string; ruleset: Ruleset }[] {
  return readdirSync(rulesetsDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({ file, ruleset: JSON.parse(readFileSync(join(rulesetsDir, file), "utf8")) as Ruleset }));
}

// --- --check -------------------------------------------------------------------------------------------------

type Combo = Record<string, Json>;

/** A job's matrix combinations, expanded the way GitHub does: the product, minus `exclude`, plus `include`. */
function matrixCombos(matrix: Record<string, Json>): Combo[] | null {
  const { include, exclude, ...axes } = matrix;
  if (Object.values(axes).some((values) => !Array.isArray(values))) return null; // `${{ fromJSON(...) }}`
  let combos: Combo[] = [{}];
  for (const [key, values] of Object.entries(axes) as [string, Json[]][]) {
    combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [key]: value })));
  }
  const same = (a: Json | undefined, b: Json | undefined) => JSON.stringify(a) === JSON.stringify(b);
  const matches = (combo: Combo, partial: Combo) => Object.entries(partial).every(([k, v]) => same(combo[k], v));
  if (Array.isArray(exclude)) combos = combos.filter((combo) => !exclude.some((ex) => matches(combo, ex as Combo)));
  if (Object.keys(axes).length === 0) combos = [];
  for (const entry of Array.isArray(include) ? (include as Combo[]) : []) {
    // An include entry joins every combination whose original values it doesn't overwrite, else it's a new one.
    const original = Object.fromEntries(Object.entries(entry).filter(([key]) => key in axes));
    const targets = combos.filter((combo) => matches(combo, original));
    if (targets.length > 0) for (const combo of targets) Object.assign(combo, entry);
    else combos.push({ ...entry });
  }
  return combos;
}

const label = (value: Json | undefined) => (typeof value === "object" ? JSON.stringify(value) : String(value));

/** The check names one workflow's jobs report on a pull request, or null when it doesn't run on every PR. */
function workflowCheckNames(workflow: Record<string, Json>): string[] | null {
  const on = workflow.on;
  const events = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
  if (!events.includes("pull_request")) return null;
  const trigger = !on || typeof on !== "object" || Array.isArray(on) ? null : on.pull_request;
  // Path or branch filters would leave some PRs without the check.
  if (trigger && typeof trigger === "object" && !Array.isArray(trigger)) {
    const filters = ["paths", "paths-ignore", "branches", "branches-ignore"];
    if (filters.some((key) => key in trigger)) return null;
  }

  const jobs = (workflow.jobs ?? {}) as Record<string, Record<string, Json>>;
  return Object.entries(jobs).flatMap(([id, job]) => {
    const name = typeof job.name === "string" ? job.name : id;
    const strategy = job.strategy as { matrix?: Record<string, Json> } | undefined;
    const combos = strategy?.matrix ? matrixCombos(strategy.matrix) : [];
    if (combos === null) return [`${name} (dynamic matrix)`];
    if (combos.length === 0) return [name];
    return combos.map((combo) => {
      if (/\$\{\{\s*matrix\./.test(name)) {
        return name.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (_, key: string) => label(combo[key]));
      }
      return `${name} (${Object.values(combo).map(label).join(", ")})`;
    });
  });
}

function check(): void {
  const produced = new Set(
    readdirSync(workflowsDir)
      .filter((file) => /\.ya?ml$/.test(file))
      .flatMap((file) => workflowCheckNames(parse(readFileSync(join(workflowsDir, file), "utf8"))) ?? []),
  );
  const missing: string[] = [];
  let required = 0;
  for (const { file, ruleset } of readRulesets()) {
    for (const rule of ruleset.rules) {
      if (rule.type !== "required_status_checks") continue;
      const checks = (rule.parameters?.required_status_checks ?? []) as { context: string }[];
      for (const { context } of checks) {
        required++;
        if (!produced.has(context)) missing.push(`${file}: "${context}"`);
      }
    }
  }
  if (missing.length > 0) {
    console.error(
      `Required checks that no pull_request workflow job reports (${missing.length}):\n` +
        missing.map((line) => `  ${line}`).join("\n") +
        `\nJobs that do: ${[...produced].map((name) => `"${name}"`).join(", ")}`,
    );
    process.exit(1);
  }
  console.log(`Required checks OK (${required} checked).`);
}

// --- apply ---------------------------------------------------------------------------------------------------

function gh(args: string[], body?: unknown, quiet = false): string {
  return execFileSync("gh", ["api", ...args, ...(body === undefined ? [] : ["--input", "-"])], {
    cwd: root,
    encoding: "utf8",
    input: body === undefined ? undefined : JSON.stringify(body),
    stdio: ["pipe", "pipe", quiet ? "pipe" : "inherit"],
  });
}

/** `owner/name` from origin's URL, SSH or HTTPS. */
function repoFromRemote(): string {
  const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).trim();
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error(`origin (${url}) isn't a GitHub repo.`);
  return match[1]!;
}

/** Whether `remote` has everything `local` sets. GitHub fills in defaults, so extra keys don't count. */
function covers(remote: unknown, local: unknown): boolean {
  if (Array.isArray(local)) {
    return Array.isArray(remote) && remote.length === local.length && local.every((v, i) => covers(remote[i], v));
  }
  if (local && typeof local === "object") {
    if (!remote || typeof remote !== "object" || Array.isArray(remote)) return false;
    return Object.entries(local).every(([key, value]) => covers((remote as Record<string, unknown>)[key], value));
  }
  return remote === local;
}

/** Rules in a fixed order, since GitHub doesn't keep the order they were sent in. */
const sorted = (ruleset: Ruleset) => ({
  ...ruleset,
  rules: [...ruleset.rules].sort((a, b) => a.type.localeCompare(b.type)),
});

function apply(dryRun: boolean): void {
  const repo = repoFromRemote();
  const say = (line: string) => console.log(dryRun ? `would ${line}` : line);
  let changes = 0;

  const current = JSON.parse(gh([`repos/${repo}`])) as Record<string, Json>;
  const options = Object.entries(REPO_OPTIONS).filter(([key, value]) => current[key] !== value);
  for (const [key, value] of options) say(`set ${key}: ${label(current[key])} -> ${label(value)}`);
  if (options.length > 0 && !dryRun) gh([`repos/${repo}`, "--method", "PATCH"], Object.fromEntries(options));
  changes += options.length;

  // Dependabot alerts answer 204 when on and 404 when off; security fixes need them on first.
  let alerts = true;
  try {
    gh([`repos/${repo}/vulnerability-alerts`, "--silent"], undefined, true);
  } catch {
    alerts = false;
  }
  if (!alerts) {
    say("turn on Dependabot alerts");
    if (!dryRun) gh([`repos/${repo}/vulnerability-alerts`, "--method", "PUT", "--silent"]);
    changes++;
  }
  const fixes = alerts && (JSON.parse(gh([`repos/${repo}/automated-security-fixes`])) as { enabled: boolean }).enabled;
  if (!fixes) {
    say("turn on Dependabot security updates");
    if (!dryRun) gh([`repos/${repo}/automated-security-fixes`, "--method", "PUT", "--silent"]);
    changes++;
  }

  const existing = JSON.parse(gh([`repos/${repo}/rulesets`, "--paginate"])) as { id: number; name: string }[];
  const managed = new Set<string>();
  for (const { file, ruleset } of readRulesets()) {
    managed.add(ruleset.name);
    const found = existing.find((r) => r.name === ruleset.name);
    if (!found) {
      say(`create ruleset "${ruleset.name}" (${file})`);
      if (!dryRun) gh([`repos/${repo}/rulesets`, "--method", "POST", "--silent"], ruleset);
      changes++;
      continue;
    }
    const remote = JSON.parse(gh([`repos/${repo}/rulesets/${found.id}`])) as Ruleset;
    if (covers(sorted(remote), sorted(ruleset))) continue;
    say(`update ruleset "${ruleset.name}" (${file})`);
    if (!dryRun) gh([`repos/${repo}/rulesets/${found.id}`, "--method", "PUT", "--silent"], ruleset);
    changes++;
  }
  for (const { name } of existing.filter((r) => !managed.has(r.name))) {
    console.log(`note: ruleset "${name}" isn't in .github/rulesets/, left alone`);
  }

  console.log(
    changes === 0 ? `${repo} is up to date.` : `${changes} change(s) ${dryRun ? "to make" : "made"} on ${repo}.`,
  );
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  if (args.has("--check")) check();
  else apply(args.has("--dry-run"));
}
