import {
  AgentHarness,
  AUTOPILOT_DIGEST,
  AUTOPILOT_FIX_PRS,
  AUTOPILOT_MERGE_EPIC_PRS,
  AUTOPILOT_ORCHESTRATE,
  AUTOPILOT_RECURRING,
  AUTOPILOT_REVIEW_PRS,
  AUTOPILOT_UNBLOCK_DEPENDENTS,
  AUTOPILOT_UNSTICK,
  classifyLink,
  INHERIT,
  type ModelChoice,
  type OperationModels,
  readLegacyModelChoice,
  CustomToolRule,
  JIRA_PRESET_INSTRUCTIONS,
  ProviderId,
  type ProviderSetting,
  TICKET_SYSTEM_PRESETS,
  type TicketSystem,
} from "@repo/contracts";
import type { Db } from "./database.ts";

/**
 * Migrations that need code rather than SQL, such as parsing a URL. Each runs once, in name order
 * with the `.sql` files, inside the same transaction and bookkeeping.
 */
export const CODE_MIGRATIONS: Readonly<Record<string, (db: Db) => void>> = {
  "008_enterprise_pr_links": reclassifyPrLinks,
  "036_ticket_systems_settings": jiraSettingsToTicketSystem,
  "040_providers_settings": seedProviders,
  "041_operation_models": operationModels,
  "043_merge_ready_prs": mergeReadyPrs,
  "044_autopilot_agent_defaults": autopilotAgentDefaults,
  "047_reminder_notifications": reminderNotifications,
  "048_recurring_without_switch": recurringWithoutSwitch,
  "049_custom_filters_to_scopes": customFiltersToScopes,
};

/**
 * Set on an install that had data before providers were opt-in: once the server is up, detection adds the providers
 * whose MCP server is registered or whose hand-off entry it showed (`seedFromDetection` in integrations/providers.ts), then removes it.
 */
export const PROVIDERS_DETECT_SEED_KEY = "providersDetectSeed";

/**
 * PR URLs on any host now parse as GitHub-style PRs (GitHub Enterprise), so links stored as plain
 * URLs, or as PRs with no ref, are given the ref the parser now finds. A plain URL that duplicates a
 * PR link on the same task is dropped, as adding it again would have returned the existing link.
 */
function reclassifyPrLinks(db: Db): void {
  const rows = db
    .prepare("SELECT id, task_id, kind, url FROM task_links WHERE kind = 'url' OR (kind = 'pr' AND ref_json IS NULL)")
    .all() as Array<{ id: string; task_id: string; kind: string; url: string }>;
  const duplicate = db.prepare("SELECT 1 FROM task_links WHERE task_id = ? AND kind = 'pr' AND url = ? AND id <> ?");
  const remove = db.prepare("DELETE FROM task_links WHERE id = ?");
  const update = db.prepare("UPDATE task_links SET kind = 'pr', ref_json = ? WHERE id = ?");
  for (const row of rows) {
    const classified = classifyLink(row.url);
    if (classified?.kind !== "pr" || !classified.ref) continue;
    if (row.kind === "url" && duplicate.get(row.task_id, row.url, row.id)) {
      remove.run(row.id);
      continue;
    }
    update.run(JSON.stringify(classified.ref), row.id);
  }
}

/**
 * The Jira settings become a ticket system with the id the Jira links were given in 036_ticket_systems.sql: the base
 * URL makes its link template and the import tools carry over. Only installs that used Jira get one, and it doesn't
 * link keys from titles by itself, since that guessed at anything shaped like a key.
 */
