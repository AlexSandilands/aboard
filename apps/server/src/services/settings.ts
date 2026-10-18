import {
  CliModel,
  DEFAULT_HANDOFF_MENUS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_REVIEW_MAX_ROUNDS,
  EMPTY_MODEL_TIERS,
  type AppSettings,
  type ModelTiers,
  type ModelTierSetting,
  type NotificationSettings,
  parseHeadlessModel,
  type SavedViews,
  sanitizeKeybindingOverrides,
} from "@repo/contracts";
import type { Repos } from "../db/repos/index.ts";
import { AppError } from "../errors.ts";
import { AUTOPILOT_ENGINE_KEY } from "./autopilot.ts";
import type { Core } from "./core.ts";
import { GENERAL_PROJECT_KEY } from "./projects.ts";
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
  planSkill: { source: "builtin" },
  reviewMaxRounds: DEFAULT_REVIEW_MAX_ROUNDS,
  headlessReviewEnabled: false,
  headlessReviewCli: null,
  copilotCli: null,
  handoffMenus: DEFAULT_HANDOFF_MENUS,
  headlessReviewBudgetUsd: 2,
  headlessReviewModel: null,
  issueImportEnabled: true,
  issueImportModel: { model: "haiku" },
  issueImportBudgetUsd: 0.5,
  issueImportJiraTools: [],
  modelTiers: EMPTY_MODEL_TIERS,
  terminal: { kind: "auto" },
  terminalOpenIn: "tab",
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  savedViews: [],
  keybindings: {},
  socialNetwork: false,
  backupEnabled: false,
  backupDir: null,
  backupRemote: null,
  backupIntervalMinutes: 60,
};

/**
 * Settings written to a backup, as an allow-list so a new key (a secret, a machine-specific path) stays out until
 * someone decides otherwise. Left out: the T3 token, and the terminal, backup and skill sync (services/skillSync.ts)
 * settings, which describe this machine; and the social network's switch, which goes with its posts (never backed up). A forced restore keeps them
 * from the database it replaces. Autopilot's engine settings are stored beside
 * these (services/autopilot.ts) and exported too; its pause is not, so a restore can't lift Pause all.
 */
export const EXPORTED_SETTINGS: ReadonlySet<string> = new Set<string>([
  AUTOPILOT_ENGINE_KEY,
  // Goes with the projects, so a restore doesn't make a second General.
  GENERAL_PROJECT_KEY,
  ...([
    "jiraBaseUrl",
    "githubPolling",
    "t3LinkTarget",
    "agentT3Threads",
    "autoReview",
    "reviewSkill",
    "planSkill",
    "reviewMaxRounds",
    "headlessReviewEnabled",
    "headlessReviewCli",
    "copilotCli",
    "handoffMenus",
    "headlessReviewBudgetUsd",
    "headlessReviewModel",
    "issueImportEnabled",
    "issueImportModel",
    "issueImportBudgetUsd",
    "issueImportJiraTools",
    "modelTiers",
    "notifications",
    "savedViews",
    "keybindings",
  ] satisfies Array<keyof StoredSettings>),
]);

/**
 * A tier's CLI models with blanks dropped. Each goes on a command line as `--model`, so one that isn't a CliModel is
 * refused.
 */
