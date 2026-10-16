import { DEFAULT_REVIEW_MAX_ROUNDS, EMPTY_MODEL_TIERS, type AppSettings, type ModelTiers } from "@repo/contracts";
import type { Repos } from "../db/repos/index.ts";
import { AUTOPILOT_ENGINE_KEY } from "./autopilot.ts";
import type { Core } from "./core.ts";
import type { SettingsService } from "./types.ts";

type StoredSettings = Omit<AppSettings, "t3TokenSet"> & { t3Token: string | null };

const DEFAULTS: StoredSettings = {
  jiraBaseUrl: null,
  githubPolling: true,
  t3LinkTarget: "desktop",
  t3Token: null,
  agentT3Threads: false,
  autoReview: false,
  reviewSkill: { source: "builtin" },
  reviewMaxRounds: DEFAULT_REVIEW_MAX_ROUNDS,
  headlessReviewEnabled: false,
  headlessReviewCli: null,
  headlessReviewBudgetUsd: 2,
  issueImportEnabled: true,
  issueImportModel: "haiku",
  issueImportBudgetUsd: 0.5,
  issueImportJiraTools: [],
  modelTiers: EMPTY_MODEL_TIERS,
  terminal: { kind: "auto" },
  backupEnabled: false,
  backupDir: null,
  backupRemote: null,
  backupIntervalMinutes: 60,
};

/**
 * Settings written to a backup, as an allow-list so a new key (a secret, a machine-specific path) stays out until
 * someone decides otherwise. Left out: the T3 token, and the terminal and backup settings, which describe this
 * machine; a forced restore keeps them from the database it replaces. Autopilot's engine settings are stored beside
 * these (services/autopilot.ts) and exported too; its pause is not, so a restore can't lift Pause all.
 */
export const EXPORTED_SETTINGS: ReadonlySet<string> = new Set<string>([
  AUTOPILOT_ENGINE_KEY,
  ...([
    "jiraBaseUrl",
    "githubPolling",
    "t3LinkTarget",
    "agentT3Threads",
    "autoReview",
    "reviewSkill",
    "reviewMaxRounds",
    "headlessReviewEnabled",
    "headlessReviewCli",
    "headlessReviewBudgetUsd",
    "issueImportEnabled",
    "issueImportModel",
    "issueImportBudgetUsd",
    "issueImportJiraTools",
    "modelTiers",
  ] satisfies Array<keyof StoredSettings>),
]);

/** The given tiers over the current ones. Blank descriptions are stored as none, so the T3 label fallback applies. */
const mergeModelTiers = (current: ModelTiers, input: Partial<ModelTiers>): ModelTiers => ({
  ...current,
  ...Object.fromEntries(
    Object.entries(input).map(([tier, setting]) => [
      tier,
      { ...setting, description: setting.description?.trim() || null },
    ]),
  ),
});

/** Stored settings over their defaults. Also read by summaries, which derive review state from max rounds. */
export function loadSettings(repos: Repos): StoredSettings {
  const stored = repos.settings.all();
  const pick = <K extends keyof StoredSettings>(key: K): StoredSettings[K] =>
    stored.has(key) ? (stored.get(key) as StoredSettings[K]) : DEFAULTS[key];
  return Object.fromEntries(
    (Object.keys(DEFAULTS) as Array<keyof StoredSettings>).map((key) => [key, pick(key)]),
  ) as unknown as StoredSettings;
}

/** App settings stored as key/value JSON. The T3 token never leaves the server. */
export function createSettingsService(core: Core): SettingsService {
  const { repos } = core;
  const load = () => loadSettings(repos);

  const get = (): AppSettings => {
    const { t3Token, ...rest } = load();
    return { ...rest, t3TokenSet: Boolean(t3Token) };
  };

  return {
    get,
    update(input) {
      core.write((fx) => {
        const blankToNull = (v: string | null) => (v ? v : null);
        if (input.jiraBaseUrl !== undefined) {
          repos.settings.set("jiraBaseUrl", blankToNull(input.jiraBaseUrl?.replace(/\/+$/, "") ?? null));
        }
        if (input.githubPolling !== undefined) repos.settings.set("githubPolling", input.githubPolling);
        if (input.t3LinkTarget !== undefined) repos.settings.set("t3LinkTarget", input.t3LinkTarget);
        if (input.agentT3Threads !== undefined) repos.settings.set("agentT3Threads", input.agentT3Threads);
        if (input.t3Token !== undefined) repos.settings.set("t3Token", blankToNull(input.t3Token));
        if (input.autoReview !== undefined) repos.settings.set("autoReview", input.autoReview);
        if (input.reviewSkill !== undefined) repos.settings.set("reviewSkill", input.reviewSkill);
        if (input.reviewMaxRounds !== undefined && input.reviewMaxRounds !== load().reviewMaxRounds) {
          repos.settings.set("reviewMaxRounds", input.reviewMaxRounds);
          // Whether a review is stuck depends on the limit, so reviewed cards change with it.
          for (const taskId of repos.reviews.taskIds()) fx.task(taskId);
        }
        if (input.headlessReviewEnabled !== undefined) {
          repos.settings.set("headlessReviewEnabled", input.headlessReviewEnabled);
        }
        if (input.headlessReviewCli !== undefined) {
          repos.settings.set("headlessReviewCli", blankToNull(input.headlessReviewCli));
        }
        if (input.headlessReviewBudgetUsd !== undefined) {
          repos.settings.set("headlessReviewBudgetUsd", input.headlessReviewBudgetUsd);
        }
        if (input.issueImportEnabled !== undefined) repos.settings.set("issueImportEnabled", input.issueImportEnabled);
        if (input.issueImportModel !== undefined) repos.settings.set("issueImportModel", input.issueImportModel);
        if (input.issueImportBudgetUsd !== undefined) {
          repos.settings.set("issueImportBudgetUsd", input.issueImportBudgetUsd);
        }
        if (input.issueImportJiraTools !== undefined) {
          repos.settings.set("issueImportJiraTools", [...new Set(input.issueImportJiraTools)]);
        }
        if (input.backupEnabled !== undefined) repos.settings.set("backupEnabled", input.backupEnabled);
        if (input.backupDir !== undefined) repos.settings.set("backupDir", blankToNull(input.backupDir));
        if (input.backupRemote !== undefined) repos.settings.set("backupRemote", blankToNull(input.backupRemote));
        if (input.backupIntervalMinutes !== undefined) {
          repos.settings.set("backupIntervalMinutes", input.backupIntervalMinutes);
        }
        if (input.terminal !== undefined) repos.settings.set("terminal", input.terminal);
        if (input.modelTiers !== undefined)
          repos.settings.set("modelTiers", mergeModelTiers(load().modelTiers, input.modelTiers));
      });
      return get();
    },
    t3Token: () => load().t3Token,
  };
}
