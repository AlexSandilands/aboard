import { z } from "zod";
import { AGENT_HARNESSES, AgentHarness } from "./agentSessions.ts";
import {
  customProfile,
  describeChoice,
  describeRunModel,
  INHERIT,
  type ModelChoice,
  ModelChoice as ModelChoiceSchema,
  type ModelSettings,
  profileCliEffort,
  profileCliModel,
  resolveTaskModel,
  type RunModel,
  type RunModelSource,
  type RunProfile,
  tierProfile,
} from "./modelProfiles.ts";
import {
  type CliEffort,
  cliEffortFor,
  modelTierDescription,
  modelTierLabel,
  type SuggestedModel,
} from "./modelTiers.ts";
import { type ProviderId, type ProviderSetting } from "./providers.ts";

// Every operation that runs a model, what each needs from the provider that runs it, and the one resolver that picks
// the model and the provider (docs/features/autopilot.md#models, ADR 0012). No provider or model is a default anywhere:
// an operation's default is a tier or inherit, and a tier runs on whichever capable provider the user added.

// ── What a headless CLI can be held to ───────────────────────────────────

/** What a harness's headless CLI can be held to, beyond doing work in a folder. */
export const DriverCapability = z.enum([
  /** A JSON schema the final answer must match. */
  "outputSchema",
  /**
   * A read-only run held apart from the user's setup: it can't write or reach the network, and gets none of the
   * user's MCP servers or the checkout's settings. For the user's own input (a task's diff, a settings question).
   */
  "readOnly",
  /**
   * The lockdown for agents that read untrusted text: `readOnly`, plus file reads confined to the working folder and
   * no shell beyond exact commands (and a board-only MCP config).
   */
  "untrusted",
  /** A run with no tools at all (`access: "none"`). */
  "noTools",
  /** Extra allow and deny rules in Claude Code's syntax (`tools`, `deniedTools`). */
  "toolRules",
  /** A spending cap per run. */
  "budget",
  /** The board gives the session its id before the run starts; otherwise the CLI reports it. */
  "presetSessionId",
  /**
   * The board's run tools: the CLI can be pointed at one MCP server, the run's `/mcp/run` endpoint, with no other
   * (docs/decisions/0013-board-served-run-tools.md).
   */
  "runTools",
]);
export type DriverCapability = z.infer<typeof DriverCapability>;
export type DriverCapabilities = Record<DriverCapability, boolean>;

const LIMITED: Omit<DriverCapabilities, "presetSessionId" | "runTools"> = {
  outputSchema: false,
  readOnly: false,
  untrusted: false,
  noTools: false,
  toolRules: false,
  budget: false,
};

/**
 * Each harness's headless CLI: `claude -p` can be held to everything; `codex exec` returns structured output and runs
 * isolated read-only, but can't confine its reads; the Copilot CLI only does work in a folder. Each claim was checked
 * against the real CLI (docs/features/autopilot.md#headless-drivers). The server's drivers read them from here.
 */
export const HEADLESS_CAPABILITIES: Record<AgentHarness, DriverCapabilities> = {
  "claude-code": {
    outputSchema: true,
    readOnly: true,
    untrusted: true,
    noTools: true,
    toolRules: true,
    budget: true,
    presetSessionId: true,
    runTools: true,
  },
  // `--output-schema` (strict), `--sandbox read-only` with `--ignore-user-config`, and `-c mcp_servers.<name>…` for the
  // board's endpoint as its only server. Not `untrusted`: its read-only sandbox still reads any file the user can.
  codex: { ...LIMITED, outputSchema: true, readOnly: true, presetSessionId: false, runTools: true },
  // Not yet: whether the Copilot CLI can be held to one given MCP server is tracked on its own.
  "copilot-cli": { ...LIMITED, presetSessionId: true, runTools: false },
};

/** What an operation can ask of the provider that runs it. */
export const OperationNeed = z.enum([
  "outputSchema",
  "readOnly",
  "untrusted",
  "noTools",
  "toolRules",
  "runTools",
  "edit",
]);
export type OperationNeed = z.infer<typeof OperationNeed>;

