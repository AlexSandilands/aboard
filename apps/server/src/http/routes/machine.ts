import {
  BRAND,
  BridgeReply,
  ChangesQuery,
  HandOverRequest,
  HeldEditRequest,
  MACHINE_CHANGES_PATH,
  MACHINE_DESCRIPTOR_PATH,
  MACHINE_EDITS_PATH,
  MACHINE_REPLIES_PATH,
  MACHINE_REFERENCES_PATH,
  ReferencesUpdate,
  MACHINE_TASKS_PATH,
  MACHINE_PAIR_PATH,
  MACHINE_PROTOCOL_VERSION,
  MACHINE_SESSION_PATH,
  MACHINE_STATUS_PATH,
  MACHINE_UPDATE_PATH,
  MACHINE_ATTACHMENTS_PATH,
  MACHINE_JOBS_PATH,
  MACHINE_SETTINGS_PATH,
  MACHINE_TRANSCRIPT_PATH,
  MAX_ATTACHMENT_BYTES,
  MACHINE_AUTOPILOT_PATH,
  MachineAutopilotConfig,
  MachineJobQuery,
  MachineJobRequest,
  MachineSettingsInput,
  MachineTranscriptRequest,
  PairMachineInput,
  UpdateMachineRequest,
  serverPlatformOf,
  type ChangesResponse,
  type CopiedProject,
  type MachineAutopilotAck,
  type MachineCapability,
  type MachineDescriptor,
  type MachineSession,
  type MachineStatus,
  type PairMachineResult,
} from "@repo/contracts";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { machinePairingOf, peerAddress } from "../guard.ts";
import { AppError } from "../../errors.ts";
import { errorResponse, handle, idParam, noContent, parseBody, parseQuery } from "../respond.ts";

/** How long a status answer waits for the login checks, which start programs and may reach for the network. */
const STATUS_LOGINS_WAIT_MS = 4_000;

const CAPABILITIES: MachineCapability[] = ["pairing", "status", "update", "tasks", "runs", "autopilot"];

/**
 * The machine API (docs/features/remote-machines.md#the-machine-api). Every server says who it is; the rest is a
 * runner's. The guard has already checked the token of everything but the descriptor and the pairing exchange, so a
 * route added here under `/machine/` is behind it without doing anything.
 */
