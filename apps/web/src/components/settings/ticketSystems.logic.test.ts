import { TICKET_SYSTEM_PRESETS, type TicketSystem } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  addTicketSystem,
  newTicketSystemId,
  removeTicketSystem,
  ticketSystemsDot,
  updateTicketSystem,
} from "./ticketSystems.logic";

const jiraPreset = TICKET_SYSTEM_PRESETS.find((p) => p.system.id === "jira")!;

describe("ticket systems settings", () => {
  it("adds a preset or a blank system with an id and name no other system has", () => {
    const one = addTicketSystem([], jiraPreset);
    expect(one).toMatchObject([{ id: "jira", name: "Jira", keyPattern: jiraPreset.system.keyPattern }]);
    const two = addTicketSystem(one, jiraPreset);
    expect(two.map((s) => [s.id, s.name])).toEqual([
      ["jira", "Jira"],
      ["jira-2", "Jira 2"],
    ]);
    expect(addTicketSystem(two, null).at(-1)).toEqual({
      id: "tickets",
      name: "Tickets",
      autoLink: false,
      importTools: [],
      importInstructions: "",
    });
  });

  it("makes ids from names", () => {
    expect(newTicketSystemId("Shop Tracker!", [])).toBe("shop-tracker");
    expect(newTicketSystemId("???", [])).toBe("tickets");
    expect(newTicketSystemId("Shop", [{ id: "shop" } as TicketSystem])).toBe("shop-2");
  });

  it("validates a change before it is saved, and leaves blank fields out", () => {
    const systems = addTicketSystem([], jiraPreset);
    expect(updateTicketSystem(systems, "jira", { keyPattern: "[A-Z" })).toEqual({
      error: "Not a valid regular expression",
    });
    expect(updateTicketSystem(systems, "jira", { linkTemplate: "https://x.test/browse" })).toMatchObject({
      error: expect.stringContaining("{key}"),
    });
    const cleared = updateTicketSystem(systems, "jira", { urlPattern: " ", name: "Work" });
    expect(cleared).toMatchObject({ systems: [{ id: "jira", name: "Work" }] });
    expect("systems" in cleared && cleared.systems[0]).not.toHaveProperty("urlPattern");
  });

  it("removes a system and says how many there are", () => {
    const systems = addTicketSystem([], jiraPreset);
    expect(ticketSystemsDot(systems)).toEqual({ tone: "success", label: "1 system" });
    expect(removeTicketSystem(systems, "jira")).toEqual([]);
    expect(ticketSystemsDot([]).tone).toBe("muted");
  });
});