/** The capability a need takes; `edit` is work in a folder, which every headless CLI does. */
const NEED_CAPABILITY: Record<OperationNeed, DriverCapability | null> = {
  outputSchema: "outputSchema",
  readOnly: "readOnly",
  untrusted: "untrusted",
  noTools: "noTools",
  toolRules: "toolRules",
  runTools: "runTools",
  edit: null,
};

/** A need in words, after "a provider that can". */
export const NEED_WORDS: Record<OperationNeed, string> = {
  outputSchema: "return structured output",
  readOnly: "run read-only, apart from your own setup",
  untrusted: "lock a run down to read untrusted input",
  noTools: "run with no tools",
  toolRules: "follow tool rules of its own",
  runTools: "use the board's run tools",
  edit: "edit code",
};

/** What a harness's headless CLI makes of an operation's needs. */
export interface NeedsCheck {
  /** Needs it can't meet: it can't run the operation. */
  missing: OperationNeed[];
  /**
   * Needs it meets only in part: the untrusted lockdown, by a CLI that runs isolated read-only but can't confine its
   * reads. It runs the operation only when the user chose it, with a warning (needsWarning).
   */
  warned: OperationNeed[];
}

const hasCapability = (harness: AgentHarness, need: OperationNeed): boolean => {
  const capability = NEED_CAPABILITY[need];
  return capability === null || HEADLESS_CAPABILITIES[harness][capability];
};

/** The needs a harness's headless CLI can't meet, and the ones it meets with a warning, each in the order given. */
export function checkNeeds(harness: AgentHarness, needs: readonly OperationNeed[]): NeedsCheck {
  const out: NeedsCheck = { missing: [], warned: [] };
  for (const need of needs) {
    if (hasCapability(harness, need)) continue;
    if (need === "untrusted" && hasCapability(harness, "readOnly")) out.warned.push(need);
    else out.missing.push(need);
  }
  return out;
}

/** The needs a harness's headless CLI can't meet, in the order given. A need it meets with a warning isn't one. */
export const missingNeeds = (harness: AgentHarness, needs: readonly OperationNeed[]): OperationNeed[] =>
  checkNeeds(harness, needs).missing;

/**
 * The warning a harness carries for these needs, or null: what could go wrong when it runs an operation whose
 * lockdown it can't fully keep. The picker shows it on the provider and the run repeats it in its note.
 */
export function needsWarning(harness: AgentHarness, needs: readonly OperationNeed[]): string | null {
  return checkNeeds(harness, needs).warned.includes("untrusted")
    ? `${harnessLabel(harness)} can't confine its file reads, so text anyone can write (a pull request, an issue) could make it leak local files into what it returns.`
    : null;
}

// ── The registry ─────────────────────────────────────────────────────────

export const OperationId = z.enum([
  "reviewer",
  "boardReviewer",
  "prReview",
  "prFix",
  "taskRun",
  "orchestrate",
  "digest",
  "customTask",
  "customDetached",
  "issueImport",
  "ask",
  "launch",
]);
export type OperationId = z.infer<typeof OperationId>;

export interface OperationInfo {
  label: string;
  /** What the provider must be able to do. A run may ask for more (a custom automation's tools). */
  needs: readonly OperationNeed[];
  /** It works on one task, so `inherit` at the bottom is the task's own model. */
  taskScoped: boolean;
  /** Its default: a tier, or inherit. Never a provider's model. */
  default: ModelChoice;
  /** Task and project reviewer overrides apply to it. */
  reviewerOverrides?: boolean;
}

