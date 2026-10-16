import { z } from "zod";
import {
  FindingSeverity,
  FindingStatus,
  REVIEW_DONE_NEXT,
  REVIEW_LIMIT_NEXT,
  reviewIsDone,
  reviewLoopInstructions,
  reviewWantsAnotherRound,
  SubmitReviewInput,
  type TaskDetail,
} from "@repo/contracts";
import type { Services } from "../../services/types.ts";
import { actorField, run, taskField, taskResult, textResult, type ToolRegistrar } from "../shared.ts";

/** The loop instructions for the task's open round, or null when no round is waiting for a reviewer. */
export function openRoundInstructions(services: Services, taskId: string): string | null {
  const latest = services.reviews.list(taskId).at(-1);
  if (!latest || (latest.status !== "pending" && latest.status !== "stalled")) return null;
  const task = services.tasks.summary(taskId);
  return reviewLoopInstructions({
    task,
    round: latest.round,
    // The summary counts the current cycle's rounds, this open one included.
    cycleRound: task.review?.round ?? 1,
    maxRounds: task.review?.maxRounds ?? services.settings.get().reviewMaxRounds,
    skill: services.reviews.skillFor(taskId),
  });
}

/** get_task's note on a round still waiting for its reviewer, addressed to both sides. */
export function openRoundPointer(task: TaskDetail): string | null {
  const latest = task.reviews.at(-1);
  if (task.status !== "review" || !latest || (latest.status !== "pending" && latest.status !== "stalled")) return null;
  const ref = `"#${task.number}"`;
  return [
    `Review round ${latest.round} is waiting for its reviewer.`,
    `- If you are the reviewer: review and record your findings with submit_review(task: ${ref}, round: ${latest.round}, ...).`,
    `- If you implemented this task and no reviewer is running: call start_review(${ref}) for the review loop and the reviewer brief.`,
  ].join("\n");
}

const findingField = z.object({
  severity: FindingSeverity.describe(
    "blocking: wrong behaviour, data loss, security, task not done. major: likely bug or untested changed path. minor: maintainability. nit: polish.",
  ),
  title: z.string().min(1).describe("One problem, stated in a line."),
  file: z.string().optional().describe("Repo-relative path."),
  line: z.number().int().positive().optional(),
  body: z.string().optional().describe("What goes wrong and when (markdown)."),
  suggestion: z.string().optional().describe("A concrete fix."),
});

