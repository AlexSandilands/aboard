import {
  ConnectMachineInput,
  ConnectMachineT3Input,
  type ConnectMachineT3Response,
  HOSTED_RUNNER_PAIRING_PATH,
  HOSTED_RUNNER_PATH,
  UpdateHostedRunnerInput,
  type HostedRunnerPairingCode,
  type HostedRunnerStatus,
  RepairMachineInput,
  RequestMachineUpdateInput,
  UpdateMachineInput,
  type ConnectMachineResult,
  type MachinesResponse,
} from "@repo/contracts";
import type { Hono } from "hono";
import type { AppContext } from "../../app.ts";
import type { HostedRunner } from "../../hostedRunner.ts";
import { handle, idParam, noContent, parseBody } from "../respond.ts";

/**
 * The machines a board is connected to (docs/features/remote-machines.md#connecting-a-machine), for Settings. A
 * board's routes only: a runner connects to no machines. Nothing here returns a pairing code or a token.
 */
export function registerMachinesRoutes(app: Hono, { integrations, hostedRunner }: AppContext): void {
  if (hostedRunner) registerHostedRunnerRoutes(app, hostedRunner);
  const { machines } = integrations;
  app.get(
    "/api/machines",
    handle((c) => c.json(machines.list() satisfies MachinesResponse)),
  );
  // `via: "code"` answers with the machine; `via: "ssh"` with an install, which then shows in the list until dismissed.
  app.post(
    "/api/machines",
    handle(async (c) =>
      c.json((await machines.connect(await parseBody(c, ConnectMachineInput))) satisfies ConnectMachineResult, 201),
    ),
  );
  app.delete(
    "/api/machines/installs/:id",
    handle((c) => {
      machines.dismissInstall(idParam(c));
      return noContent(c);
    }),
  );
  app.patch(
    "/api/machines/:id",
    handle(async (c) => c.json(machines.update(idParam(c), await parseBody(c, UpdateMachineInput)))),
  );
  app.delete(
    "/api/machines/:id",
    handle(async (c) => {
      await machines.remove(idParam(c));
      return noContent(c);
    }),
  );
  // Tries every route now, whatever their waits.
  app.post(
    "/api/machines/:id/check",
    handle(async (c) => c.json(await machines.check(idParam(c)))),
  );
  app.post(
    "/api/machines/:id/pair",
    handle(async (c) => c.json(await machines.repair(idParam(c), (await parseBody(c, RepairMachineInput)).code))),
  );
  // Connects the machine's own T3 Code; the pairing link or token is passed on to it, never kept or returned here.
  app.post(
    "/api/machines/:id/t3/connect",
    handle(async (c) => {
      const { value } = await parseBody(c, ConnectMachineT3Input);
      return c.json((await machines.connectT3(idParam(c), value)) satisfies ConnectMachineT3Response);
    }),
  );
  app.post(
    "/api/machines/:id/update",
    handle(async (c) =>
      c.json(await machines.requestUpdate(idParam(c), (await parseBody(c, RequestMachineUpdateInput)).now)),
    ),
  );
}

/**
 * This board's own runner, for another board (docs/features/remote-machines.md#a-board-that-is-also-a-runner).
 * Making a pairing code here is what `<id>-server pair` is on a runner: a local request, which ADR 0003 already
 * trusts as the user, and the code goes only to this machine's Settings.
 */
function registerHostedRunnerRoutes(app: Hono, hosted: HostedRunner): void {
  app.get(
    HOSTED_RUNNER_PATH,
    handle((c) => c.json(hosted.status() satisfies HostedRunnerStatus)),
  );
  app.patch(
    HOSTED_RUNNER_PATH,
    handle(async (c) =>
      c.json((await hosted.configure(await parseBody(c, UpdateHostedRunnerInput))) satisfies HostedRunnerStatus),
    ),
  );
  app.post(
    HOSTED_RUNNER_PAIRING_PATH,
    handle((c) => {
      c.header("cache-control", "no-store");
      return c.json(hosted.pairingCode() satisfies HostedRunnerPairingCode);
    }),
  );
  // Unpairs the board it works for; the tasks it holds stay in its data dir until that board, paired again, takes them.
  app.delete(
    HOSTED_RUNNER_PAIRING_PATH,
    handle((c) => c.json(hosted.unpair() satisfies HostedRunnerStatus)),
  );
}
