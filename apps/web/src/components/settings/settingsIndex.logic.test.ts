import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUTOMATION_ENTRIES, DYNAMIC_ROW_PREFIXES, settingsIndex, settingsLocation } from "./settingsIndex.logic";
import { SETTINGS_GROUP_IDS } from "./settingsNav.logic";

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const SERVER_AUTOMATIONS = fileURLToPath(new URL("../../../../server/src/autopilot/automations", import.meta.url));

function sourceFiles(dir: string, suffix: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(path, suffix, out);
    else if (entry.name.endsWith(suffix) && !entry.name.endsWith(`.test${suffix}`)) out.push(path);
  }
  return out;
}

// The element ids the settings components give to sub-sections, cards and rows: `id="board.data.backup"` or
// id={`board.notifications.kind-${kind}`}. Only the settings groups' prefixes count.
const GROUPS = SETTINGS_GROUP_IDS.join("|");
const ID_ATTRIBUTE = new RegExp(`\\bid=(?:"((?:${GROUPS})\\.[^"]+)"|\\{\`((?:${GROUPS})\\.[^\`]+)\`\\})`, "g");

function renderedIds() {
  const fixed = new Set<string>();
  const templated = new Set<string>();
  for (const file of sourceFiles(SRC, ".tsx")) {
    for (const match of readFileSync(file, "utf8").matchAll(ID_ATTRIBUTE)) {
      if (match[1]) fixed.add(match[1]);
      // The part before the first `${` is what the rest is built on.
      else if (match[2]) templated.add(match[2].split("${")[0]!);
    }
  }
  return { fixed, templated };
}

const entries = settingsIndex();
const indexed = new Set(entries.map((entry) => entry.id));

describe("settingsIndex", () => {
  const { fixed, templated } = renderedIds();

  it("finds the ids the components render", () => {
    // A guard on the scan itself: a changed attribute style would otherwise pass the checks below by finding nothing.
    expect(fixed.size).toBeGreaterThan(60);
    expect(templated.size).toBeGreaterThan(2);
  });

  it("has an entry for every sub-section, card and row the components render", () => {
    // `<group>.<section>.settings` and `.status` are the card a sub-section's rows sit in, named like the sub-section
    // itself, which its own entry already finds.
    const missing = [...fixed].filter((id) => !indexed.has(id) && !/\.(settings|status)$/.test(id));
    expect(missing).toEqual([]);
  });

  it("has entries for rows built from a template, or lists their prefix as dynamic", () => {
    const missing = [...templated].filter(
      (prefix) => !DYNAMIC_ROW_PREFIXES.includes(prefix) && ![...indexed].some((id) => id.startsWith(prefix)),
    );
    expect(missing).toEqual([]);
  });

  it("has no entry for a row that is not rendered", () => {
    const stale = entries
      .filter((entry) => entry.kind !== "section")
      .filter((entry) => !fixed.has(entry.id) && ![...templated].some((prefix) => entry.id.startsWith(prefix)))
      .map((entry) => entry.id);
    expect(stale).toEqual([]);
  });

  it("gives every entry a unique id, a title and a place in the sidebar", () => {
    expect(indexed.size).toBe(entries.length);
    expect(entries.filter((entry) => entry.title.trim() === "").map((entry) => entry.id)).toEqual([]);
    expect(entries.filter((entry) => !entry.id.startsWith(entry.sectionId)).map((entry) => entry.id)).toEqual([]);
  });

  it("marks the built-in automations as folded sections, and nothing else", () => {
    const folded = entries.filter((entry) => entry.foldedIn !== null);
    expect(folded.map((entry) => entry.id)).toEqual(
      AUTOMATION_ENTRIES.map((automation) => `autopilot.engine.automation-${automation.key}`),
    );
    for (const entry of folded) expect(entry.foldedIn).toBe(entry.id);
  });

  it("indexes Orchestrate's own area as a card, not a folded section", () => {
    expect(entries.find((entry) => entry.id === "autopilot.engine.orchestrate")).toMatchObject({
      title: "Orchestrate",
      kind: "card",
      foldedIn: null,
    });
  });

  it("names the built-in automations as the server does", () => {
    const server = sourceFiles(SERVER_AUTOMATIONS, ".ts")
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const missing = AUTOMATION_ENTRIES.filter(({ title }) => !server.includes(`title: "${title}"`));
    expect(missing.map(({ title }) => title)).toEqual([]);
  });
});

describe("settingsLocation", () => {
  it("names the group and sub-section a setting is in", () => {
    const row = entries.find((entry) => entry.id === "autopilot.engine.quiet-hours")!;
    expect(settingsLocation(row)).toBe("Autopilot");
    const integration = entries.find((entry) => entry.id === "integrations.claude-code.cli-path")!;
    expect(settingsLocation(integration)).toBe("Integrations › Claude Code");
  });

  it("gives a sub-section just its group", () => {
    const section = entries.find((entry) => entry.id === "tasks.review")!;
    expect(settingsLocation(section)).toBe("Tasks");
  });
});