/** Every operation that runs a model, in the order a settings page lists them. */
export const OPERATIONS: Record<OperationId, OperationInfo> = {
  taskRun: { label: "Task runs", needs: ["edit"], taskScoped: true, default: INHERIT },
  launch: { label: "New sessions", needs: [], taskScoped: true, default: INHERIT },
  reviewer: {
    label: "Reviewer subagent",
    needs: [],
    taskScoped: true,
    default: INHERIT,
    reviewerOverrides: true,
  },
  boardReviewer: {
    label: "Board reviewer",
    // runHeadlessReview: the user's own task, read-only and apart from their setup, with a findings schema.
    needs: ["outputSchema", "readOnly"],
    taskScoped: true,
    default: { tier: "standard" },
    reviewerOverrides: true,
  },
  prReview: {
    label: "PR review",
    needs: ["outputSchema", "untrusted", "runTools"],
    taskScoped: true,
    default: { tier: "standard" },
  },
  prFix: { label: "PR fix", needs: ["edit"], taskScoped: true, default: INHERIT },
  orchestrate: {
    label: "Orchestrate",
    needs: ["untrusted", "toolRules"],
    taskScoped: false,
    default: { tier: "standard" },
  },
  digest: { label: "Digest", needs: ["noTools"], taskScoped: false, default: { tier: "light" } },
  customTask: { label: "Custom automations on a task", needs: ["edit"], taskScoped: true, default: INHERIT },
  customDetached: {
    label: "Custom automations without a task",
    needs: [],
    taskScoped: false,
    default: { tier: "light" },
  },
  issueImport: {
    label: "Issue import",
    // runImport: a GitHub issue (text anyone can write) in the prompt, with a schema. A ticket also needs tool rules
    // for the user's MCP servers (IMPORT_TICKET_NEEDS).
    needs: ["outputSchema", "untrusted"],
    taskScoped: false,
    default: { tier: "light" },
  },
  // The user's own question, answered in an empty folder.
  ask: { label: "Ask", needs: ["outputSchema", "readOnly"], taskScoped: false, default: { tier: "light" } },
};

/** What a ticket import asks beyond the issue import's needs: the user's own MCP servers, held to tool rules. */
export const IMPORT_TICKET_NEEDS: readonly OperationNeed[] = ["toolRules"];

/** The board's model per operation; one left out takes its default. */
export const OperationModels = z.partialRecord(OperationId, ModelChoiceSchema);
export type OperationModels = z.infer<typeof OperationModels>;

/** Stored operation models, each read on its own: one that doesn't parse (a hand edit) takes its default. */
export function readOperationModels(stored: unknown): OperationModels {
  if (!stored || typeof stored !== "object") return {};
  const out: OperationModels = {};
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    const id = OperationId.safeParse(key);
    const choice = ModelChoiceSchema.safeParse(value);
    if (id.success && choice.success) out[id.data] = choice.data;
  }
  return out;
}

// ── The resolver ─────────────────────────────────────────────────────────

export interface OperationSettings extends ModelSettings {
  operationModels: OperationModels;
  providers: readonly ProviderSetting[];
}

/** What the operation is run for, each level optional. */
export interface OperationContext {
  task?: { labels: readonly string[]; suggestedModel: SuggestedModel | null } | null;
  /** The task's and the project's reviewer overrides (only read for operations they apply to). */
  taskOverride?: ModelChoice | null;
  projectOverride?: ModelChoice | null;
  /** The automation's config at its scope, then its action's own choice; the first that isn't inherit wins. */
  automation?: ReadonlyArray<ModelChoice | null | undefined>;
  /** What this run asks beyond the operation's needs (a custom automation's tools). */
  needs?: readonly OperationNeed[];
}

/**
 * The choice that applies to an operation, before a provider is picked, most specific first: the task's reviewer
 * override, the project's, the automation's config, the board's setting, the operation's default. `inherit` defers
 * to the next. When all of them inherit, a task-scoped operation takes the task's own model (resolveTaskModel), and
 * anything else the light tier. A custom model since deleted is passed over with a note.
 */