export function registerMachineRoutes(app: Hono, { services, integrations, config, instanceId }: AppContext): void {
  const role = config.role ?? "board";
  const descriptor = (): MachineDescriptor => ({
    id: BRAND.id,
    instanceId,
    name: services.settings.get().machineName,
    version: BRAND.version,
    protocolVersion: MACHINE_PROTOCOL_VERSION,
    role,
    capabilities: role === "runner" ? CAPABILITIES : [],
    paired: services.machineAuth.paired(),
  });

  app.get(
    MACHINE_DESCRIPTOR_PATH,
    handle((c) => c.json(descriptor())),
  );
  if (role !== "runner") return;

  app.post(
    MACHINE_PAIR_PATH,
    handle(async (c) => {
      const { token, tokenId } = services.machineAuth.pair(await parseBody(c, PairMachineInput), peerAddress(c));
      // The one response that carries a token; nothing may keep it.
      c.header("cache-control", "no-store");
      return c.json({ token, tokenId, instanceId } satisfies PairMachineResult);
    }),
  );
  app.get(
    MACHINE_SESSION_PATH,
    handle((c) => {
      const { tokenId, board, pairedAt } = machinePairingOf(c);
      return c.json({
        tokenId,
        board,
        pairedAt,
        machine: descriptor(),
      } satisfies MachineSession);
    }),
  );
  // The board unpairing itself: its token stops working at once.
  app.delete(
    MACHINE_SESSION_PATH,
    handle((c) => {
      services.machineAuth.revoke(machinePairingOf(c).tokenId);
      return noContent(c);
    }),
  );

  const { logins, updater } = integrations.runnerHost;
  // What the board shows of this machine, read every half minute while it is connected.
  app.get(
    MACHINE_STATUS_PATH,
    handle(async (c) =>
      c.json({
        version: BRAND.version,
        platform: serverPlatformOf(process.platform, process.arch) ?? `${process.platform}-${process.arch}`,
        runsInFlight: integrations.runnerHost.workInFlight(),
        // Well inside the board's request timeout: a slow check answers with what was last known.
        logins: await logins.loginsWithin(STATUS_LOGINS_WAIT_MS),
        update: updater.state(),
        selfUpdate: updater.available(),
      } satisfies MachineStatus),
    ),
  );
  // The board asking this runner to move to its version. A runner never updates by itself. The request and its
  // answer keep their shape across protocol versions (UpdateMachineRequest): a board on another one still sends it.
  app.post(
    MACHINE_UPDATE_PATH,
    handle(async (c) => c.json(updater.request(await parseBody(c, UpdateMachineRequest)))),
  );

  // Held tasks (docs/features/remote-machines.md#held-tasks): the board hands a task over, reads what changed, sends
  // its own edits and takes the task back.
  const { bridge, checkouts } = integrations.runnerHost;
  const copies = services.workingCopies;
  copies.onAppended(() => bridge.wake());

  app.post(
    MACHINE_TASKS_PATH,
    handle(async (c) => {
      const request = await parseBody(c, HandOverRequest);
      // The first task of a project brings its repository here, which can take a while.
      const known = copies.projectFor(request.project);
      const project = known ?? copies.adoptProject(request.project, await checkouts.ensure(request.project));
      const position = copies.accept(request, project);
      // A project new here gets the board's Autopilot switches for it now.
      if (!known) services.runnerAutopilot.reapply();
      return c.json(position);
    }),
  );
  // The tasks held ones point at, as the board has them now (a blocker finished there).
  app.put(
    MACHINE_REFERENCES_PATH,
    handle(async (c) => {
      copies.refreshReferences((await parseBody(c, ReferencesUpdate)).references);
      return noContent(c);
    }),
  );
  app.delete(
    `${MACHINE_TASKS_PATH}/:id`,
    handle((c) => c.json(copies.release(idParam(c)))),
  );
  // The board's poll: what it hasn't applied yet, and what this runner asks of it. Held open while there is neither.
  app.get(
    MACHINE_CHANGES_PATH,
    handle(async (c) => {
      const query = parseQuery(c, ChangesQuery);
      if (query.prefix !== undefined) copies.setNumbering(query.prefix, query.counter ?? 0);
      bridge.touch();
      const read = (): ChangesResponse => ({
        ...copies.changes(query.after, query.epoch),
        requests: bridge.take(),
      });
      let changes = read();
      if (changes.entries.length === 0 && changes.requests.length === 0 && query.wait > 0) {
        await bridge.wait(query.wait);
        changes = read();
        bridge.touch();
      }
      return c.json(changes);
    }),
  );
  app.post(
    MACHINE_EDITS_PATH,
    handle(async (c) => {
      // An edit this version can't read (a newer board's) still gets a verdict, with the task's state logged: an
      // error here would leave the board showing an edit the task never took.
      const raw = await parseBody(c, z.looseObject({ id: z.string().min(1), taskId: z.string().min(1) }));
      const edit = HeldEditRequest.safeParse(raw);
      return c.json(
        edit.success
          ? copies.applyEdit(edit.data)
          : copies.refuseEdit(raw.id, raw.taskId, "This machine's version can't apply that edit; update it"),
      );
    }),
  );
  // Work on a held task (docs/features/remote-machines.md#work-on-the-machine): the board starts a run, a command
  // or a script here and reads it until it ends.
  const { jobs, work } = integrations.runnerHost;
  app.post(
    MACHINE_JOBS_PATH,
    handle(async (c) => c.json(work.start(await parseBody(c, MachineJobRequest)))),
  );
  app.get(
    `${MACHINE_JOBS_PATH}/:id`,
    handle(async (c) => {
      const { after, wait } = parseQuery(c, MachineJobQuery);
      return c.json(await jobs.read(idParam(c), after, wait));
    }),
  );
  app.delete(
    `${MACHINE_JOBS_PATH}/:id`,
    handle((c) => {
      jobs.forget(idParam(c));
      return noContent(c);
    }),
  );
  // The board's Autopilot, which this machine runs over the tasks it holds (remote-machines.md#autopilot-on-the-machine).
  const cloning = new Set<string>();
  /** Clones a project a pinned automation runs in, in the background, then gives it its switches. */
  const adoptForAutopilot = async (project: CopiedProject): Promise<void> => {
    if (cloning.has(project.id)) return;
    cloning.add(project.id);
    try {
      if (!copies.projectFor(project)) copies.adoptProject(project, await checkouts.ensure(project));
      services.runnerAutopilot.reapply();
    } catch (error) {
      console.warn(`[machines] couldn't clone ${project.title} for a pinned automation: ${String(error)}`);
    } finally {
      cloning.delete(project.id);
    }
  };
  app.put(
    MACHINE_AUTOPILOT_PATH,
    handle(async (c) => {
      const { revision, missing } = services.runnerAutopilot.apply(await parseBody(c, MachineAutopilotConfig));
      for (const project of missing) void adoptForAutopilot(project);
      return c.json({ revision } satisfies MachineAutopilotAck);
    }),
  );
  // The board's settings this machine works by: which model reviews, how many rounds, whether a move opens one.
  app.put(
    MACHINE_SETTINGS_PATH,
    handle(async (c) => {
      work.applySettings((await parseBody(c, MachineSettingsInput)).settings);
      return noContent(c);
    }),
  );
  // A session that ran here, read where its files are. Found under the harness's own folder by its id, never by a
  // path the request names.
  app.post(
    MACHINE_TRANSCRIPT_PATH,
    handle(async (c) => {
      const { sessionId, cwd, offset } = await parseBody(c, MachineTranscriptRequest);
      return c.json(await integrations.readSessionTranscript({ sessionId, cwd }, offset));
    }),
  );
  // One of a held task's pasted images, so the paths in the board's prompts resolve here.
  app.put(
    `${MACHINE_ATTACHMENTS_PATH}/:id`,
    bodyLimit({
      maxSize: MAX_ATTACHMENT_BYTES,
      onError: (c) => errorResponse(c, new AppError("VALIDATION", "The image is too large")),
    }),
    handle(async (c) => {
      const { taskId, filename } = parseQuery(
        c,
        z.object({ taskId: z.string().min(1), filename: z.string().max(200) }),
      );
      services.attachments.adopt({
        id: idParam(c),
        taskId,
        filename,
        mime: (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase(),
        bytes: new Uint8Array(await c.req.arrayBuffer()),
      });
      return noContent(c);
    }),
  );
  app.post(
    MACHINE_REPLIES_PATH,
    handle(async (c) => {
      bridge.reply(await parseBody(c, BridgeReply));
      return noContent(c);
    }),
  );
}
