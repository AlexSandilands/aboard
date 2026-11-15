import { randomUUID } from "node:crypto";
import type { BridgeReply, BridgeRequest, BridgeRequestMethod } from "@repo/contracts";

// A runner's way to ask its board something (docs/features/remote-machines.md#asking-the-board). A runner never
// dials out: the board may be behind a NAT or reach it only through an SSH tunnel. So a question waits here until
// the board's next poll of the change log carries it back, and the answer arrives as a request of the board's own.

/** The board polls every few seconds while connected; one that hasn't for this long counts as away. */
const REACHABLE_WITHIN_MS = 20_000;
const ANSWER_WITHIN_MS = 15_000;

export class BridgeUnreachableError extends Error {
  constructor() {
    super("The board can't be reached from this machine right now");
    this.name = "BridgeUnreachableError";
  }
}

export interface BridgeChannel {
  /** Whether the board polled lately, so a question would reach it. */
  reachable(): boolean;
  /** Notes that the board is here: called on each of its polls. */
  touch(): void;
  /** Asks the board. Rejects with `BridgeUnreachableError` when it is away or doesn't answer in time. */
  request(method: BridgeRequestMethod, params: unknown): Promise<unknown>;
  /** The questions not yet handed to the board, which are handed over by this call. */
  take(): BridgeRequest[];
  /** The board's answer to a question. One nobody waits for any more is dropped. */
  reply(reply: BridgeReply): void;
  /** Resolves when there is something for the board (`wake`), or after `ms`. */
  wait(ms: number): Promise<void>;
  /** Ends every `wait`: the log grew, or there is a question. */
  wake(): void;
}

interface Waiting {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function createBridgeChannel(deps: { now?: () => Date } = {}): BridgeChannel {
  const now = deps.now ?? (() => new Date());
  let lastPollAt: number | null = null;
  const outgoing: BridgeRequest[] = [];
  const waiting = new Map<string, Waiting>();
  const sleepers = new Set<() => void>();

  const channel: BridgeChannel = {
    reachable: () => lastPollAt !== null && now().getTime() - lastPollAt < REACHABLE_WITHIN_MS,
    touch: () => {
      lastPollAt = now().getTime();
    },

    request(method, params) {
      if (!channel.reachable()) return Promise.reject(new BridgeUnreachableError());
      const id = randomUUID();
      const answer = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          const at = outgoing.findIndex((r) => r.id === id);
          if (at >= 0) outgoing.splice(at, 1);
          reject(new BridgeUnreachableError());
        }, ANSWER_WITHIN_MS);
        timer.unref();
        waiting.set(id, { resolve, reject, timer });
      });
      outgoing.push({ id, method, params });
      channel.wake();
      return answer;
    },

    take: () => outgoing.splice(0),

    reply(reply) {
      const asked = waiting.get(reply.id);
      if (!asked) return;
      waiting.delete(reply.id);
      clearTimeout(asked.timer);
      if (reply.ok) asked.resolve(reply.result);
      else asked.reject(new Error(reply.error ?? "The board refused"));
    },

    wait(ms) {
      if (outgoing.length > 0) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          sleepers.delete(done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        timer.unref();
        sleepers.add(done);
      });
    },

    wake() {
      for (const done of sleepers) done();
    },
  };
  return channel;
}
