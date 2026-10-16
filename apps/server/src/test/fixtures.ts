import {
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_REVIEW_MAX_ROUNDS,
  EMPTY_MODEL_TIERS,
  type AppSettings,
} from "@repo/contracts";

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
  agentT3Threads: false,
  headlessReviewCli: null,
  headlessReviewBudgetUsd: 2,
  issueImportEnabled: true,
  issueImportModel: "haiku",
  issueImportBudgetUsd: 0.5,
  issueImportJiraTools: [],
  modelTiers: EMPTY_MODEL_TIERS,
  terminal: { kind: "auto" },
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  backupEnabled: false,
  backupDir: null,
  backupRemote: null,
  backupIntervalMinutes: 60,
};
