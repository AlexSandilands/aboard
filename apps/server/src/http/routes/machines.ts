import {
  ConnectMachineInput,
  RepairMachineInput,
  RequestMachineUpdateInput,
  UpdateMachineInput,
  type ConnectMachineResult,
  type MachinesResponse,
} from "@repo/contracts";
import type { Hono } from "hono";
import type { AppContext } from "../../app.ts";
import { handle, idParam, noContent, parseBody } from "../respond.ts";

/**
 * The machines a board is connected to (docs/features/remote-machines.md#connecting-a-machine), for Settings. A
 * board's routes only: a runner connects to no machines. Nothing here returns a pairing code or a token.
 */
export function registerMachinesRoutes(app: Hono, { integrations }: AppContext): void {
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
  app.post(
    "/api/machines/:id/update",
    handle(async (c) =>
      c.json(await machines.requestUpdate(idParam(c), (await parseBody(c, RequestMachineUpdateInput)).now)),
    ),
  );
}
