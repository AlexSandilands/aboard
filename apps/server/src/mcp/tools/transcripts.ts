import { z } from "zod";
import { renderTranscript } from "../format.ts";
import { run, taskField, textResult, type ToolRegistrar } from "../shared.ts";

/** get_session_transcript: a condensed, redacted view of a linked Claude Code session (docs/features/agent-sessions.md#transcripts). */
export const registerTranscriptTools: ToolRegistrar = (server, { services, ctx }) => {
  server.registerTool(
    "get_session_transcript",
    {
      title: "Condensed transcript of a task's Claude Code session",
      description:
        "Read how a task's linked Claude Code session went, for auditing a task or its prompts. Returns a condensed " +
        "transcript, one line per event: the user's messages, the assistant's final text of each turn, each tool call " +
        "(name and target), tool errors, permission denials, retries and interruptions, with the turn count and " +
        "duration on top. Token-shaped strings are redacted. Long text is cut and the transcript is paged: when more " +
        "follows, call again with the offset it names. Only sessions linked to the task can be read, and only Claude " +
        "Code sessions, not T3 Code threads or Copilot CLI sessions. Without session the newest linked " +
        "session is read, and the header names the others; pass session (its id, from get_task's links) to read " +
        "another.",
      inputSchema: {
        task: taskField,
        session: z
          .string()
          .optional()
          .describe(
            "The session's id (a UUID from get_task's links). Omit it for the newest Claude Code session linked to the task.",
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("The entry to start from, as the previous page said. Defaults to 0, the start."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(async () =>
        textResult(
          renderTranscript(
            await ctx.integrations.sessionTranscript(services.tasks.resolveId(args.task), {
              session: args.session,
              offset: args.offset,
            }),
          ),
        ),
      ),
  );
};