function jiraSettingsToTicketSystem(db: Db): void {
  const read = (key: string): unknown => {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
      | { value_json: string }
      | undefined;
    return row ? JSON.parse(row.value_json) : undefined;
  };
  const baseUrl = typeof read("jiraBaseUrl") === "string" ? (read("jiraBaseUrl") as string).replace(/\/+$/, "") : "";
  const tools = Array.isArray(read("issueImportJiraTools")) ? (read("issueImportJiraTools") as unknown[]) : [];
  db.prepare("DELETE FROM settings WHERE key IN ('jiraBaseUrl', 'issueImportJiraTools')").run();
  const used =
    db
      .prepare("SELECT 1 FROM task_links WHERE kind = 'ticket' AND json_extract(ref_json, '$.system') = 'jira'")
      .get() || db.prepare("SELECT 1 FROM task_imports WHERE system_id = 'jira'").get();
  if (!baseUrl && tools.length === 0 && !used) return;
  const preset = TICKET_SYSTEM_PRESETS.find((p) => p.system.id === "jira")!.system;
  const system: TicketSystem = {
    id: "jira",
    name: "Jira",
    keyPattern: preset.keyPattern,
    urlPattern: preset.urlPattern,
    ...(/^https?:\/\//i.test(baseUrl) ? { linkTemplate: `${baseUrl}/browse/{key}` } : {}),
    autoLink: false,
    // A rule the ticket system's form would refuse is dropped, or the system couldn't be saved again.
    importTools: tools.flatMap((t) => {
      const rule = CustomToolRule.safeParse(t);
      return rule.success && rule.data ? [rule.data] : [];
    }),
    importInstructions: JIRA_PRESET_INSTRUCTIONS,
  };
  const existing = read("ticketSystems");
  const systems = Array.isArray(existing) ? (existing as TicketSystem[]).filter((s) => s.id !== "jira") : [];
  db.prepare(
    "INSERT INTO settings (key, value_json) VALUES ('ticketSystems', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
  ).run(JSON.stringify([system, ...systems]));
}

/**
 * Providers became opt-in: the list is seeded with every provider the stored settings and links show in use, so
 * nothing the user relies on disappears, and the three CLI paths move into it. What only the machine can tell (an
 * MCP registration, a CLI the hand-off menus offered) is left to a detection pass after start-up.
 */
function seedProviders(db: Db): void {
  const rows = db.prepare("SELECT key, value_json FROM settings").all() as Array<{ key: string; value_json: string }>;
  const stored = new Map(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]));
  const text = (key: string): string | null => {
    const value = stored.get(key);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const cliPaths: Partial<Record<ProviderId, string | null>> = {
    "claude-code": text("headlessReviewCli"),
    codex: text("codexCli"),
    "copilot-cli": text("copilotCli"),
  };
  const used = new Set<ProviderId>();
  for (const [id, path] of Object.entries(cliPaths)) if (path) used.add(id as ProviderId);
  if (text("t3Token")) used.add("t3-code");
  if (stored.get("headlessReviewEnabled") === true) used.add("claude-code");

  // A tier or custom model with a model for a provider, or headless runs on it.
  const tiers = stored.get("modelTiers");
  const models = [
    ...(tiers && typeof tiers === "object" ? Object.values(tiers as Record<string, unknown>) : []),
    ...(Array.isArray(stored.get("modelProfiles")) ? (stored.get("modelProfiles") as unknown[]) : []),
  ];
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const { t3, cli, headless } = model as { t3?: unknown; cli?: unknown; headless?: unknown };
    if (t3) used.add("t3-code");
    if (cli && typeof cli === "object") {
      for (const [harness, value] of Object.entries(cli as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim() && AgentHarness.safeParse(harness).success) {
          used.add(harness as ProviderId);
        }
      }
    }
    if (AgentHarness.safeParse(headless).success) used.add(headless as ProviderId);
  }

  // Sessions and threads already linked to tasks: reopening them goes through their provider.
  const linked = db
    .prepare(
      `SELECT DISTINCT CASE kind WHEN 'agent_session' THEN COALESCE(json_extract(ref_json, '$.harness'), 'claude-code')
              ELSE 't3-code' END AS id
         FROM task_links WHERE kind IN ('agent_session', 't3_thread')`,
    )
    .all() as Array<{ id: string }>;
  for (const { id } of linked) if (ProviderId.safeParse(id).success) used.add(id as ProviderId);

  const existing = stored.has("providers");
  const providers: ProviderSetting[] = ProviderId.options
    .filter((id) => used.has(id))
    .map((id) => ({ id, enabled: true, cliPath: cliPaths[id] ?? null }));
  const upsert = db.prepare(
    "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
  );
  if (!existing) upsert.run("providers", JSON.stringify(providers));
  db.prepare("DELETE FROM settings WHERE key IN ('headlessReviewCli', 'codexCli', 'copilotCli')").run();
  // A new install has nothing to keep; one with projects or settings may rely on what only detection can see.
  const upgraded = rows.length > 0 || db.prepare("SELECT 1 FROM projects LIMIT 1").get() !== undefined;
  if (upgraded && !existing) upsert.run(PROVIDERS_DETECT_SEED_KEY, "true");
}

