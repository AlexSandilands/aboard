import { DEFAULT_REVIEW_MAX_ROUNDS, EMPTY_MODEL_TIERS, type AppSettings } from "@repo/contracts";

/** Settings as a fresh install returns them, for fakes of SettingsService. */
export const defaultSettings: AppSettings = {
  jiraBaseUrl: null,
  githubPolling: true,
  t3LinkTarget: "desktop",
  t3TokenSet: false,
  autoReview: false,
  reviewSkill: { source: "builtin" },
  reviewMaxRounds: DEFAULT_REVIEW_MAX_ROUNDS,
  headlessReviewEnabled: false,
  headlessReviewCli: null,
  headlessReviewBudgetUsd: 2,
  modelTiers: EMPTY_MODEL_TIERS,
};
