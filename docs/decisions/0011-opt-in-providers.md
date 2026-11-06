# 0011 Providers are opt-in, with one detection source

Status: Accepted

## Context

The board works with four providers: T3 Code, and the Claude Code, Codex and Copilot CLIs. Until now each had a
section in Settings → Integrations whether or not the user had it, and the hand-off menus, the model tier fields and
the Headless runs select offered each one the moment its CLI was on PATH. Someone with only Claude Code still saw
Codex and Copilot everywhere, half-configured.

Detection had grown in four places with four shapes: `GET /api/agent-clis` (does the executable exist),
`GET /api/agent-integrations` (CLI version and MCP registration), the settings Ask's own check, and the board
reviewer's `POST /api/review/test-cli`. They could disagree about the same CLI, and each read the CLI path from a
different setting (`headlessReviewCli`, `codexCli`, `copilotCli`).

## Decision

- **A provider is shown only once the user adds it.** The `providers` setting keeps `{ id, enabled, cliPath }` per
  added provider, in the user's order. Everything that offers a provider (hand-off menus, the dialogs opened from
  them, the model tier and custom-model fields, the Headless runs select, agents starting T3 threads) checks
  `providerActive`. Settings → Providers is the only place that lists the rest, in its Add provider dialog.
- **Switching off keeps the entry; removing drops it.** Both confirm with what stops working. Sessions and threads
  already linked to tasks still open: a link is history, not an offer.
- **One instance per provider.** T3 Code supports several accounts per provider; the board has no use for that yet,
  and an id per provider keeps every reference a plain `ProviderId`.
- **`GET /api/providers` is the only detection.** It returns every provider, added or not, with its CLI check, MCP
  registration, T3 Code status and models scan, behind a one-minute cache that Re-check skips. The menus derive what
  they need from it; the old routes are gone.
- **Upgrading loses nothing.** Migration `040_providers_settings` adds every provider the stored settings and links
  show in use and moves the three CLI paths into the list. A one-time pass after start-up adds what only the machine
  can tell: a registered MCP server, or a hand-off entry the menus were showing.

## Consequences

- A new install shows an empty Providers page and no provider anywhere else until one is added.
- Code that runs a CLI reads its path with `harnessCliSetting(settings, harness)`; nothing reads a per-CLI setting.
- A new provider is an entry in `PROVIDERS` and `ProviderId`, an editor in `ProviderEditors.tsx`, and its checks in
  `integrations/providers.ts`.
- Old `integrations.<provider>.*` settings links redirect to `providers.<provider>.*` (`redirectSettingsTarget`).