/**
 * One model choice per operation (ADR 0012). Everything that named a model in its own way is rewritten to ModelChoice,
 * keeping what was saved, since that is what ran: a typed model becomes that model on the provider it ran on. Defaults
 * never saved are left alone and take the operations' new defaults. Backups hold raw rows, so a restored old dump goes
 * through this too.
 */
function operationModels(db: Db): void {
  const read = (key: string): unknown => {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
      | { value_json: string }
      | undefined;
    return row ? JSON.parse(row.value_json) : undefined;
  };
  const upsert = db.prepare(
    "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
  );
  const chosen = (value: unknown): ModelChoice | null => {
    const choice = readLegacyModelChoice(value);
    return choice && choice !== INHERIT ? choice : null;
  };

  // The board's reviewer model was one setting for the subagent and the board reviewer; issue import had its own.
  // Both always ran on Claude Code.
  const existing = read("operationModels");
  const ops: OperationModels = existing && typeof existing === "object" ? { ...(existing as OperationModels) } : {};
  const savedReview = read("reviewModel");
  const review = chosen(savedReview);
  if (review) {
    ops.reviewer ??= review;
    ops.boardReviewer ??= review;
  } else if (readLegacyModelChoice(savedReview) === INHERIT && savedReview !== null && savedReview !== undefined) {
    // "From the task", saved on purpose: the board reviewer ran on the task's model. Its default is now the Standard
    // tier, and only the board's inherit keeps the task's model. The subagent inherits by default already. A saved
    // null was "none" (the CLI's default), so it takes the new default like an unsaved one.
    ops.boardReviewer ??= INHERIT;
  }
  const importModel = chosen(read("issueImportModel"));
  if (importModel) ops.issueImport ??= importModel;
  if (Object.keys(ops).length > 0) upsert.run("operationModels", JSON.stringify(ops));
  db.prepare("DELETE FROM settings WHERE key IN ('reviewModel', 'issueImportModel')").run();

  // Reviewer overrides on projects and tasks: inherit is stored as NULL, as before.
  for (const table of ["projects", "tasks"] as const) {
    const rows = db
      .prepare(`SELECT id, review_model_json FROM ${table} WHERE review_model_json IS NOT NULL`)
      .all() as Array<{
      id: string;
      review_model_json: string;
    }>;
    const update = db.prepare(`UPDATE ${table} SET review_model_json = ? WHERE id = ?`);
    for (const row of rows) {
      const choice = chosen(JSON.parse(row.review_model_json));
      update.run(choice ? JSON.stringify(choice) : null, row.id);
    }
  }

  // Automation configs: a typed `model` won over `modelChoice`, so it becomes the choice, on the provider it ran on.
  // That was the chosen tier's or custom model's headless harness (Claude Code when it named none), except where the
  // harness couldn't do what the automation needs and Claude Code ran it instead: reviews, Orchestrate and the digest.
  // `{from: "task"}` becomes inherit, and the digest's typed model (it had no choice) becomes its choice.
  const tiers = read("modelTiers");
  const profiles = read("modelProfiles");
  const headlessOf = (choice: ModelChoice | null): AgentHarness => {
    const setting =
      choice && choice !== INHERIT && "tier" in choice && tiers && typeof tiers === "object"
        ? (tiers as Record<string, unknown>)[choice.tier]
        : choice && choice !== INHERIT && "profile" in choice && Array.isArray(profiles)
          ? profiles.find((p: unknown) => (p as { id?: unknown } | null)?.id === choice.profile)
          : null;
    const harness = AgentHarness.safeParse((setting as { headless?: unknown } | null | undefined)?.headless);
    return harness.success ? harness.data : "claude-code";
  };
  const claudeOnly = new Set([AUTOPILOT_REVIEW_PRS, AUTOPILOT_ORCHESTRATE, AUTOPILOT_DIGEST]);
  const configs = db
    .prepare("SELECT scope_kind, scope_id, automation, config_json FROM autopilot_settings")
    .all() as Array<{ scope_kind: string; scope_id: string; automation: string; config_json: string }>;
  const updateConfig = db.prepare(
    "UPDATE autopilot_settings SET config_json = ? WHERE scope_kind = ? AND scope_id = ? AND automation = ?",
  );
  for (const row of configs) {
    const config = JSON.parse(row.config_json) as Record<string, unknown>;
    if (!("model" in config) && !("modelChoice" in config)) continue;
    const { model: typed, modelChoice, ...rest } = config;
    const choice = "modelChoice" in config ? readLegacyModelChoice(modelChoice) : null;
    const typedOn = claudeOnly.has(row.automation) ? "claude-code" : headlessOf(choice);
    const typedChoice = typeof typed === "string" && typed.trim() ? readLegacyModelChoice(typed, typedOn) : null;
    const next = typedChoice ?? choice;
    updateConfig.run(
      JSON.stringify(next ? { ...rest, modelChoice: next } : rest),
      row.scope_kind,
      row.scope_id,
      row.automation,
    );
  }

  // A custom automation's agent named a `tier` (null for the task's); it is now its `model`.
  const actions = db.prepare("SELECT id, action_json FROM autopilot_custom").all() as Array<{
    id: string;
    action_json: string;
  }>;
  const updateAction = db.prepare("UPDATE autopilot_custom SET action_json = ? WHERE id = ?");
  for (const row of actions) {
    const action = JSON.parse(row.action_json) as Record<string, unknown>;
    if (action.kind !== "agent" || !("tier" in action)) continue;
    const { tier, ...rest } = action;
    const model = tier ? (readLegacyModelChoice({ tier }) ?? INHERIT) : INHERIT;
    updateAction.run(JSON.stringify({ ...rest, model }), row.id);
  }

  // A tier's or custom model's `headless` harness is now its preferred `provider`.
  const renamed = (model: unknown): unknown => {
    if (!model || typeof model !== "object" || !("headless" in model)) return model;
    const { headless, ...rest } = model as Record<string, unknown>;
    return AgentHarness.safeParse(headless).success ? { ...rest, provider: headless } : rest;
  };
  if (tiers && typeof tiers === "object") {
    const next = Object.fromEntries(Object.entries(tiers as Record<string, unknown>).map(([k, v]) => [k, renamed(v)]));
    upsert.run("modelTiers", JSON.stringify(next));
  }
  if (Array.isArray(profiles)) upsert.run("modelProfiles", JSON.stringify(profiles.map(renamed)));
}

