import { describe, expect, it } from "vitest";
import {
  compareTaskNumbers,
  parseTaskNumberRef,
  storedTaskNumber,
  taskLabel,
  taskNumberText,
  taskNumberValue,
} from "./taskNumbers.ts";

describe("task numbers", () => {
  it("show a machine's prefix where a task has one", () => {
    expect(taskLabel({ number: 42 })).toBe("#42");
    expect(taskLabel({ number: 42, numberPrefix: "" })).toBe("#42");
    expect(taskLabel({ number: 7, numberPrefix: "E" })).toBe("#E7");
    expect(taskNumberText({ number: 7, numberPrefix: "E" })).toBe("E7");
  });

  it("are stored in activity as the number, or as text for a prefixed one", () => {
    expect(taskNumberValue({ number: 42, numberPrefix: "" })).toBe(42);
    expect(taskNumberValue({ number: 7, numberPrefix: "E" })).toBe("E7");
    expect(storedTaskNumber(42)).toBe("42");
    expect(storedTaskNumber("E7")).toBe("E7");
    expect(storedTaskNumber("seven")).toBeNull();
    expect(storedTaskNumber(null)).toBeNull();
  });

  it("are read from #42, 42, #E7 and e7 alike", () => {
    expect(parseTaskNumberRef("#42")).toEqual([{ prefix: "", number: 42 }]);
    expect(parseTaskNumberRef(" 42 ")).toEqual([{ prefix: "", number: 42 }]);
    expect(parseTaskNumberRef("#E7")).toEqual([{ prefix: "E", number: 7 }]);
    expect(parseTaskNumberRef("e7")).toEqual([{ prefix: "E", number: 7 }]);
    expect(parseTaskNumberRef("5b0c7f0e-6a57-4c6f-9d0b-3f0c3a1a2f01")).toEqual([]);
    expect(parseTaskNumberRef("#")).toEqual([]);
    expect(parseTaskNumberRef("ABCD1")).toEqual([]);
  });

  it("offer each reading of a prefix that may hold digits, shortest first", () => {
    expect(parseTaskNumberRef("#E27")).toEqual([
      { prefix: "E", number: 27 },
      { prefix: "E2", number: 7 },
    ]);
    expect(parseTaskNumberRef("#E2")).toEqual([{ prefix: "E", number: 2 }]);
    expect(parseTaskNumberRef("#EN345")).toEqual([
      { prefix: "EN", number: 345 },
      { prefix: "EN3", number: 45 },
    ]);
  });

  it("sort the board's own first, then each prefix's, by number", () => {
    const tasks = [
      { number: 10, numberPrefix: "E" },
      { number: 12 },
      { number: 2, numberPrefix: "E" },
      { number: 3, numberPrefix: "" },
    ];
    expect(tasks.toSorted(compareTaskNumbers).map(taskLabel)).toEqual(["#3", "#12", "#E2", "#E10"]);
  });
});
