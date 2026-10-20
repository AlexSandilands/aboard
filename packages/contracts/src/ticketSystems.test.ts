import { describe, expect, it } from "vitest";
import {
  findTicketKeys,
  ticketHref,
  ticketLabel,
  TICKET_SYSTEM_PRESETS,
  TicketSystem,
  TicketSystems,
  type TicketSystem as TicketSystemType,
} from "./index.ts";

const system = (over: Partial<TicketSystemType> = {}): TicketSystemType => ({
  id: "shop",
  name: "Shop",
  keyPattern: String.raw`SHOP-\d+`,
  autoLink: false,
  importTools: [],
  importInstructions: "",
  ...over,
});

describe("TicketSystem", () => {
  it("accepts the presets", () => {
    for (const preset of TICKET_SYSTEM_PRESETS) expect(TicketSystem.safeParse(preset.system).success).toBe(true);
  });

  it("refuses patterns that don't compile, a URL pattern without a group and a template without {key}", () => {
    expect(TicketSystem.safeParse(system({ keyPattern: "[A-Z" })).success).toBe(false);
    expect(TicketSystem.safeParse(system({ urlPattern: String.raw`^https://x\.test/SHOP-\d+` })).success).toBe(false);
    expect(TicketSystem.safeParse(system({ urlPattern: String.raw`^https://x\.test/(SHOP-\d+)` })).success).toBe(true);
    expect(TicketSystem.safeParse(system({ linkTemplate: "https://x.test/issue" })).success).toBe(false);
    expect(TicketSystem.safeParse(system({ linkTemplate: "javascript:{key}" })).success).toBe(false);
    expect(TicketSystem.safeParse(system({ id: "Shop Tickets" })).success).toBe(false);
    expect(TicketSystem.safeParse(system({ importTools: ["Bash"] })).success).toBe(false);
  });

  it("refuses two systems with one id", () => {
    expect(TicketSystems.safeParse([system(), system({ name: "Other" })]).success).toBe(false);
  });
});

describe("ticketHref and ticketLabel", () => {
  it("fills the key into the template", () => {
    expect(ticketHref(system({ linkTemplate: "https://x.test/browse/{key}" }), "SHOP-7")).toBe(
      "https://x.test/browse/SHOP-7",
    );
    expect(ticketHref(system(), "SHOP-7")).toBeNull();
    expect(ticketHref(null, "SHOP-7")).toBeNull();
  });

  it("names the system, or its id when it is gone", () => {
    expect(ticketLabel([system()], { system: "shop", key: "SHOP-7" })).toBe("Shop SHOP-7");
    expect(ticketLabel([], { system: "shop", key: "SHOP-7" })).toBe("shop SHOP-7");
  });
});

describe("findTicketKeys", () => {
  const jira = TICKET_SYSTEM_PRESETS[0]!.system;

  it("finds keys in order, without duplicates", () => {
    expect(findTicketKeys("CORE-1245 Fix login", [jira])).toEqual([{ system: "jira", key: "CORE-1245" }]);
    expect(
      findTicketKeys("Fix login (CORE-1245, OPS_2-7). See CORE-1245 and AB1-9.", [jira]).map((k) => k.key),
    ).toEqual(["CORE-1245", "OPS_2-7", "AB1-9"]);
    expect(findTicketKeys("Details: https://jira.example.com/browse/ABC-12?focus=1", [jira])).toEqual([
      { system: "jira", key: "ABC-12" },
    ]);
    expect(findTicketKeys(null, [jira])).toEqual([]);
  });

  it("leaves out standards that look like keys, with the Jira preset", () => {
    expect(findTicketKeys("UTF-8, SHA-256, ISO-8601, RFC-9110, CVE-2024-1234, X-Request-Id", [jira])).toEqual([]);
    expect(findTicketKeys("abc-123 and Abc-123", [jira])).toEqual([]);
  });

  it("finds nothing without a configured system", () => {
    expect(findTicketKeys("M0-1 Project skeleton, ABC-123", [])).toEqual([]);
  });

  it("only finds what a system's pattern matches, and not inside longer words", () => {
    expect(findTicketKeys("M0-1, ABC-123, SHOP-9 and xSHOP-1 SHOP-1x SHOP-1-2", [system()])).toEqual([
      { system: "shop", key: "SHOP-9" },
    ]);
  });

  it("gives a key two systems match to the first and keeps text order across systems", () => {
    const shop = system({ keyPattern: String.raw`SHOP-\d+|ABC-\d+` });
    expect(findTicketKeys("ABC-1 then SHOP-2 then OPS-3", [jira, shop])).toEqual([
      { system: "jira", key: "ABC-1" },
      { system: "jira", key: "SHOP-2" },
      { system: "jira", key: "OPS-3" },
    ]);
    expect(findTicketKeys("ABC-1 then SHOP-2 then OPS-3", [shop, jira])).toEqual([
      { system: "shop", key: "ABC-1" },
      { system: "shop", key: "SHOP-2" },
      { system: "jira", key: "OPS-3" },
    ]);
  });
});
