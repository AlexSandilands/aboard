import { randomUUID } from "node:crypto";
import type { MachineRoute } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { createTestHarness } from "../test/harness.ts";

const routes: MachineRoute[] = [{ kind: "ssh", target: "engine", port: null, remotePort: 4318 }];

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
};

describe("machines", () => {
  it("adds a machine with a prefix suggested from its name, unique among machines", () => {
    const { services } = createTestHarness();
    const engine = services.machines.add({ instanceId: randomUUID(), name: "engine", routes });
    expect(engine).toMatchObject({ name: "engine", prefix: "E", prefixFixed: false, routes, version: null });
    const second = services.machines.add({ instanceId: randomUUID(), name: "Edge box", routes });
    expect(second.prefix).toBe("ED");
    expect(services.machines.list().map((m) => m.name)).toEqual(["engine", "Edge box"]);
  });

  it("refuses a machine already connected and a prefix in use", () => {
    const { services } = createTestHarness();
    const instanceId = randomUUID();
    services.machines.add({ instanceId, name: "engine", routes });
    expect(codeOf(() => services.machines.add({ instanceId, name: "again", routes }))).toBe("CONFLICT");
    expect(codeOf(() => services.machines.add({ instanceId: randomUUID(), name: "x", prefix: "e", routes }))).toBe(
      "CONFLICT",
    );
  });

  it("stores no route it couldn't read back", () => {
    const { services } = createTestHarness();
    const bad = [...routes, { kind: "direct", url: "not a url" } as MachineRoute];
    expect(codeOf(() => services.machines.add({ instanceId: randomUUID(), name: "engine", routes: bad }))).toBe(
      "VALIDATION",
    );
    const engine = services.machines.add({ instanceId: randomUUID(), name: "engine", routes });
    expect(codeOf(() => services.machines.update(engine.id, { routes: bad }))).toBe("VALIDATION");
    expect(codeOf(() => services.machines.update(engine.id, { routes: [] }))).toBe("VALIDATION");
    expect(services.machines.get(engine.id).routes).toEqual(routes);
  });

  it("changes the name, prefix and routes until a task carries the prefix", () => {
    const { services } = createTestHarness();
    const engine = services.machines.add({ instanceId: randomUUID(), name: "engine", routes });
    const direct: MachineRoute[] = [{ kind: "direct", url: "http://100.101.102.103:4318" }, ...routes];
    expect(services.machines.update(engine.id, { name: "Engine room", prefix: "ER", routes: direct })).toMatchObject({
      name: "Engine room",
      prefix: "ER",
      routes: direct,
    });
    services.machines.fixPrefix(engine.id);
    expect(codeOf(() => services.machines.update(engine.id, { prefix: "X" }))).toBe("CONFLICT");
    // The same prefix again is not a change.
    expect(services.machines.update(engine.id, { prefix: "ER", name: "engine" }).name).toBe("engine");
  });

  it("keeps what the machine last said, and the logins of its last full answer", () => {
    const { services } = createTestHarness();
    const engine = services.machines.add({ instanceId: randomUUID(), name: "engine", routes });
    const logins = [{ name: "gh" as const, state: "ok" as const, detail: null }];
    services.machines.observe(engine.id, { version: "1.2.0", protocolVersion: 1, platform: "linux-x64", logins });
    const seen = services.machines.observe(engine.id, { version: "1.3.0", protocolVersion: 2 });
    expect(seen).toMatchObject({ version: "1.3.0", protocolVersion: 2, platform: "linux-x64", logins });
    expect(seen?.lastSeenAt).not.toBeNull();
    services.machines.remove(engine.id);
    expect(services.machines.observe(engine.id, { version: "1.3.0", protocolVersion: 2 })).toBeNull();
    expect(codeOf(() => services.machines.get(engine.id))).toBe("NOT_FOUND");
  });
});
