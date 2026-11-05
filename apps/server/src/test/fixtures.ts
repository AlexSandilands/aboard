import { hostname } from "node:os";
import {
  DEFAULT_HANDOFF_MENUS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_REVIEW_MAX_ROUNDS,
  EMPTY_MODEL_TIERS,
  machineNameFrom,
  TICKET_SYSTEM_PRESETS,
  type AppSettings,
  type TicketSystem,
} from "@repo/contracts";

/** The Jira preset with a site, linking keys from titles: what most tests that use ticket keys configure. */
export const TEST_JIRA: TicketSystem = {
  ...TICKET_SYSTEM_PRESETS.find((p) => p.system.id === "jira")!.system,
  linkTemplate: "https://jira.example.com/browse/{key}",
  autoLink: true,
};

/** Settings as a fresh install returns them, for fakes of SettingsService. */
export const defaultSettings: AppSettings = {
  ticketSystems: [],
  githubPolling: true,
  t3LinkTarget: "desktop",
  t3TokenSet: false,
  autoReview: false,
  reviewSkill: { source: "builtin" },
  planSkill: { source: "builtin" },
  reviewMaxRounds: DEFAULT_REVIEW_MAX_ROUNDS,
  headlessReviewEnabled: false,
  agentT3Threads: false,
  providers: [],
  handoffMenus: DEFAULT_HANDOFF_MENUS,
  headlessReviewBudgetUsd: 2,
  issueImportEnabled: true,
  operationModels: {},
  issueImportBudgetUsd: 0.5,
  modelTiers: EMPTY_MODEL_TIERS,
  modelProfiles: [],
  terminal: { kind: "auto" },
  terminalOpenIn: "tab",
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  savedViews: [],
  keybindings: {},
  socialNetwork: false,
  automationVariables: [],
  backupEnabled: false,
  backupDir: null,
  backupRemote: null,
  backupIntervalMinutes: 60,
  // The host name's default, as on whatever machine runs the tests.
  machineName: machineNameFrom(hostname()),
  machineNameIsDefault: true,
};