export function resolveOperationChoice(
  op: OperationId,
  ctx: OperationContext,
  settings: ModelSettings & { operationModels: OperationModels },
): RunModel {
  const info = OPERATIONS[op];
  type Level = [RunModelSource, ModelChoice | null | undefined];
  const levels: Level[] = [
    ...(info.reviewerOverrides ? [["task", ctx.taskOverride] as Level, ["project", ctx.projectOverride] as Level] : []),
    ...(ctx.automation ?? []).map((choice): Level => ["automation", choice]),
    ["board", settings.operationModels[op]],
    ["default", info.default],
  ];
  const notes: string[] = [];
  const note = () => notes.join("\n") || null;
  for (const [source, choice] of levels) {
    // The board's inherit, set on purpose, on an operation on a task skips its default for the task's own model, so a
    // tier default (PR review, the board reviewer) can still follow the task.
    if (choice === INHERIT && source === "board" && info.taskScoped) break;
    if (!choice || choice === INHERIT) continue;
    if ("tier" in choice) {
      return {
        profile: tierProfile(settings.modelTiers, choice.tier),
        explicit: null,
        source,
        label: null,
        note: note(),
      };
    }
    if ("profile" in choice) {
      const profile = settings.modelProfiles.find((p) => p.id === choice.profile);
      if (profile) return { profile: customProfile(profile), explicit: null, source, label: null, note: note() };
      notes.push(
        `The model "${choice.profile}" set for ${info.label} no longer exists in Settings → Agents → Models, so the next setting was used.`,
      );
      continue;
    }
    return { profile: null, explicit: choice, source, label: null, note: note() };
  }
  return resolveTaskModel(info.taskScoped ? (ctx.task ?? null) : null, settings, note());
}

/** What runs an operation: a provider, its model (null for the CLI's default) and effort, and why. */
export interface ResolvedModel {
  ok: true;
  provider: AgentHarness;
  model: string | null;
  effort: CliEffort | null;
  source: RunModelSource;
  /** The choice it came from. */
  choice: RunModel;
  /**
   * Fallbacks worth telling the user about (another provider, no model for it, a deleted model) and the warning, else
   * null.
   */
  note: string | null;
  /** What could go wrong on this provider (needsWarning): it runs only because the user chose it. Also in `note`. */
  warning: string | null;
}

export interface ModelRefusal {
  ok: false;
  /** Why nothing can run it, in words a person can act on. */
  reason: string;
}

export type OperationResolution = ResolvedModel | ModelRefusal;

/** The record a run keeps of what it ran on (`AutopilotRun.model`). */
export const RunModelRecord = z.object({
  provider: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  source: z.string(),
});
export type RunModelRecord = z.infer<typeof RunModelRecord>;

export const runModelRecord = (
  resolved: Pick<ResolvedModel, "provider" | "model" | "effort" | "source">,
): RunModelRecord => ({
  provider: resolved.provider,
  model: resolved.model,
  effort: resolved.effort,
  source: resolved.source,
});

/**
 * The provider T3 Code files a model under, from the instance id the tier saved ("claudeAgent", "codex"), or null
 * when it is none of the CLIs'. Lets a tier's T3 model stand in for a CLI model it doesn't set.
 */
export function t3InstanceHarness(instanceId: string): AgentHarness | null {
  const id = instanceId.toLowerCase();
  if (id.startsWith("claude")) return "claude-code";
  if (id.startsWith("codex")) return "codex";
  if (id.startsWith("copilot") || id.startsWith("github")) return "copilot-cli";
  return null;
}

/** A profile's model on a harness: its CLI model, else its T3 model when T3 files it under that harness. */
function profileModelOn(
  profile: RunProfile,
  harness: AgentHarness,
): { model: string; effort: CliEffort | null } | null {
  const cli = profileCliModel(profile, harness);
  if (cli) return { model: cli, effort: profileCliEffort(profile, harness) };
  const t3 = profile.setting.t3?.selection;
  // The effort goes with the CLI model it was set for, so a T3 model standing in carries none.
  return t3 && t3InstanceHarness(t3.instanceId) === harness ? { model: t3.model, effort: null } : null;
}

const harnessLabel = (harness: AgentHarness) => AGENT_HARNESSES[harness].label;

/** Where a choice was made for the operation itself, so a provider it prefers may run it with a warning. */
const CHOSEN_SOURCES: ReadonlySet<RunModelSource> = new Set(["task", "project", "automation", "board"]);

/** The headless providers the user added and switched on, in their order. */
const activeHarnesses = (settings: { providers: readonly ProviderSetting[] }): AgentHarness[] =>
  settings.providers.flatMap((p) => {
    const harness = AgentHarness.safeParse(p.id);
    return p.enabled && harness.success ? [harness.data] : [];
  });

