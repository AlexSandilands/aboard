import {
  AgentHarness,
  AUTOPILOT_DIGEST,
  AUTOPILOT_ORCHESTRATE,
  AUTOPILOT_REVIEW_PRS,
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
