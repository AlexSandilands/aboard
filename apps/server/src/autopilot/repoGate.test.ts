import { describe, expect, it } from "vitest";
import type { GitResult } from "../integrations/backup.ts";
import { createRepoGate, gateFetches } from "./repoGate.ts";

/** A promise to settle by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createRepoGate", () => {
  it("lets one holder of a repository in at a time, in the order they asked", async () => {
    const gate = createRepoGate();
    const log: string[] = [];
    const first = deferred();
    const second = deferred();
    const a = gate.run("C:\\Code\\repo", async () => {
      log.push("a in");
      await first.promise;
      log.push("a out");
    });
    // Another spelling of the same folder shares the gate.
    const b = gate.run("c:/code/repo/", async () => {
      log.push("b in");
      await second.promise;
      log.push("b out");
    });
    const c = gate.run("C:/Code/repo", async () => {
      log.push("c in");
      return 3;
    });
    await tick();
    expect(log).toEqual(["a in"]);
    first.resolve();
    await tick();
    expect(log).toEqual(["a in", "a out", "b in"]);
    second.resolve();
    await Promise.all([a, b]);
    expect(await c).toBe(3);
    expect(log).toEqual(["a in", "a out", "b in", "b out", "c in"]);
  });

  it("doesn't make other repositories wait", async () => {
    const gate = createRepoGate();
    const held = deferred();
    const a = gate.run("/repo/one", () => held.promise);
    expect(await gate.run("/repo/two", async () => "two")).toBe("two");
    held.resolve();
    await a;
  });

  it("releases the gate when a holder throws, and passes the error on", async () => {
    const gate = createRepoGate();
    const failing = gate.run("/repo", async () => {
      throw new Error("boom");
    });
    const next = gate.run("/repo", async () => "next");
    await expect(failing).rejects.toThrow("boom");
    expect(await next).toBe("next");
  });
});

describe("gateFetches", () => {
  it("queues fetches in one folder and lets other git commands through", async () => {
    const gate = createRepoGate();
    const held = deferred();
    const calls: string[] = [];
    const ok: GitResult = { code: 0, stdout: "", stderr: "" };
    const runGit = gateFetches(async (args) => {
      calls.push(args.join(" "));
      return ok;
    }, gate);
    const holder = gate.run("/repo", () => held.promise);
    const fetch = runGit(["fetch", "--quiet", "origin"], "/repo");
    await runGit(["rev-parse", "HEAD"], "/repo");
    await tick();
    expect(calls).toEqual(["rev-parse HEAD"]);
    held.resolve();
    await holder;
    await fetch;
    expect(calls).toEqual(["rev-parse HEAD", "fetch --quiet origin"]);
  });
});