const listWords = (words: readonly string[]): string =>
  words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

/**
 * The model and provider an operation runs on, or why it can't run. The choice is resolveOperationChoice's. A typed
 * model runs on its own provider, which must be added, switched on and able to do what the operation needs. A tier or
 * custom model runs on its preferred provider when that is all three, else on the first provider in the user's
 * Providers order that is all three and has a model for it (a T3 model T3 files under it counts), else on the first
 * that is all three, on the CLI's default model. Any fallback is in `note`. With no such provider at all it refuses,
 * and never runs something else quietly. A provider that meets the needs only with a warning (checkNeeds) runs it
 * only when the user chose it: a typed model on it, or the preferred provider of the chosen tier or custom model.
 * It is never fallen back to, and its warning is in `note` and `warning`.
 */
export function resolveOperationModel(
  op: OperationId,
  ctx: OperationContext,
  settings: OperationSettings,
): OperationResolution {
  const info = OPERATIONS[op];
  const choice = resolveOperationChoice(op, ctx, settings);
  const needs = [...new Set([...info.needs, ...(ctx.needs ?? [])])];
  const active = activeHarnesses(settings);
  const checks = new Map(active.map((h) => [h, checkNeeds(h, needs)]));
  const meets = (h: AgentHarness) => checks.get(h)?.missing.length === 0;
  // Fallen back to: only providers that meet every need without a warning.
  const capable = active.filter((h) => meets(h) && checks.get(h)?.warned.length === 0);
  const notes = [choice.note];
  const done = (provider: AgentHarness, model: string | null, effort: CliEffort | null): ResolvedModel => {
    const warning = needsWarning(provider, needs);
    return {
      ok: true,
      provider,
      model,
      effort,
      source: choice.source,
      choice,
      note: [...notes, warning].filter(Boolean).join("\n") || null,
      warning,
    };
  };

  if (choice.explicit) {
    const { provider, model, effort } = choice.explicit;
    if (!active.includes(provider)) {
      return {
        ok: false,
        reason: `${info.label} is set to run ${model} on ${harnessLabel(provider)}, which isn't added and switched on in Settings → Agents → Providers.`,
      };
    }
    const missing = missingNeeds(provider, needs);
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `${info.label} is set to run on ${harnessLabel(provider)}, which can't ${listWords(missing.map((n) => NEED_WORDS[n]))}.`,
      };
    }
    return done(provider, model, cliEffortFor(provider, effort));
  }

  // resolveOperationChoice always ends on a profile when nothing is typed.
  const profile = choice.profile!;
  const named = describeChoice(choice) ?? profile.name;
  const preferred = profile.setting.provider;
  // A preferred provider that meets the needs only with a warning runs only when the tier or custom model was chosen
  // for this operation (on the task, project, automation or Models page). A tier that is merely the operation's
  // default, or the task's own model, was picked for other work, so it never moves untrusted text onto that provider.
  const chosenHere = CHOSEN_SOURCES.has(choice.source);
  const preferredRuns =
    preferred !== undefined &&
    active.includes(preferred) &&
    meets(preferred) &&
    (chosenHere || checks.get(preferred)?.warned.length === 0);

  if (!preferredRuns && capable.length === 0) {
    const wanted = needs.filter((n) => NEED_CAPABILITY[n] !== null);
    const can = wanted.length > 0 ? ` that can ${listWords(wanted.map((n) => NEED_WORDS[n]))}` : "";
    const warned = active.filter((h) => meets(h));
    const withWarning =
      warned.length > 0
        ? ` ${listWords(warned.map(harnessLabel))} can run it with a warning if you choose ${warned.length === 1 ? "it" : "one"} for ${info.label} under Settings → Agents → Operations.`
        : "";
    return {
      ok: false,
      reason: `${info.label} needs a provider${can}; add one in Settings → Agents → Providers.${withWarning}`,
    };
  }

  let provider: AgentHarness;
  if (preferredRuns) provider = preferred;
  else {
    provider = capable.find((h) => profileModelOn(profile, h)) ?? capable[0]!;
    if (preferred) {
      const missing = missingNeeds(preferred, needs);
      const why = !active.includes(preferred)
        ? "isn't added and switched on in Settings → Agents → Providers"
        : missing.length > 0
          ? `can't ${listWords(missing.map((n) => NEED_WORDS[n]))}`
          : `can't fully ${listWords((checks.get(preferred)?.warned ?? []).map((n) => NEED_WORDS[n]))} and wasn't chosen for ${info.label}`;
      notes.push(`${named} prefers ${harnessLabel(preferred)}, which ${why}, so ${harnessLabel(provider)} ran it.`);
    }
  }
  const on = profileModelOn(profile, provider);
  if (!on && (profile.setting.t3 || Object.values(profile.setting.cli ?? {}).some(Boolean))) {
    notes.push(
      `${named} has no ${harnessLabel(provider)} model in Settings → Agents → Models, so the CLI's default ran.`,
    );
  }
  return done(provider, on?.model ?? null, on?.effort ?? null);
}

