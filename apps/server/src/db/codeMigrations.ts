import {
  AgentHarness,
  classifyLink,
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
};

/**
 * Set on an install that had data before providers were opt-in: once the server is up, detection adds the providers
 * whose MCP server is registered or whose hand-off entry it showed (services/providerSeed.ts), then removes it.
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
