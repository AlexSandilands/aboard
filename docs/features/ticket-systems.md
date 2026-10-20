# Ticket systems

Board tasks: #247 (epic), #248.

A ticket system is an issue tracker the user configured: Jira, Linear, an in-house tracker. The board knows none of
them itself. Each system says what its keys and URLs look like, where a key's page is, and how an import reads one of
its tickets. Ticket keys and URLs become `ticket` links, and a ticket can be pasted as a new task's title to import it
([issue import](issue-import.md)). GitHub issues stay built in, as `issue` links.

## How it works

### A system

`TicketSystem` (`packages/contracts/src/ticketSystems.ts`) is stored in the settings KV as `ticketSystems`, a list:

| Field                | What it is                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `id`                 | A slug (`jira`, `shop-tracker`). Stored in each ticket link's ref, so it never changes          |
| `name`               | Shown beside keys: "Jira ABC-1"                                                                 |
| `keyPattern`         | Optional regular expression for a whole key, like `[A-Z][A-Z0-9_]+-\d+`                       |
| `urlPattern`         | Optional regular expression for a ticket's URL, with the key in its first capture group        |
| `linkTemplate`       | Optional `http(s)` URL with `{key}` where the key goes: a key's page                            |
| `autoLink`           | Link keys found in a task's title by themselves                                                 |
| `importTools`        | The MCP tools an import may call (`CustomToolRule`s, as custom automations take them)          |
| `importInstructions` | What an import is told about reading this system's tickets and finding an epic's children      |

The schema refuses a pattern that doesn't compile, a URL pattern without a group, a template without `{key}` or not
on `http(s)`, and two systems with one id. The settings service stores blank optional fields as absent (an empty
key pattern would match anywhere) and skips a stored system that no longer parses rather than failing reads.

`ticketPresets.ts` holds Jira and Linear as example data, like `automationExamples.ts`: **Add → From the Jira preset**
copies one into the list for the user to adjust. The board treats a system made from a preset like any other.

### Classifying a link

`classifyLink(value, { ticketSystems })` tries the built-ins first (T3 threads, PRs, GitHub issues), then each
system's URL pattern on a URL, then each system's key pattern on a bare value, in list order. The first match wins,
so a key two systems both match (Jira and Linear keys look alike) belongs to the system listed first. A ticket link
is `{ kind: "ticket", ref: { system, key }, url }`; its URL is the pasted URL, or the bare key. A bare key's page is
the system's template filled in when the link is shown (`ticketLinkHref` in the web app, `linkText` for agents), so
fixing a template later (the presets name a placeholder site) fixes every link made from a key.

`links.add` (the server) also accepts a key typed in lower case when only its upper case matches, and treats a
ticket as one link however it was written: adding `ABC-1` to a task with `https://…/browse/ABC-1` returns the
existing link.

### Finding keys in text

`findTicketKeys(text, systems)` returns the `{ system, key }` pairs the systems' key patterns find, in text order,
without repeats; lookarounds keep a key from matching inside a longer word (`xABC-1`, `ABC-1-2`). Only configured
patterns count, so `M0-1` or `UTF-8` are never keys unless a system says so. It drives:

- title auto-linking, for keys whose system has `autoLink` on (`linkTitleKeys` in `services/tasks.ts`);
- the **Missing links** hints on MCP task results, "Jira ABC-1: link(…)" (`missingLinkHints` in `mcp/format.ts`).

### Storage

`task_links.kind` is `ticket`, with `ref_json` `{"system","key"}`. `task_links.auto` (default 0) marks a link the
board added by itself. `task_imports.source_kind` is `ticket` or `issue`, and `system_id` names a ticket's system.

### Upgrading from the Jira settings

Before ticket systems the board knew Jira only: a `jira` link kind, a `jiraBaseUrl` and `issueImportJiraTools`.
Migration `036_ticket_systems.sql` rebuilds `task_links` and `task_imports`, turning `jira` rows into tickets of the
system `jira` (and renaming the kind in link events). The code migration `036_ticket_systems_settings` then creates
that system, but only on an install that used Jira (a base URL, import tools, or Jira links or imports): named
"Jira", with the preset's patterns and import instructions, `<jiraBaseUrl>/browse/{key}` as its template when a base
URL was set, the old import tools that are valid rules, and `autoLink` off. The old keys are deleted.

A backup taken before 036 still restores: the restore loads its `jiraBaseUrl` and `issueImportJiraTools`
(`RETIRED_EXPORTED_SETTINGS`) with the rest, and the migration converts them as the dump is upgraded.
`ticketSystems` itself is exported with the other settings.

## Decisions

- **Configured, not built in.** Matching anything shaped like `ABC-123` linked plan ids and version tags to Jira
  pages that don't exist (#231). Only the user knows which trackers they use and what their keys look like.
- **Systems are ordered.** Key formats overlap; the list order decides, the same way for pasting and for keys found
  in titles, so a key never goes to one system when typed and another when found.
- **A key nobody configured doesn't fail a create.** `create_task`, `add_to_backlog` and `create_epic` leave out a
  bare value no system matches and say so in their result, rather than refusing the task.
- **The Jira preset leaves standards out.** Its key pattern starts with a negative lookahead for prefixes like `UTF`,
  `SHA`, `ISO` and `CVE`, so "UTF-8" is never taken for an issue; it is part of the pattern, where the user sees it.
- **Auto-linking is opt-in.** A converted Jira system starts with `autoLink` off, since the old detector guessed.
- **The id is stored on links, the name isn't.** Renaming a system relabels every link; removing one leaves its links
  showing the id, still openable through their stored URL.

## Alternatives considered

- **Keep `jira` and add `linear`.** Every tracker would need code. A system is data, presets included.
- **One base URL per system.** A template with `{key}` fits trackers whose pages aren't `<base>/browse/<key>`.

## Code map

| Where                                                    | What                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/contracts/src/ticketSystems.ts`                | Schema, `ticketHref`, `ticketLabel`, matching, `findTicketKeys` |
| `packages/contracts/src/ticketPresets.ts`                | Jira and Linear presets                                      |
| `packages/contracts/src/links.ts`                        | `classifyLink`, `parseIssueSource`                           |
| `apps/server/src/db/migrations/036_ticket_systems.sql`   | Table rebuilds and the `jira` conversion                     |
| `apps/server/src/db/codeMigrations.ts`                   | Jira settings into a system                                  |
| `apps/server/src/services/settings.ts`                   | Normalizing, export, retired keys                            |
| `apps/server/src/services/links.ts`                      | Classification and de-duplication on add                     |
| `apps/web/src/components/settings/TicketSystemsSection.tsx` | The settings editor (`ticketSystems.logic.ts`)            |
| `apps/web/src/components/task/LinksSection.tsx`          | Ticket rows and the add-link preview                         |
