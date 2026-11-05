import {
  AGENT_HARNESSES,
  type AgentHarness,
  CliModel,
  cliEffortFor,
  DEFAULT_HANDOFF_MENUS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_REVIEW_MAX_ROUNDS,
  EMPTY_MODEL_TIERS,
  type AppSettings,
  MODEL_PROFILES_MAX,
  ModelProfile,
  type ModelTiers,
  type ModelTierSetting,
  type NotificationKind,
  type NotificationSettings,
  readOperationModels,
  ProviderSetting,
  type SavedViews,
  sanitizeKeybindingOverrides,
  TicketSystem,
} from "@repo/contracts";
import { PROVIDERS_DETECT_SEED_KEY } from "../db/codeMigrations.ts";
import type { Repos } from "../db/repos/index.ts";
import { AppError } from "../errors.ts";
import { AUTOPILOT_ENGINE_KEY } from "./autopilot.ts";
import type { Core } from "./core.ts";
import { GENERAL_PROJECT_KEY } from "./projects.ts";
import type { SettingsService } from "./types.ts";

type StoredSettings = Omit<AppSettings, "t3TokenSet"> & { t3Token: string | null };

const DEFAULTS: StoredSettings = {
  ticketSystems: [],
  githubPolling: true,
  t3LinkTarget: "desktop",
  t3Token: null,
  agentT3Threads: false,
  autoReview: false,
  reviewSkill: { source: "builtin" },
  planSkill: { source: "builtin" },
  reviewMaxRounds: DEFAULT_REVIEW_MAX_ROUNDS,
  headlessReviewEnabled: false,
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
    "ticketSystems",
    "githubPolling",
    "t3LinkTarget",
    "agentT3Threads",
    "autoReview",
    "reviewSkill",
    "planSkill",
    "reviewMaxRounds",
    "headlessReviewEnabled",
    "providers",
    "handoffMenus",
    "headlessReviewBudgetUsd",
    "issueImportEnabled",
    "operationModels",
    "issueImportBudgetUsd",
    "modelTiers",
    "modelProfiles",
    "notifications",
    "savedViews",
    "keybindings",
    "automationVariables",
  ] satisfies Array<keyof StoredSettings>),
]);

/**
 * Settings older versions exported that a migration since converted (036_ticket_systems_settings turns the Jira ones
 * into a ticket system, 039_review_model renames headlessReviewModel, 040_providers_settings moves the CLI paths into
 * providers, 041_operation_models moves reviewModel and issueImportModel into operationModels). A restore loads them with an old backup so that migration sees them; they never reach a
 * database at the current schema.
 */
