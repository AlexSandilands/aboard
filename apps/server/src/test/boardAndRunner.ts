import type { IntegrationOverrides } from "../integrations/index.ts";
import type { GitResult } from "../integrations/backup.ts";
import { createTestHarness } from "./harness.ts";

/** The address the board reaches the runner at: a tailnet one, which plain http may go to. */
const RUNNER_URL = "http://100.101.102.103:4318";

export interface PairOptions {
  /** `origin` of each project folder on the board, by its path; a folder not listed has none. */
  remotes?: Record<string, string>;
  /** What the runner's `git clone` does; succeeds without touching the disk unless set. */
  clone?: (url: string, dir: string) => Promise<GitResult>;
  board?: IntegrationOverrides;
  runner?: IntegrationOverrides;
}

/**
 * A board and a runner, each the real app on its own in-memory database, paired and connected. The board's
 * requests to the runner are handed straight to the runner's app; `net.up = false` makes them fail as a machine
 * that can't be reached does. Nothing polls: a test drives each round with `sync()`.
 */
export async function createBoardAndRunner(options: PairOptions = {}) {
  const clock = { now: new Date("2026-01-05T10:00:00.000Z") };
  const net = { up: true, sent: [] as Array<{ path: string; method: string }> };
  const cloned: Array<{ url: string; dir: string }> = [];
  const runner = createTestHarness({
    role: "runner",
    integrations: {
      now: () => clock.now,
      readRemote: () => null,
      runnerHost: {
        clone:
          options.clone ??
          ((url, dir) => {
            cloned.push({ url, dir });
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          }),
      },
      ...options.runner,
    },
  });
  runner.services.settings.update({ machineName: "engine" });

  const fetchFn = (async (input: string, init?: RequestInit) => {
    if (!net.up) throw new TypeError("fetch failed");
    const url = new URL(input);
    net.sent.push({ path: url.pathname, method: init?.method ?? "GET" });
    const { signal: _signal, ...rest } = init ?? {};
    const res = await runner.request(`${url.pathname}${url.search}`, {
      ...rest,
      headers: { ...Object.fromEntries(new Headers(init?.headers)), host: url.host },
    });
    // The link went down while the runner was answering: the answer is lost.
    if (!net.up) throw new TypeError("fetch failed");
    return res;
  }) as typeof fetch;

  const remotes = options.remotes ?? {};
  const board = createTestHarness({
    integrations: {
      now: () => clock.now,
      machines: { fetch: fetchFn },
      runGit: (args, cwd) =>
        Promise.resolve(
          args[0] === "remote" && remotes[cwd]
            ? { code: 0, stdout: `${remotes[cwd]}\n`, stderr: "" }
            : { code: 1, stdout: "", stderr: "no remote" },
        ),
      log: { warn: () => {} },
      ...options.board,
    },
  });
  const { machine } = await board.integrations.machines.connect({
    via: "code",
    url: RUNNER_URL,
    code: runner.services.machineAuth.createPairingCode().code,
  });
  if (!machine) throw new Error("the runner didn't pair");
  await board.integrations.machines.check(machine.id);

  /** One round of the board with the runner: edits out, log in, questions answered. */
  const sync = () => board.integrations.machineSync.pump(machine.id);
  /** Takes the link down or brings it back, telling the board's link to look again. */
  const link = async (up: boolean) => {
    net.up = up;
    // Past the client's memory of who answered, so the next request asks again.
    clock.now = new Date(clock.now.getTime() + 60_000);
    await board.integrations.machines.check(machine.id).catch(() => {});
  };
  const stop = () => {
    board.integrations.machines.stop();
    board.integrations.machineSync.stop();
  };
  return { board, runner, machine, net, clock, cloned, sync, link, stop };
}
