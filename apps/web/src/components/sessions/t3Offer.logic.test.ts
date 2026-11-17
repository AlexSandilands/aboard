import type { Machine, TaskHold } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { t3OfferAction } from "./t3Offer.logic";

const hold: TaskHold = { machineId: "m1", machineName: "engine", since: "2026-11-17T10:00:00.000Z", waiting: 0 };
const offer = { t3: "offer", machineId: "m1" };
const engine = (state: NonNullable<Machine["t3"]>["state"] | null) => ({
  id: "m1",
  name: "engine",
  t3: state ? { state, detail: null } : null,
});

describe("what a session error on a machine offers", () => {
  it("starts a thread there when the machine's T3 Code is connected", () => {
    expect(t3OfferAction(offer, hold, engine("connected"))).toEqual({
      kind: "start",
      label: "Start a T3 Code thread there",
      machineId: "m1",
    });
  });

  it("connects it first otherwise, read-only included", () => {
    for (const state of ["read-only", "not-connected", "not-running", "error", null] as const) {
      expect(t3OfferAction(offer, hold, engine(state))).toEqual({
        kind: "connect",
        label: "Connect T3 Code on engine",
        machineId: "m1",
      });
    }
    // The machines weren't read: named from the hold.
    expect(t3OfferAction(offer, hold, null)?.label).toBe("Connect T3 Code on engine");
  });

  it("offers nothing once the machine no longer holds the task", () => {
    expect(t3OfferAction(offer, null, engine("connected"))).toBeNull();
    expect(t3OfferAction(offer, { ...hold, machineId: "m2" }, engine("connected"))).toBeNull();
  });

  it("offers nothing for an error that doesn't name a machine", () => {
    expect(t3OfferAction(null, hold, engine("connected"))).toBeNull();
    expect(t3OfferAction({ t3: "offer" }, hold, engine("connected"))).toBeNull();
    expect(t3OfferAction({ t3: "unreachable" }, hold, engine("connected"))).toBeNull();
  });
});
