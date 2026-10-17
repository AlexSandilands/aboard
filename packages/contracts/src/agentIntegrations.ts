import { z } from "zod";
import { AgentHarness } from "./agentSessions.ts";

// Whether a harness's CLI runs here and has the board's MCP server registered: what Settings → Integrations shows in
// each section's header. See docs/features/agent-sessions.md.

export const AgentIntegrationStatus = z.object({
  harness: AgentHarness,
  cli: z.object({
    /** The executable was found and `--version` ran. */
    found: z.boolean(),
    path: z.string().nullable(),
    version: z.string().nullable(),
    /** Why it isn't usable, when it isn't. */
    error: z.string().nullable(),
  }),
  mcp: z.object({
    /** Some entry of the harness's MCP config points at the board's MCP URL, whatever it is named. */
    registered: z.boolean(),
    /** Whether the harness reports that entry as connected; null when it can't tell. */
    connected: z.boolean().nullable(),
    /** Where the entry is configured ("user", "local", "project"), when known. */
    scope: z.string().nullable(),
    /** The entry's name in the harness's config. */
    name: z.string().nullable(),
    /** What was found or why the check couldn't tell, in words. Never a URL or token. */
    detail: z.string().nullable(),
  }),
});
export type AgentIntegrationStatus = z.infer<typeof AgentIntegrationStatus>;

/** `GET /api/agent-integrations`: one entry per harness, plus the MCP URL they were matched against. */
export const AgentIntegrations = z.object({
  mcpUrl: z.string(),
  harnesses: z.array(AgentIntegrationStatus),
});
export type AgentIntegrations = z.infer<typeof AgentIntegrations>;