function cliModels(cli: ModelTierSetting["cli"]): ModelTierSetting["cli"] {
  if (!cli) return undefined;
  const entries = Object.entries(cli).flatMap(([harness, model]) => {
    const value = model?.trim();
    if (!value) return [];
    if (!CliModel.safeParse(value).success) throw new AppError("VALIDATION", `Not a model name: ${value}`);
    return [[harness, value] as const];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** The given tiers over the current ones. Blank descriptions are stored as none, so the T3 label fallback applies. */
const mergeModelTiers = (current: ModelTiers, input: Partial<ModelTiers>): ModelTiers => ({
  ...current,
  ...Object.fromEntries(
    Object.entries(input).map(([tier, setting]) => {
      const { cli: _cli, ...rest } = setting;
      const cli = cliModels(setting.cli);
      return [tier, { ...rest, description: setting.description?.trim() || null, ...(cli ? { cli } : {}) }];
    }),
  ),
});

/** The stored notification settings over the defaults, so a kind added later starts on. */
const mergeNotificationSettings = (stored: Partial<NotificationSettings> | undefined): NotificationSettings => ({
  muteInQuietHours: stored?.muteInQuietHours ?? DEFAULT_NOTIFICATION_SETTINGS.muteInQuietHours,
  kinds: { ...DEFAULT_NOTIFICATION_SETTINGS.kinds, ...stored?.kinds },
});

/** Stored settings over their defaults. Also read by summaries, which derive review state from max rounds. */
export function loadSettings(repos: Repos): StoredSettings {
  const stored = repos.settings.all();
  const pick = <K extends keyof StoredSettings>(key: K): StoredSettings[K] =>
    stored.has(key) ? (stored.get(key) as StoredSettings[K]) : DEFAULTS[key];
  return {
    ...(Object.fromEntries(
      (Object.keys(DEFAULTS) as Array<keyof StoredSettings>).map((key) => [key, pick(key)]),
    ) as unknown as StoredSettings),
    // Saved as a bare model name before tiers were an option.
    headlessReviewModel: parseHeadlessModel(stored.get("headlessReviewModel")),
    issueImportModel: parseHeadlessModel(stored.get("issueImportModel")) ?? DEFAULTS.issueImportModel,
    notifications: mergeNotificationSettings(stored.get("notifications") as Partial<NotificationSettings> | undefined),
    keybindings: sanitizeKeybindingOverrides(stored.get("keybindings")),
    handoffMenus: { ...DEFAULT_HANDOFF_MENUS, ...(stored.get("handoffMenus") as StoredSettings["handoffMenus"]) },
  };
}

/**
 * The views with the first of each id kept, so a repeated id can't make two rows act as one. Two views can't share a
 * name (ignoring case) either: the sidebar and the palette would list indistinguishable entries.
 */
const uniqueViews = (views: SavedViews): SavedViews => {
  const kept = views.filter((view, index) => views.findIndex((v) => v.id === view.id) === index);
  const names = new Set<string>();
  for (const view of kept) {
    const name = view.name.toLowerCase();
    if (names.has(name)) throw new AppError("VALIDATION", `A view named "${view.name}" already exists`);
    names.add(name);
  }
  return kept;
};

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
        if (input.planSkill !== undefined) repos.settings.set("planSkill", input.planSkill);
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
        if (input.copilotCli !== undefined) repos.settings.set("copilotCli", blankToNull(input.copilotCli));
        if (input.handoffMenus !== undefined) {
          repos.settings.set("handoffMenus", { ...load().handoffMenus, ...input.handoffMenus });
        }
        if (input.headlessReviewBudgetUsd !== undefined) {
          repos.settings.set("headlessReviewBudgetUsd", input.headlessReviewBudgetUsd);
        }
        if (input.headlessReviewModel !== undefined) {
          repos.settings.set("headlessReviewModel", input.headlessReviewModel);
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
        if (input.terminalOpenIn !== undefined) repos.settings.set("terminalOpenIn", input.terminalOpenIn);
        if (input.modelTiers !== undefined)
          repos.settings.set("modelTiers", mergeModelTiers(load().modelTiers, input.modelTiers));
        if (input.savedViews !== undefined) repos.settings.set("savedViews", uniqueViews(input.savedViews));
        if (input.keybindings !== undefined) repos.settings.set("keybindings", input.keybindings);
        if (input.socialNetwork !== undefined) repos.settings.set("socialNetwork", input.socialNetwork);
        if (input.notifications !== undefined) {
          const current = load().notifications;
          repos.settings.set("notifications", {
            muteInQuietHours: input.notifications.muteInQuietHours ?? current.muteInQuietHours,
            kinds: { ...current.kinds, ...input.notifications.kinds },
          } satisfies NotificationSettings);
        }
      });
      return get();
    },
    t3Token: () => load().t3Token,
  };
}