/**
 * Orchestrate loses May merge, and Merge ready PRs (merge_epic_prs) gains Into main (#127). Wherever Orchestrate was
 * on with May merge (on unless switched off), Merge ready PRs is switched on with Into main at that scope, so tasks
 * flagged for auto-merge keep landing there. A project with a setting of its own where Orchestrate didn't merge
 * (switched off there, or May merge off), under a board that gets Into main, gets Into main off. An explicit Off for
 * Merge ready PRs at that scope is the user's and stays. A project that took both Orchestrate and May merge from the
 * board gets no row: the board's covers it. One that switched Orchestrate on itself gets Merge ready PRs on, which turns
 * Into epic branches on there too, even under a board that has it off: the two can't be separated, and keeping main
 * merges is the point. The stored May merge values are dropped.
 */
function mergeReadyPrs(db: Db): void {
  type Row = { scope_kind: string; scope_id: string; mode: string; config_json: string };
  const rows = (automation: string) =>
    db
      .prepare("SELECT scope_kind, scope_id, mode, config_json FROM autopilot_settings WHERE automation = ?")
      .all(automation) as Row[];
  const configOf = (row: Row | undefined): Record<string, unknown> => {
    try {
      const parsed: unknown = row ? JSON.parse(row.config_json) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const now = new Date().toISOString();
  const merges = rows(AUTOPILOT_MERGE_EPIC_PRS);
  const setMerge = (kind: string, id: string, intoMain: boolean, switchOn: boolean) => {
    const existing = merges.find((r) => r.scope_kind === kind && r.scope_id === id);
    const mode = existing?.mode === "off" ? "off" : switchOn ? "on" : (existing?.mode ?? "inherit");
    const config = JSON.stringify({ ...configOf(existing), intoMain });
    db.prepare(
      `INSERT INTO autopilot_settings (scope_kind, scope_id, automation, mode, config_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope_kind, scope_id, automation) DO UPDATE SET mode = excluded.mode,
         config_json = excluded.config_json, updated_at = excluded.updated_at`,
    ).run(kind, id, AUTOPILOT_MERGE_EPIC_PRS, mode, config, now);
  };

  const orchestrate = rows(AUTOPILOT_ORCHESTRATE);
  const board = orchestrate.find((r) => r.scope_kind === "board");
  const boardOn = board?.mode === "on";
  const boardMay = configOf(board).mayMerge !== false;
  const boardIntoMain = boardOn && boardMay;
  if (boardIntoMain) setMerge("board", "", true, true);
  for (const row of orchestrate.filter((r) => r.scope_kind === "project")) {
    const on = row.mode === "on" || (row.mode === "inherit" && boardOn);
    const config = configOf(row);
    const ownMay = typeof config.mayMerge === "boolean";
    const may = ownMay ? config.mayMerge === true : boardMay;
    // Everything from the board: the board's row covers it (and an Off for Merge ready PRs there still holds).
    if (row.mode === "inherit" && !ownMay) continue;
    if (on && may) setMerge("project", row.scope_id, true, true);
    // Orchestrate off here, or on without May merge: nothing merged into main, so the board's new Into main mustn't.
    else if (boardIntoMain) setMerge("project", row.scope_id, false, false);
  }

  const strip = db.prepare(
    "UPDATE autopilot_settings SET config_json = ? WHERE automation = ? AND scope_kind = ? AND scope_id = ?",
  );
  for (const row of orchestrate) {
    const { mayMerge: _dropped, ...rest } = configOf(row);
    strip.run(JSON.stringify(rest), AUTOPILOT_ORCHESTRATE, row.scope_kind, row.scope_id);
  }
}

/**
 * Runner, budget, timeout and T3 access got board defaults (the engine's `agentDefaults`), and the PR rounds and fix
 * threshold moved from the engine into Review PRs and Fix PRs, the only automations that read them. Nothing that ran
 * before runs differently after:
 * - An engine PR value the user changed goes into the board-scope config of the automations that read it, unless that
 *   scope already sets the key; then the engine keys are dropped. Values left at their defaults need nothing.
 * - Review PRs, Fix PRs, Orchestrate and the digest had budgets and timeouts of their own below the board's defaults.
 *   Each one the user has a setting for (at any scope) keeps them in its board-scope config, unless that scope sets
 *   them. One never touched was never on, so it simply takes the board's defaults from now on.
 */
function autopilotAgentDefaults(db: Db): void {
  const upsertSetting = db.prepare(
    "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
  );
  const boardRow = db.prepare(
    "SELECT config_json FROM autopilot_settings WHERE scope_kind = 'board' AND scope_id = '' AND automation = ?",
  );
  const anyRow = db.prepare("SELECT 1 FROM autopilot_settings WHERE automation = ? LIMIT 1");
  const insertBoard = db.prepare(
    "INSERT INTO autopilot_settings (scope_kind, scope_id, automation, mode, config_json, updated_at) VALUES ('board', '', ?, 'inherit', ?, ?)",
  );
  const updateBoard = db.prepare(
    "UPDATE autopilot_settings SET config_json = ? WHERE scope_kind = 'board' AND scope_id = '' AND automation = ?",
  );
  /** Sets the keys the automation's board scope doesn't set already. */
  const setBoardKeys = (automation: string, values: Record<string, unknown>) => {
    if (Object.keys(values).length === 0) return;
    const row = boardRow.get(automation) as { config_json: string } | undefined;
    if (!row) {
      insertBoard.run(automation, JSON.stringify(values), new Date().toISOString());
      return;
    }
    const config = JSON.parse(row.config_json) as Record<string, unknown>;
    updateBoard.run(JSON.stringify({ ...values, ...config }), automation);
  };

  const ownLimits: Array<[string, { budgetUsd: number; timeoutMinutes: number }]> = [
    [AUTOPILOT_REVIEW_PRS, { budgetUsd: 2, timeoutMinutes: 20 }],
    [AUTOPILOT_FIX_PRS, { budgetUsd: 3, timeoutMinutes: 30 }],
    [AUTOPILOT_ORCHESTRATE, { budgetUsd: 3, timeoutMinutes: 30 }],
    [AUTOPILOT_DIGEST, { budgetUsd: 1, timeoutMinutes: 15 }],
  ];
  // Before anything below adds a row.
  const inUse = new Set(ownLimits.map(([automation]) => automation).filter((a) => anyRow.get(a) !== undefined));

  const engineRow = db.prepare("SELECT value_json FROM settings WHERE key = 'autopilotEngine'").get() as
    | { value_json: string }
    | undefined;
  const engine = engineRow ? (JSON.parse(engineRow.value_json) as unknown) : null;
  if (engine && typeof engine === "object") {
    const { prReviewRounds, prCommentRounds, prFixThreshold, ...rest } = engine as Record<string, unknown>;
    const changed = (value: unknown, def: unknown) => value !== undefined && value !== null && value !== def;
    const review: Record<string, unknown> = {};
    const fix: Record<string, unknown> = {};
    if (changed(prReviewRounds, 3)) {
      review.rounds = prReviewRounds;
      fix.attempts = prReviewRounds;
    }
    if (changed(prCommentRounds, 5)) fix.commentAttempts = prCommentRounds;
    if (changed(prFixThreshold, "major")) fix.fixThreshold = prFixThreshold;
    setBoardKeys(AUTOPILOT_REVIEW_PRS, review);
    setBoardKeys(AUTOPILOT_FIX_PRS, fix);
    upsertSetting.run("autopilotEngine", JSON.stringify(rest));
  }

  for (const [automation, limits] of ownLimits) {
    if (inUse.has(automation)) setBoardKeys(automation, limits);
  }
}

/**
 * The projects an automation was effectively on in, by the rule in docs/features/autopilot.md: the project's own mode
 * if it set one, else the board's, and also a project with an unarchived epic that switched it on (when epics can). Only
 * On counts: an automation in Preview recorded what it would do and acted on nothing, so it wasn't on.
 */
function projectsWhereOn(db: Db, automation: string, withEpics: boolean): string[] {
  const rows = db
    .prepare("SELECT scope_kind, scope_id, mode FROM autopilot_settings WHERE automation = ?")
    .all(automation) as Array<{ scope_kind: string; scope_id: string; mode: string }>;
  const board = rows.find((r) => r.scope_kind === "board")?.mode === "on";
  const own = new Map(rows.filter((r) => r.scope_kind === "project").map((r) => [r.scope_id, r.mode]));
  const viaEpic = new Set(
    withEpics
      ? (
          db
            .prepare(
              `SELECT DISTINCT t.project_id FROM autopilot_settings s JOIN tasks t ON t.id = s.scope_id
               WHERE s.scope_kind = 'epic' AND s.automation = ? AND s.mode = 'on'
                 AND t.archived_at IS NULL AND t.deleted_at IS NULL`,
            )
            .all(automation) as Array<{ project_id: string }>
        ).map((r) => r.project_id)
      : [],
  );
  const projects = db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>;
  return projects
    .filter(({ id }) => {
      const mode = own.get(id) ?? "inherit";
      return mode === "on" || (mode === "inherit" && board) || viaEpic.has(id);
    })
    .map((p) => p.id);
}

/**
 * "Remind me about stuck tasks" and "Unblock dependents" are notification settings now (docs/features/notifications.md).
 * Each starts on where its automation was on somewhere, since a notification setting has no scopes; a switch the
 * automation never had on is saved off, so it stays quiet whatever its default (a new install keeps the defaults). The
 * automations' settings go: they are not in the catalogue any more, and their runs stay in the history.
 */
function reminderNotifications(db: Db): void {
  // A new install has nothing to carry over, and takes the settings' defaults.
  const used = db.prepare("SELECT 1 FROM projects UNION ALL SELECT 1 FROM autopilot_settings LIMIT 1").get();
  if (!used) return;
  const unstickOn = projectsWhereOn(db, AUTOPILOT_UNSTICK, true).length > 0;
  const unblockOn = projectsWhereOn(db, AUTOPILOT_UNBLOCK_DEPENDENTS, true).length > 0;
  const row = db.prepare("SELECT value_json FROM settings WHERE key = 'notifications'").get() as
    | { value_json: string }
    | undefined;
  const stored = (row ? JSON.parse(row.value_json) : {}) as { kinds?: Record<string, boolean> };
  const next = {
    ...stored,
    kinds: { ...stored.kinds, thread_waited: unstickOn, task_quiet: unstickOn, task_unblocked: unblockOn },
  };
  db.prepare(
    "INSERT INTO settings (key, value_json) VALUES ('notifications', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
  ).run(JSON.stringify(next));
  db.prepare("DELETE FROM autopilot_settings WHERE automation IN (?, ?)").run(
    AUTOPILOT_UNSTICK,
    AUTOPILOT_UNBLOCK_DEPENDENTS,
  );
}

/**
 * Recurring tasks has no switch of its own now: an enabled rule runs. A rule in a project where the automation was
 * effectively off (it never ran) is disabled, so switching the switch away doesn't start tasks nobody expected. Its
 * settings go with the switch.
 */
function recurringWithoutSwitch(db: Db): void {
  const on = new Set(projectsWhereOn(db, AUTOPILOT_RECURRING, false));
  const disable = db.prepare("UPDATE autopilot_recurring SET enabled = 0 WHERE project_id = ? AND enabled = 1");
  for (const { id } of db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>) {
    if (!on.has(id)) disable.run(id);
  }
  db.prepare("DELETE FROM autopilot_settings WHERE automation = ?").run(AUTOPILOT_RECURRING);
}

/**
 * A custom automation's project and epic filters become its switches, so one place decides where it runs: a project
 * filter is Only in those projects (each keeping the state it had, the rest and their epics off), and an epic filter is
 * that epic's own setting at the state it had, everything else off and Tasks in epics off, so a project switched on
 * later still leaves other epics' tasks alone. Nothing runs anywhere it didn't before, nor stops where it did.
 */
function customFiltersToScopes(db: Db): void {
  type Row = { scope_kind: string; scope_id: string; mode: string };
  type State = "on" | "preview" | "off";
  const live = (mode: string | undefined): mode is "on" | "preview" => mode === "on" || mode === "preview";
  const customs = db.prepare("SELECT id, filters_json FROM autopilot_custom").all() as Array<{
    id: string;
    filters_json: string;
  }>;
  const projects = (db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>).map((p) => p.id);
  const epicProject = db.prepare("SELECT project_id FROM tasks WHERE id = ? AND kind = 'epic'");
  const writeFilters = db.prepare("UPDATE autopilot_custom SET filters_json = ? WHERE id = ?");
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO autopilot_settings (scope_kind, scope_id, automation, mode, config_json, updated_at, last_on_mode)
     VALUES (?, ?, ?, ?, '{}', ?, ?)
     ON CONFLICT (scope_kind, scope_id, automation) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at,
       last_on_mode = COALESCE(excluded.last_on_mode, autopilot_settings.last_on_mode)`,
  );

  for (const custom of customs) {
    let filters: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(custom.filters_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) filters = parsed as Record<string, unknown>;
    } catch {
      // A malformed row parses as no filters, as the repository read it.
    }
    const projectIds = Array.isArray(filters.projectIds)
      ? filters.projectIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    const epicId = typeof filters.epicId === "string" && filters.epicId ? filters.epicId : null;
    const labels = Array.isArray(filters.labels) ? filters.labels : [];
    writeFilters.run(JSON.stringify({ labels, epicTasks: epicId === null }), custom.id);
    if (projectIds.length === 0 && !epicId) continue;

    const key = `custom:${custom.id}`;
    const rows = db
      .prepare("SELECT scope_kind, scope_id, mode FROM autopilot_settings WHERE automation = ?")
      .all(key) as Row[];
    const own = (kind: string, id: string) => rows.find((r) => r.scope_kind === kind && r.scope_id === id)?.mode;
    const boardMode = own("board", "");
    const boardState: State = live(boardMode) ? boardMode : "off";
    const projectState = (id: string): State => {
      if (projectIds.length > 0 && !projectIds.includes(id)) return "off";
      const mode = own("project", id);
      return mode === undefined || mode === "inherit" ? boardState : (mode as State);
    };
    // Rows only where there is one already or a state to keep: Inherit under a board that is off is off.
    const set = (kind: string, id: string, state: State) => {
      const mode = state === "off" ? "inherit" : state;
      if (mode === "inherit" && own(kind, id) === undefined) return;
      upsert.run(kind, id, key, mode, now, live(mode) ? mode : null);
    };

    if (epicId) {
      const epic = epicProject.get(epicId) as { project_id: string } | undefined;
      const epicMode = own("epic", epicId);
      const epicState: State =
        !epic || (projectIds.length > 0 && !projectIds.includes(epic.project_id))
          ? "off"
          : epicMode === undefined || epicMode === "inherit"
            ? projectState(epic.project_id)
            : (epicMode as State);
      for (const row of rows) {
        if (!(row.scope_kind === "epic" && row.scope_id === epicId)) set(row.scope_kind, row.scope_id, "off");
      }
      set("board", "", "off");
      if (epic) set("epic", epicId, epicState);
      continue;
    }

    const states = new Map(projects.map((id) => [id, projectState(id)]));
    set("board", "", "off");
    for (const id of projects) set("project", id, states.get(id)!);
    for (const row of rows.filter((r) => r.scope_kind === "epic")) {
      const epic = epicProject.get(row.scope_id) as { project_id: string } | undefined;
      if (!epic || !projectIds.includes(epic.project_id)) set("epic", row.scope_id, "off");
    }
  }
}
