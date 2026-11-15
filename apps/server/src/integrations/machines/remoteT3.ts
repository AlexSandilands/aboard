import type { T3LaunchOptions, TaskLink } from "@repo/contracts";
import type { Services } from "../../services/types.ts";
import { messageOf, type Logger } from "../util.ts";
import type { T3Integration, TaskThreadLaunch } from "../t3.ts";
import type { MachineSync } from "./sync.ts";
import type { RemoteWork } from "./remoteWork.ts";

// A board's T3 Code, with the threads of tasks a connected machine holds sent to that machine's own T3 Code
// (docs/features/remote-machines.md#t3-code-on-the-machine). Everything that starts, messages or inspects a task's
// thread goes through this, so the dialog, custom hand-offs, Autopilot's nudges and the review loop all reach the
// right machine without knowing there is one.

export function withMachineThreads(
  t3: T3Integration,
  deps: {
    remote: () => Pick<RemoteWork, "t3" | "holder">;
    /** Applies the machine's log now, so a thread it just linked is on the board before the answer goes back. */
    sync: () => Pick<MachineSync, "pump">;
    services: () => Pick<Services, "links" | "attachments">;
    log?: Logger;
  },
): T3Integration {
  const log = deps.log ?? console;

  /** The board's copy of a link the machine made, once its log is applied; the machine's own answer until then. */
  const caughtUp = async (taskId: string, link: TaskLink): Promise<TaskLink> => {
    const machine = deps.remote().holder(taskId);
    if (!machine) return link;
    try {
      await deps.sync().pump(machine.id);
      return deps.services().links.get(link.id);
    } catch (error) {
      log.warn(`[machines] the thread ${machine.name} linked isn't on the board yet: ${messageOf(error)}`);
      return link;
    }
  };

  return {
    ...t3,

    launchOptions(taskId, choice) {
      const there = deps.remote().t3(taskId, { op: "options", taskId, ...(choice ? { choice } : {}) });
      return there ? (there as Promise<T3LaunchOptions>) : t3.launchOptions(taskId, choice);
    },

    async startThread(taskId, input, actor) {
      const there = deps.remote().t3(taskId, { op: "start", taskId, input, actor });
      if (!there) return t3.startThread(taskId, input, actor);
      const link = (await there) as TaskLink;
      // The images are the task's now, here as on the machine (which claimed its copies): backed up and deleted with
      // it, as a launch here does. After the start, so a failure here can't undo a thread that started.
      if (input.attachmentIds?.length) {
        try {
          deps.services().attachments.claimIds(taskId, input.attachmentIds);
        } catch (error) {
          log.warn(`[machines] couldn't give the launch's images to the task: ${messageOf(error)}`);
        }
      }
      return caughtUp(taskId, link);
    },

    async launchTaskThread(taskId, input, actor) {
      const there = deps.remote().t3(taskId, { op: "launch", taskId, input, actor });
      if (!there) return t3.launchTaskThread(taskId, input, actor);
      const launched = (await there) as TaskThreadLaunch;
      return { ...launched, link: await caughtUp(taskId, launched.link) };
    },

    async sendToThread(link, text, commandId) {
      if (!link.ref.machine) return t3.sendToThread(link, text, commandId);
      const there = deps
        .remote()
        .t3(link.taskId, { op: "message", taskId: link.taskId, linkId: link.id, text, commandId });
      if (!there) {
        // Taken back: the thread is still in the machine's T3 Code, which only that machine talks to.
        throw new Error(
          `This thread is in ${link.ref.machine.name}'s T3 Code, and that machine no longer holds the task`,
        );
      }
      await there;
    },

    // The machine's T3 Code knows where the thread works; the board can't say, as for a T3 Code it can't reach.
    threadWorkspace: (link) => (link.ref.machine ? Promise.resolve(null) : t3.threadWorkspace(link)),

    retryPreparation(link, runId, commandId) {
      if (link.ref.machine) {
        return Promise.reject(new Error(`This thread is in ${link.ref.machine.name}'s T3 Code; retry it there`));
      }
      return t3.retryPreparation(link, runId, commandId);
    },
  };
}
