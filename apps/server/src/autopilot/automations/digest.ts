import { AUTOPILOT_DIGEST, dueDigestSlot, inQuietHours, localStamp } from "@repo/contracts";
import { agentBlock, produceDigest } from "../digest.ts";
import { DIGEST_DEFAULTS, DIGEST_FIELDS, DigestConfig } from "../digestConfig.ts";
import { defineAutomation } from "../types.ts";

export { AUTOPILOT_DIGEST };

interface DigestData {
  /** When the check ran: the period ends here. */
  at: string;
}

/**
 * Writes the daily digest of what changed: a board-wide summary of the period since the last digest, with a section
 * per project (a project switched Off is left out). Plain by default, built by code; or an agent writes it up, and
 * the plain digest is the fallback. The user can also ask for one at any time (`createDigestGenerator`).
 *
 * It is on or off for the board, and the schedule and settings are the board's. It isn't counted as an agent
 * automation (a plain digest shouldn't use up the caps or wait for a busy runner), so the summarised mode keeps
 * quiet hours, pause and the daily spend cap itself.
 */
export const digest = defineAutomation({
  key: AUTOPILOT_DIGEST,
  title: "Digest of what changed",
  description:
    "Writes a daily digest of what changed on the board: status moves, merged pull requests, new attention and Autopilot runs, as a plain list or written by an agent.",
  needsAgent: false,
  // The summarised mode waits on an agent; the engine must not hold up its other automations for that.
  background: true,
  // Never about a task, so an epic has nothing to switch.
  epicScope: false,
  schema: DigestConfig,
  fields: DIGEST_FIELDS,
  defaults: DIGEST_DEFAULTS,
  check: ({ services, engine, now, board }) => {
    // One at a time: a digest being written (here or by hand) would overlap a second one's period.
    if (!board || services.autopilot.status().active.some((r) => r.automation === AUTOPILOT_DIGEST)) return [];
    const since = [services.digests.latest()?.createdAt, services.autopilot.settingChangedAt(AUTOPILOT_DIGEST)]
      .filter((t) => t !== undefined && t !== null)
      .sort()
      .at(-1);
    const slot = since ? dueDigestSlot(board, now, since) : null;
    if (!slot) return [];
    // Not recorded while held, so the slot is still due when the window ends.
    if (board.mode === "summarised" && inQuietHours(engine.quietHours, now.getHours() * 60 + now.getMinutes())) {
      return [];
    }
    return [
      {
        dedupeKey: `digest:${localStamp(slot)}`,
        summary: `make the daily ${board.mode} digest`,
        projectId: null,
        data: { at: now.toISOString() } satisfies DigestData,
      },
    ];
  },
  act: async (candidate, { services, runner, config, run }) => {
    const now = new Date((candidate.data as DigestData).at);
    const made = await produceDigest({
      services,
      runner,
      config,
      trigger: "schedule",
      run,
      now,
      noAgent: agentBlock(services, now),
    });
    return { summary: made.summary, ...(made.costUsd !== null ? { costUsd: made.costUsd } : {}) };
  },
});
