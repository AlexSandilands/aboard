import { describe, expect, it } from "vitest";
import { CHANGE_LOG_FORMAT_FIXTURES } from "./fixtures/changeLogFormats.ts";
import {
  CHANGE_LOG_FORMAT,
  CHANGE_LOG_UPGRADERS,
  ChangeLogFormatError,
  StoredChangeLogEntry,
  readChangeLogEntry,
} from "./workingCopies.ts";

// The rule (docs/features/remote-machines.md#the-logs-format): a board reads every format a runner ever wrote.
// `fixtures/changeLogFormats.ts` holds entries exactly as each format stored them, one of each kind.

const fixtures = new Map(
  Object.entries(CHANGE_LOG_FORMAT_FIXTURES).map(
    ([format, entries]) => [Number(format), StoredChangeLogEntry.array().parse(entries)] as const,
  ),
);

describe("the change log's format", () => {
  it("has a fixture for every format up to the current one", () => {
    const formats = Array.from({ length: CHANGE_LOG_FORMAT }, (_, i) => i + 1);
    expect([...fixtures.keys()].toSorted((a, b) => a - b)).toEqual(formats);
    for (const [format, entries] of fixtures) {
      expect(entries.every((e) => e.version === format)).toBe(true);
      expect(new Set(entries.map((e) => e.kind))).toEqual(new Set(["state", "created", "released"]));
    }
  });

  it("has a step from every older format to the next", () => {
    const steps = Array.from({ length: CHANGE_LOG_FORMAT - 1 }, (_, i) => i + 1);
    expect(Object.keys(CHANGE_LOG_UPGRADERS).map(Number)).toEqual(steps);
  });

  it("reads every entry of every older format as the current one", () => {
    for (const entries of fixtures.values()) {
      for (const stored of entries) {
        const entry = readChangeLogEntry(stored);
        expect(entry).toMatchObject({ id: stored.id, kind: stored.kind, taskId: stored.taskId, at: stored.at });
        expect(entry.payload.state.task.title).toEqual(expect.any(String));
      }
    }
    const made = readChangeLogEntry(fixtures.get(1)![1]!);
    expect(made.kind === "created" && made.payload.identity).toMatchObject({ numberPrefix: "E", number: 7 });
  });

  it("ignores what a newer writer of the same format added", () => {
    const stored = fixtures.get(CHANGE_LOG_FORMAT)![0]!;
    const withMore = { ...stored, payload: { ...(stored.payload as Record<string, unknown>), somethingNew: true } };
    expect(readChangeLogEntry(withMore)).toEqual(readChangeLogEntry(stored));
  });

  it("refuses a format newer than it knows, and an entry it can't read, by name", () => {
    const stored = fixtures.get(CHANGE_LOG_FORMAT)![0]!;
    expect(() => readChangeLogEntry({ ...stored, version: CHANGE_LOG_FORMAT + 1 })).toThrow(ChangeLogFormatError);
    expect(() => readChangeLogEntry({ ...stored, version: CHANGE_LOG_FORMAT + 1 })).toThrow(
      `Log entry ${stored.id} is in format ${CHANGE_LOG_FORMAT + 1}; this version reads up to ${CHANGE_LOG_FORMAT}`,
    );
    expect(() => readChangeLogEntry({ ...stored, payload: { state: null } })).toThrow(ChangeLogFormatError);
    expect(() => readChangeLogEntry({ ...stored, kind: "unheard-of" })).toThrow(ChangeLogFormatError);
  });
});
