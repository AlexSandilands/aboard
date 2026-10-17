import type { Digest } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  digestButtonText,
  digestFacts,
  digestModeLabel,
  digestOptionLabel,
  formatDigestInstant,
  formatDigestPeriod,
  neighbourDigest,
  pickDigest,
  taskIdsByNumber,
} from "./digest.logic";

// Built from local parts, so the expected text holds in whatever zone the tests run in.
const local = (month: number, day: number, hour: number, minute = 0) =>
  new Date(2026, month - 1, day, hour, minute).toISOString();

const digest = (id: string, patch: Partial<Digest> = {}): Digest => ({
  id,
  createdAt: local(10, 18, 9),
  from: local(10, 17, 9),
  to: local(10, 18, 9),
  mode: "plain",
  trigger: "schedule",
  bodyMd: "",
  costUsd: null,
  note: null,
  readAt: null,
  ...patch,
});

describe("formatDigestPeriod", () => {
  it("shows both ends in local time, 24-hour, with the weekday", () => {
    expect(formatDigestInstant(local(10, 17, 9, 5))).toBe("Sat 17 Oct 09:05");
    expect(formatDigestPeriod({ from: local(10, 17, 9), to: local(10, 18, 17, 30) })).toBe(
      "Sat 17 Oct 09:00 to Sun 18 Oct 17:30",
    );
  });

  it("writes midnight as 00:00 and shortens September to Sep", () => {
    expect(formatDigestInstant(local(9, 1, 0))).toBe("Tue 1 Sep 00:00");
  });

  it("is empty for something that isn't a date", () => {
    expect(formatDigestInstant("soon")).toBe("");
  });
});

describe("digest labels", () => {
  it("names the mode", () => {
    expect(digestModeLabel("plain")).toBe("Plain");
    expect(digestModeLabel("summarised")).toBe("Summarised");
  });

  it("lists how it was made, with the cost only when there is one", () => {
    expect(digestFacts({ trigger: "schedule", costUsd: null })).toEqual(["Made on a schedule"]);
    expect(digestFacts({ trigger: "manual", costUsd: 0.4 })).toEqual(["Made on request", "$0.40"]);
  });

  it("marks an unread digest in the picker", () => {
    expect(digestOptionLabel({ to: local(10, 18, 9), readAt: null })).toBe("Sun 18 Oct 09:00 · unread");
    expect(digestOptionLabel({ to: local(10, 18, 9), readAt: local(10, 18, 10) })).toBe("Sun 18 Oct 09:00");
  });

  it("describes the header button for a screen reader", () => {
    expect(digestButtonText(0, false)).toBe("Digest of what changed");
    expect(digestButtonText(2, false)).toBe("Digest of what changed, 2 unread");
    expect(digestButtonText(0, true)).toBe("Digest of what changed, being written");
    expect(digestButtonText(1, true)).toBe("Digest of what changed, being written, 1 unread");
  });
});

describe("browsing digests", () => {
  const items = [digest("c"), digest("b"), digest("a")];

  it("shows the picked digest, else the newest", () => {
    expect(pickDigest(items, "b")?.id).toBe("b");
    expect(pickDigest(items, null)?.id).toBe("c");
    expect(pickDigest(items, "gone")?.id).toBe("c");
    expect(pickDigest([], null)).toBeUndefined();
  });

  it("steps to the neighbours, and stops at either end", () => {
    expect(neighbourDigest(items, "b", "older")).toBe("a");
    expect(neighbourDigest(items, "b", "newer")).toBe("c");
    expect(neighbourDigest(items, "a", "older")).toBeNull();
    expect(neighbourDigest(items, "c", "newer")).toBeNull();
    expect(neighbourDigest(items, undefined, "older")).toBeNull();
  });
});

describe("taskIdsByNumber", () => {
  it("maps a task number to its id", () => {
    const ids = taskIdsByNumber([
      { id: "t1", number: 1 },
      { id: "t42", number: 42 },
    ]);
    expect(ids.get(42)).toBe("t42");
    expect(ids.get(7)).toBeUndefined();
  });
});