/** "Model: Deep tier (Opus), from label x: opus on Claude Code": the line a run notes about its model. */
export function describeResolution(resolved: ResolvedModel): string {
  const named = describeRunModel(resolved.choice);
  const model = resolved.model ?? "the CLI's default model";
  const head = named && !resolved.choice.explicit ? `${named}: ${model}` : model;
  return `Model: ${head} on ${harnessLabel(resolved.provider)}${resolved.effort ? `, ${resolved.effort} effort` : ""}`;
}

// ── The reviewer subagent's line ─────────────────────────────────────────

const CLAUDE_AGENT_ALIASES = ["opus", "sonnet", "haiku", "fable"] as const;

/**
 * The short name Claude Code's Agent tool takes for a model (`opus`, `sonnet`, `haiku`, `fable`), read from the
 * model id the user saved ("claude-opus-5-5", "opus[1m]"); null when the id names none of them.
 */
export const claudeAgentAlias = (modelId: string): string | null =>
  CLAUDE_AGENT_ALIASES.find((alias) => modelId.toLowerCase().includes(alias)) ?? null;

/**
 * The line of the review brief that says which model the reviewer subagent runs on, or null when nothing is set above
 * the task's own model (the reviewer then runs on the implementer's own). It names the Claude Code way to pick it and
 * leaves other harnesses to do their best.
 */
export function reviewerModelLine(
  ctx: Pick<OperationContext, "task" | "taskOverride" | "projectOverride">,
  settings: ModelSettings & { operationModels: OperationModels },
): string | null {
  const choice = resolveOperationChoice("reviewer", ctx, settings);
  if (choice.source === "label" || choice.source === "tier" || choice.source === "fallback") return null;
  let claudeModel: string | null = null;
  let subject: string;
  if (choice.explicit) {
    subject = `\`${choice.explicit.model}\`${choice.explicit.provider === "claude-code" ? "" : ` (${harnessLabel(choice.explicit.provider)})`}`;
    if (choice.explicit.provider === "claude-code") claudeModel = choice.explicit.model;
  } else {
    const profile = choice.profile!;
    claudeModel = profileModelOn(profile, "claude-code")?.model ?? null;
    if (profile.tier) {
      const description = modelTierDescription(settings.modelTiers, profile.tier);
      subject = `the ${modelTierLabel(profile.tier).toLowerCase()} tier${description ? ` (${description})` : ""}`;
    } else subject = describeChoice(choice) ?? profile.name;
  }
  const inClaudeCode = claudeModel
    ? `in Claude Code pass \`model: "${claudeAgentAlias(claudeModel) ?? claudeModel}"\` to the Agent tool; elsewhere `
    : "";
  return `Run the reviewer on ${subject}: ${inClaudeCode}pick that model if your harness lets you, else use your own.`;
}

/** The provider ids the MCP hint lists. */
export const activeProviderIds = (settings: { providers: readonly ProviderSetting[] }): ProviderId[] =>
  activeHarnesses(settings);
