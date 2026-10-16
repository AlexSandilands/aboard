import type { InboxNotification, NotificationList } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  deliveryTarget,
  describeQuietHours,
  filterByKind,
  isDeliveringTab,
  kindsPresent,
  reduceTabs,
  unreadDescription,
  withCreated,
  type DeliveryContext,
} from "./notifications.logic";

const note = (id: string, patch: Partial<InboxNotification> = {}): InboxNotification => ({
  id,
  kind: "review_finished",
  taskId: "t1",
  title: id,
  body: "",
  createdAt: "2026-10-01T10:00:00.000Z",
  readAt: null,
  ...patch,
});

describe("the cached inbox", () => {
  const list: NotificationList = { items: [note("b"), note("a")], unread: 2 };

  it("puts a new notification on top and takes the server's count", () => {
    expect(withCreated(list, note("c"), 3)).toEqual({ items: [note("c"), note("b"), note("a")], unread: 3 });
  });

  it("doesn't list a notification twice when its event arrives after a refetch", () => {
    expect(withCreated(list, note("b"), 2).items).toHaveLength(2);
  });

  it("keeps the newest hundred", () => {
    const full: NotificationList = { items: Array.from({ length: 100 }, (_, i) => note(`n${i}`)), unread: 100 };
    const next = withCreated(full, note("new"), 101);
    expect(next.items).toHaveLength(100);
    expect(next.items[0]!.id).toBe("new");
    expect(next.unread).toBe(101);
  });
});

describe("filtering", () => {
  const items = [note("a", { kind: "thread_waiting" }), note("b"), note("c", { kind: "thread_waiting" })];

  it("narrows to one kind, or shows all", () => {
    expect(filterByKind(items, "thread_waiting").map((n) => n.id)).toEqual(["a", "c"]);
    expect(filterByKind(items, null)).toHaveLength(3);
    expect(filterByKind(items, "autopilot_failed")).toEqual([]);
  });

  it("lists the kinds that are there", () => {
    expect(kindsPresent(items).sort()).toEqual(["review_finished", "thread_waiting"]);
  });
});

describe("unreadDescription", () => {
  it("pluralises", () => {
    expect(unreadDescription(1)).toBe("1 unread notification");
    expect(unreadDescription(12)).toBe("12 unread notifications");
  });
});

describe("deliveryTarget", () => {
  const base: DeliveryContext = {
    popup: true,
    desktop: false,
    focused: false,
    deliveringTab: true,
    permission: "granted",
  };

  it("pops up in the desktop app whatever the browser permission", () => {
    expect(deliveryTarget({ ...base, desktop: true, permission: "default" })).toBe("desktop");
    expect(deliveryTarget({ ...base, desktop: true, deliveringTab: false })).toBe("desktop");
  });

  it("uses the Notification API in one permitted tab", () => {
    expect(deliveryTarget(base)).toBe("browser");
    expect(deliveryTarget({ ...base, deliveringTab: false })).toBeNull();
    expect(deliveryTarget({ ...base, permission: "default" })).toBeNull();
    expect(deliveryTarget({ ...base, permission: "denied" })).toBeNull();
    expect(deliveryTarget({ ...base, permission: "unsupported" })).toBeNull();
  });

  it("stays quiet when the user is looking, or the server says no popup", () => {
    expect(deliveryTarget({ ...base, focused: true })).toBeNull();
    expect(deliveryTarget({ ...base, desktop: true, focused: true })).toBeNull();
    expect(deliveryTarget({ ...base, popup: false })).toBeNull();
    expect(deliveryTarget({ ...base, desktop: true, popup: false })).toBeNull();
  });
});

describe("the delivering tab", () => {
  it("is the one used last", () => {
    let state = { current: null as string | null };
    state = reduceTabs(state, { type: "focus", tab: "a" });
    state = reduceTabs(state, { type: "focus", tab: "b" });
    expect(isDeliveringTab(state, "b", false)).toBe(true);
    expect(isDeliveringTab(state, "a", true)).toBe(false);
  });

  it("falls to the lock holder while no tab has been used", () => {
    const state = { current: null };
    expect(isDeliveringTab(state, "a", true)).toBe(true);
    expect(isDeliveringTab(state, "b", false)).toBe(false);
  });

  it("takes an answer to hello only when it knows of no one", () => {
    expect(reduceTabs({ current: null }, { type: "current", tab: "a" })).toEqual({ current: "a" });
    expect(reduceTabs({ current: "b" }, { type: "current", tab: "a" })).toEqual({ current: "b" });
    expect(reduceTabs({ current: "b" }, { type: "hello", tab: "a" })).toEqual({ current: "b" });
  });

  it("lets go when the delivering tab closes", () => {
    expect(reduceTabs({ current: "a" }, { type: "bye", tab: "a" })).toEqual({ current: null });
    expect(reduceTabs({ current: "a" }, { type: "bye", tab: "b" })).toEqual({ current: "a" });
  });
});

describe("describeQuietHours", () => {
  it("names the window while it is on", () => {
    expect(describeQuietHours({ enabled: true, start: "22:00", end: "07:00" })).toContain("22:00 to 07:00");
  });

  it("says so when there is no window", () => {
    expect(describeQuietHours({ enabled: false, start: "22:00", end: "07:00" })).toContain("off");
    expect(describeQuietHours({ enabled: true, start: "08:00", end: "08:00" })).toContain("off");
  });
});
