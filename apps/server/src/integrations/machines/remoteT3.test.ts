import type { TaskLink } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import type { T3Integration } from "../t3.ts";
import { withMachineThreads } from "./remoteT3.ts";

const LINK = {
  id: "link-1",
  taskId: "task-1",
  kind: "t3_thread",
  url: "t3code://threads/env-engine/thread-1",
  label: null,
  syncedAt: null,
  createdAt: "",
  ref: { environmentId: "env-engine", threadId: "thread-1", machine: { id: "m-1", name: "engine" } },
  snapshot: null,
} satisfies TaskLink;

/** The board's T3 integration wrapped for a task a machine holds, with what each part was asked recorded. */
function wrapped(opts: { held: boolean; pumpFails?: boolean }) {
  const asked: unknown[] = [];
  const claimed: Array<[string, string[]]> = [];
  const local = {} as T3Integration;
  const t3 = withMachineThreads(local, {
    remote: () => ({
      holder: () => (opts.held ? { id: "m-1", name: "engine" } : null),
      t3: (_taskId, request) => {
        if (!opts.held) return null;
        asked.push(request);
        return Promise.resolve({ ...LINK, id: "machine-copy" });
      },
    }),
    sync: () => ({ pump: () => (opts.pumpFails ? Promise.reject(new Error("down")) : Promise.resolve({} as never)) }),
    services: () =>
      ({
        links: { get: (id: string) => ({ ...LINK, id, label: "board's copy" }) },
        attachments: {
          claimIds: (taskId: string, ids: string[]) => {
            claimed.push([taskId, ids]);
            return [];
          },
        },
      }) as never,
    log: { warn: () => {} },
  });
  return { t3, asked, claimed };
}

const INPUT = {
  prompt: "Go",
  modelSelection: { instanceId: "claudeAgent", model: "m", options: [] },
  runtimeMode: "full-access" as const,
  workspace: { mode: "current" as const },
};

describe("a held task's T3 Code threads, from the board", () => {
  it("start on the machine, claim the dialog's images here, and answer the board's copy of the link", async () => {
    const { t3, asked, claimed } = wrapped({ held: true });
    const link = await t3.startThread("task-1", { ...INPUT, attachmentIds: ["img-1"] }, "user");
    expect(asked).toMatchObject([{ op: "start", taskId: "task-1" }]);
    expect(claimed).toEqual([["task-1", ["img-1"]]]);
    expect(link).toMatchObject({ id: "machine-copy", label: "board's copy" });
  });

  it("answer the machine's link when its log can't be read yet", async () => {
    const { t3 } = wrapped({ held: true, pumpFails: true });
    expect(await t3.startThread("task-1", INPUT, "user")).toMatchObject({ id: "machine-copy", label: null });
  });

  it("send a message for a machine's thread to the machine", async () => {
    const { t3, asked } = wrapped({ held: true });
    await t3.sendToThread(LINK, "Carry on", "cmd-1");
    expect(asked).toEqual([
      { op: "message", taskId: "task-1", linkId: "link-1", text: "Carry on", commandId: "cmd-1" },
    ]);
  });

  it("refuse to message a machine's thread once the task is taken back", async () => {
    const { t3 } = wrapped({ held: false });
    await expect(t3.sendToThread(LINK, "Carry on", "cmd-1")).rejects.toThrow("no longer holds the task");
  });
});