/** Local review tools: start_review, submit_review, resolve_finding. */
export const registerReviewTools: ToolRegistrar = (server, { services, actor }) => {
  server.registerTool(
    "start_review",
    {
      title: "Open a local review round",
      description:
        "Open the next local review round on a task and get the reviewer brief to hand to a fresh reviewer " +
        "subagent. Moving a task to Review opens round 1 by itself when auto-review is on, and the board opens " +
        "each further round itself once the last blocking or major finding of a round is resolved; call this for " +
        "the brief of the round that is open, or to review a task on request. When a round is already waiting for " +
        "its reviewer (say the board just opened it, or a subagent stopped at it and reported back), it returns " +
        "that round's brief instead of opening another. Refused once the round limit is reached.",
      inputSchema: { task: taskField, actor: actorField },
    },
    (args) =>
      run(() => {
        const id = services.tasks.resolveId(args.task);
        const round = services.reviews.openRound(id, { trigger: "manual", actor: actor(args.actor) });
        const instructions = openRoundInstructions(services, id);
        return textResult(
          `Round ${round.round} is open on #${services.tasks.summary(id).number}.\n\n${instructions ?? ""}`,
        );
      }),
  );

  server.registerTool(
    "submit_review",
    {
      title: "Record a review round's findings",
      description:
        "Reviewer: record your findings for a local review round, one problem per finding, or an empty list " +
        "when the change is clean. Defaults to the open round. Never edit files as the reviewer; this is how the " +
        "implementing agent and the user see what you found.",
      inputSchema: {
        task: taskField,
        round: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("The round from your brief. Defaults to the open round."),
        summary: z.string().optional().describe("One paragraph: overall verdict and the main risks."),
        headSha: z.string().optional().describe("Output of `git rev-parse HEAD` when you reviewed."),
        findings: z.array(findingField),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        const id = services.tasks.resolveId(args.task);
        const input = SubmitReviewInput.parse({
          round: args.round,
          summary: args.summary,
          headSha: args.headSha,
          findings: args.findings,
        });
        // The reviewer usually runs in the same client as the implementer; the suffix tells them apart in the log.
        const review = services.reviews.submit(id, input, args.actor?.trim() || `${actor()} (reviewer)`);
        const counts = new Map<string, number>();
        for (const f of review.findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
        const tally = review.findings.length
          ? [...counts].map(([severity, n]) => `${n} ${severity}`).join(", ")
          : "no findings";
        const task = services.tasks.summary(id);
        // Only the implementer opens the PR, but the reviewer's reply is how it learns the loop ended.
        const ending = !reviewIsDone(task.review)
          ? ""
          : task.review?.state === "stuck"
            ? " No further round is allowed: add that the implementing agent should fix what it can, then open the pull request, listing the findings still open in its description, unless the user asked it not to, and link it. If a pull request is already linked it should push to it instead."
            : " No further round is needed: add that the review loop is done and the implementing agent should open the pull request now, unless the user asked it not to, and link it (or push to the pull request already linked).";
        return textResult(
          `Recorded round ${review.round} on #${task.number}: ${tally}. ` +
            `Reply to the implementing agent with this tally; it reads the findings from the board.${ending}`,
        );
      }),
  );

  server.registerTool(
    "resolve_finding",
    {
      title: "Resolve a review finding",
      description:
        "Implementer: mark a review finding fixed once the fix is in, or wont_fix with a note saying why. Refer " +
        'to it by label ("R1.2" = round 1, finding 2) or id. status open reopens it. Resolving the last open ' +
        "blocking or major finding of a round makes the board open the next round (under the round limit); the " +
        "result says so, or what comes next.",
      inputSchema: {
        task: taskField,
        finding: z.string().min(1).describe('Finding label like "R1.2", or its id.'),
        status: FindingStatus,
        note: z.string().optional().describe("How it was fixed, or why it won't be. Required for wont_fix."),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        const id = services.tasks.resolveId(args.task);
        const finding = services.reviews.resolveFinding(
          id,
          args.finding,
          { status: args.status, ...(args.note !== undefined ? { note: args.note } : {}) },
          actor(args.actor),
        );
        const task = services.tasks.summary(id);
        const review = task.review;
        const gating = review ? review.open.blocking + review.open.major : 0;
        let next: string;
        const stillOpen = `${gating} blocking/major finding${gating === 1 ? "" : "s"} still open.`;
        if (gating > 0) {
          next = reviewIsDone(review) ? `${stillOpen} ${REVIEW_LIMIT_NEXT}` : stillOpen;
        } else if (review?.state === "pending") {
          // The board opens the next round when the last gating finding is resolved (services/reviews.ts).
          next = `No blocking or major findings are open. The board opened review round ${services.reviews.list(id).at(-1)?.round}: call start_review("#${task.number}") for its reviewer brief and run it with a fresh reviewer. Hold the PR until the loop ends.`;
        } else if (reviewWantsAnotherRound(review)) {
          next = `No blocking or major findings are open. Call start_review("#${task.number}") for the next round with a fresh reviewer.`;
        } else if (reviewIsDone(review)) {
          next = `No blocking or major findings are open. ${REVIEW_DONE_NEXT}`;
        } else next = "No blocking or major findings are open.";
        return taskResult(services, id, `${finding.label} marked ${finding.status}. ${next}`);
      }),
  );
};
