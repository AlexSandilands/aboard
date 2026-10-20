import type { TicketSystem } from "./ticketSystems.ts";

// Starting points for the ticket systems settings (docs/features/ticket-systems.md): example data only, like
// automationExamples.ts. The board treats every system alike; a preset just fills the form in. The link templates
// name a placeholder site the user replaces with their own.

export interface TicketSystemPreset {
  /** Shown in the "Add from preset" menu. */
  label: string;
  description: string;
  system: TicketSystem;
}

/** A Jira-style key: a project key of capitals and digits, a dash, a number. */
const PROJECT_KEY = String.raw`[A-Z][A-Z0-9_]+-\d+`;

/**
 * Prefixes of standards, encodings and identifiers that look like keys ("UTF-8", "SHA-256", "CVE-2024-1"), left out
 * of the Jira key pattern so they are never taken for issues.
 */
const NOT_PROJECTS = "AES|CVE|CWE|ECMA|GPT|HMAC|HTTP|IEC|IEEE|ISO|MD|RFC|RSA|SHA|TLS|UTF|WCAG";

export const JIRA_PRESET_INSTRUCTIONS = [
  "Read the issue with the Jira tool you have: fetch it by its key. Only read, never create, edit, comment on or transition anything.",
  "It is an epic when its issue type is Epic, or its hierarchy level is 1. Find an epic's child issues with the Jira search tool: run both searches, as separate queries: the JQL `\"Epic Link\" = <key>` (the epic's issues, in company-managed projects) and the JQL `parent = <key>` (its sub-tasks, and the epic's issues elsewhere).",
  "If the Epic Link search fails because that field is unknown in the issue's project (team-managed projects, or instances where it has been removed), that is fine: carry on with the parent results. Any other failure of either search, such as a permissions or syntax error, is not. Merge the keys without duplicates, the Epic Link results first.",
].join("\n\n");

export const TICKET_SYSTEM_PRESETS: readonly TicketSystemPreset[] = [
  {
    label: "Jira",
    description: "Keys like PROJ-123, and /browse/ URLs on any Jira site.",
    system: {
      id: "jira",
      name: "Jira",
      keyPattern: String.raw`(?!(?:${NOT_PROJECTS})-)` + PROJECT_KEY,
      urlPattern: String.raw`^https?://.+/browse/(${PROJECT_KEY})(?:[/?#]|$)`,
      linkTemplate: "https://your-site.atlassian.net/browse/{key}",
      autoLink: false,
      importTools: [],
      importInstructions: JIRA_PRESET_INSTRUCTIONS,
    },
  },
  {
    label: "Linear",
    description: "Keys like ENG-42, and linear.app issue URLs.",
    system: {
      id: "linear",
      name: "Linear",
      keyPattern: String.raw`[A-Z][A-Z0-9]+-\d+`,
      urlPattern: String.raw`^https://linear\.app/[^/]+/issue/([A-Z][A-Z0-9]+-\d+)(?:[/?#]|$)`,
      linkTemplate: "https://linear.app/your-workspace/issue/{key}",
      autoLink: false,
      importTools: [],
      importInstructions:
        "Read the issue with the Linear tool you have: fetch it by its identifier. Only read, never create, edit, comment on or change anything. It is an epic when it has sub-issues; list them with the same tool.",
    },
  },
];