export const RETIRED_EXPORTED_SETTINGS: ReadonlySet<string> = new Set([
  "jiraBaseUrl",
  "issueImportJiraTools",
  "headlessReviewModel",
  "headlessReviewCli",
  "copilotCli",
  "codexCli",
  "reviewModel",
  "issueImportModel",
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

/**
 * A tier's CLI efforts for the harnesses that have a model set: without one there is nothing for the effort to go
 * with, so a leftover from a cleared model is dropped. The levels themselves are checked by the schema.
 */
function cliEfforts(
  efforts: ModelTierSetting["cliEffort"],
  cli: ModelTierSetting["cli"],
): ModelTierSetting["cliEffort"] {
  if (!efforts || !cli) return undefined;
  for (const [harness, effort] of Object.entries(efforts)) {
    if (cli[harness as AgentHarness] && !cliEffortFor(harness as AgentHarness, effort)) {
      throw new AppError("VALIDATION", `${AGENT_HARNESSES[harness as AgentHarness].label} has no effort ${effort}`);
    }
  }
  const entries = Object.entries(efforts).filter(([harness]) => cli[harness as keyof typeof cli]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** The given tiers over the current ones. Blank descriptions are stored as none, so the T3 label fallback applies. */
const mergeModelTiers = (current: ModelTiers, input: Partial<ModelTiers>): ModelTiers => ({
  ...current,
  ...Object.fromEntries(
    Object.entries(input).map(([tier, setting]) => {
      const { cli: _cli, cliEffort: _cliEffort, ...rest } = setting;
      const cli = cliModels(setting.cli);
      const cliEffort = cliEfforts(setting.cliEffort, cli);
      return [
        tier,
        {
          ...rest,
          description: setting.description?.trim() || null,
          ...(cli ? { cli } : {}),
          ...(cliEffort ? { cliEffort } : {}),
        },
      ];
    }),
  ),
});

/** Custom models as stored: blank descriptions as none and CLI models checked, like a tier's. */
const storedProfiles = (profiles: readonly ModelProfile[]): ModelProfile[] =>
  profiles.map((profile) => {
    const { cli: _cli, cliEffort: _cliEffort, ...rest } = profile;
    const cli = cliModels(profile.cli);
    const cliEffort = cliEfforts(profile.cliEffort, cli);
    return {
      ...rest,
      description: profile.description?.trim() || null,
      ...(cli ? { cli } : {}),
      ...(cliEffort ? { cliEffort } : {}),
    };
  });

/**
 * The stored custom models, each read on its own: one that no longer parses (a hand edit, a limit changed since) is
 * dropped rather than the whole list, which the next edit would then overwrite. A repeated id keeps its first.
 */
export function storedProfileList(stored: unknown): ModelProfile[] {
  const profiles: ModelProfile[] = [];
  for (const entry of Array.isArray(stored) ? stored : []) {
    const parsed = ModelProfile.safeParse(entry);
    if (parsed.success && !profiles.some((p) => p.id === parsed.data.id)) profiles.push(parsed.data);
  }
  return profiles.slice(0, MODEL_PROFILES_MAX);
}

/** A provider as stored: a blank CLI path is none, so the CLI is looked up on PATH. */
const normalizeProvider = (provider: ProviderSetting): ProviderSetting => ({
  id: provider.id,
  enabled: provider.enabled,
  cliPath: provider.cliPath?.trim() || null,
});

/**
 * The stored providers, each read on its own like custom models: one that no longer parses (a hand edit, a provider
 * since dropped) is skipped rather than the whole list, and a repeated id keeps its first.
 */
export function storedProviderList(stored: unknown): ProviderSetting[] {
  const providers: ProviderSetting[] = [];
  for (const entry of Array.isArray(stored) ? stored : []) {
    const parsed = ProviderSetting.safeParse(entry);
    if (parsed.success && !providers.some((p) => p.id === parsed.data.id))
      providers.push(normalizeProvider(parsed.data));
  }
  return providers;
}

/** Notification settings as stored: only what the user set. */
interface StoredNotificationSettings {
  muteInQuietHours?: boolean;
  kinds?: Partial<Record<NotificationKind, boolean>>;
}

/** The stored notification settings over the defaults, so a kind added later follows its default. */
const mergeNotificationSettings = (stored: StoredNotificationSettings | undefined): NotificationSettings => ({
  muteInQuietHours: stored?.muteInQuietHours ?? DEFAULT_NOTIFICATION_SETTINGS.muteInQuietHours,
  kinds: { ...DEFAULT_NOTIFICATION_SETTINGS.kinds, ...stored?.kinds },
});

/**
 * A ticket system as stored: optional fields left blank are left out (an empty key pattern would match anywhere), and
 * repeated import tools are dropped.
 */
const normalizeTicketSystem = (system: TicketSystem): TicketSystem => {
  const { keyPattern, urlPattern, linkTemplate, ...rest } = system;
  return {
    ...rest,
    ...(keyPattern ? { keyPattern } : {}),
    ...(urlPattern ? { urlPattern } : {}),
    ...(linkTemplate ? { linkTemplate } : {}),
    importTools: [...new Set(system.importTools)],
  };
};

/** The stored systems that are still valid; one that isn't (hand-edited, say) is skipped rather than failing reads. */
const storedTicketSystems = (stored: unknown): TicketSystem[] =>
  Array.isArray(stored)
    ? stored.flatMap((s) => {
        const parsed = TicketSystem.safeParse(s);
        return parsed.success ? [normalizeTicketSystem(parsed.data)] : [];
      })
    : [];

/** Stored settings over their defaults. Also read by summaries, which derive review state from max rounds. */
export function loadSettings(repos: Repos): StoredSettings {
  const stored = repos.settings.all();
  const pick = <K extends keyof StoredSettings>(key: K): StoredSettings[K] =>
    stored.has(key) ? (stored.get(key) as StoredSettings[K]) : DEFAULTS[key];
  return {
    ...(Object.fromEntries(
      (Object.keys(DEFAULTS) as Array<keyof StoredSettings>).map((key) => [key, pick(key)]),
    ) as unknown as StoredSettings),
    ticketSystems: storedTicketSystems(stored.get("ticketSystems")),
    operationModels: readOperationModels(stored.get("operationModels")),
    modelProfiles: storedProfileList(stored.get("modelProfiles")),
    providers: storedProviderList(stored.get("providers")),
    notifications: mergeNotificationSettings(stored.get("notifications") as StoredNotificationSettings | undefined),
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
        if (input.ticketSystems !== undefined) {
          repos.settings.set("ticketSystems", input.ticketSystems.map(normalizeTicketSystem));
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
        if (input.providers !== undefined) {
          repos.settings.set("providers", input.providers.map(normalizeProvider));
          fx.providers();
        }
        if (input.handoffMenus !== undefined) {
          repos.settings.set("handoffMenus", { ...load().handoffMenus, ...input.handoffMenus });
        }
        if (input.headlessReviewBudgetUsd !== undefined) {
          repos.settings.set("headlessReviewBudgetUsd", input.headlessReviewBudgetUsd);
        }
        if (input.issueImportEnabled !== undefined) repos.settings.set("issueImportEnabled", input.issueImportEnabled);
        if (input.operationModels !== undefined) {
          const next = { ...load().operationModels };
          for (const [op, choice] of Object.entries(input.operationModels)) {
            if (choice === null) delete next[op as keyof typeof next];
            else if (choice !== undefined) next[op as keyof typeof next] = choice;
          }
          repos.settings.set("operationModels", next);
        }
        if (input.issueImportBudgetUsd !== undefined) {
          repos.settings.set("issueImportBudgetUsd", input.issueImportBudgetUsd);
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
        if (input.modelProfiles !== undefined) {
          repos.settings.set("modelProfiles", storedProfiles(input.modelProfiles));
        }
        if (input.savedViews !== undefined) repos.settings.set("savedViews", uniqueViews(input.savedViews));
        if (input.keybindings !== undefined) repos.settings.set("keybindings", input.keybindings);
        if (input.socialNetwork !== undefined) repos.settings.set("socialNetwork", input.socialNetwork);
        if (input.automationVariables !== undefined) {
          repos.settings.set("automationVariables", input.automationVariables);
          // Which projects a custom automation still needs a variable in shows on its row.
          fx.autopilot();
        }
        if (input.notifications !== undefined) {
          const current = load().notifications;
          // Only the switches the user set are stored, not the merged record: a kind that isn't there follows the
          // default, so changing a default later reaches everyone who never touched that switch.
          const stored = repos.settings.all().get("notifications") as StoredNotificationSettings | undefined;
          repos.settings.set("notifications", {
            muteInQuietHours: input.notifications.muteInQuietHours ?? current.muteInQuietHours,
            kinds: { ...stored?.kinds, ...input.notifications.kinds },
          } satisfies StoredNotificationSettings);
        }
      });
      return get();
    },
    t3Token: () => load().t3Token,
    providersSeedPending: () => repos.settings.all().get(PROVIDERS_DETECT_SEED_KEY) === true,
    clearProvidersSeed: () => core.write(() => repos.settings.delete(PROVIDERS_DETECT_SEED_KEY)),
  };
}
