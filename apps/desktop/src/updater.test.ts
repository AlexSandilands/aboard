import { EventEmitter } from "node:events";
import type { DesktopUpdateState } from "@repo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialUpdateState } from "./shell.logic.ts";

/** Stands in for electron-updater's NsisUpdater / AppImageUpdater: tests drive it by emitting its events. */
class FakeEngine extends EventEmitter {
  static last: FakeEngine | null = null;
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  logger: unknown = null;
  checks = 0;
  /** What quitAndInstall does: nothing (the app quits), or report a failure the way install() does. */
  installFails: Error | null = null;
  installed = false;
  constructor() {
    super();
    FakeEngine.last = this;
  }
  async checkForUpdates() {
    this.checks++;
  }
  quitAndInstall() {
    if (this.installFails) this.emit("error", this.installFails);
    else this.installed = true;
  }
}

vi.mock("electron-updater", () => ({ default: { NsisUpdater: FakeEngine, AppImageUpdater: FakeEngine } }));

const { Updater } = await import("./updater.ts");

const repo = { owner: "acme", repo: "board" };
const selfUpdate = initialUpdateState({ mode: "self-update", reason: null }, "1.4.2", true, null);
const noticeOnly = initialUpdateState({ mode: "notice-only", reason: null }, "1.4.2", true, "download");

function make(initial: DesktopUpdateState, fetch: typeof globalThis.fetch = vi.fn<typeof globalThis.fetch>()) {
  const changes: DesktopUpdateState[] = [];
  const updater = new Updater({ initial, repo, fetch, onChange: (s) => changes.push(s), noticeFeed: null });
  return { updater, changes };
}

const feed = (body: string, status = 200) => vi.fn<typeof globalThis.fetch>(async () => new Response(body, { status }));

beforeEach(() => {
  FakeEngine.last = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Updater, self-update", () => {
  it("sets the engine up to download by itself and never install on quit", () => {
    make(selfUpdate);
    expect(FakeEngine.last).toMatchObject({
      autoDownload: true,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      allowDowngrade: false,
    });
  });

  it("follows the engine's events to ready", () => {
    const { updater } = make(selfUpdate);
    const engine = FakeEngine.last!;
    engine.emit("checking-for-update");
    engine.emit("update-available", { version: "1.5.0" });
    engine.emit("download-progress", { percent: 55.5 });
    expect(updater.state).toMatchObject({ status: "downloading", percent: 55 });
    engine.emit("update-downloaded", { version: "1.5.0" });
    expect(updater.state).toMatchObject({ status: "ready", version: "1.5.0" });
  });

  it("reports a missing feed quietly", () => {
    const { updater } = make(selfUpdate);
    FakeEngine.last!.emit("error", new Error("HttpError: 404 Not Found"));
    expect(updater.state.status).toBe("error");
    expect(updater.state.error).toMatch(/Couldn't reach GitHub/);
  });

  it("checks after 15 seconds and then hourly, only while auto-check is on", async () => {
    vi.useFakeTimers();
    const { updater } = make(selfUpdate);
    updater.start();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(FakeEngine.last!.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeEngine.last!.checks).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(FakeEngine.last!.checks).toBe(2);
    updater.setAutoCheck(false);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(FakeEngine.last!.checks).toBe(2);
    updater.check(); // Check now still works.
    expect(FakeEngine.last!.checks).toBe(3);
    updater.stop();
  });

  it("doesn't check again once an update is downloading or ready", () => {
    const { updater } = make(selfUpdate);
    FakeEngine.last!.emit("update-available", { version: "1.5.0" });
    updater.check();
    FakeEngine.last!.emit("update-downloaded", { version: "1.5.0" });
    updater.check();
    expect(FakeEngine.last!.checks).toBe(0);
  });

  describe("install", () => {
    function ready() {
      const made = make(selfUpdate);
      FakeEngine.last!.emit("update-downloaded", { version: "1.5.0" });
      return made;
    }

    it("stops the server first, then installs, without recovering", async () => {
      const { updater } = ready();
      const order: string[] = [];
      const prepare = vi.fn<() => Promise<void>>(async () => {
        order.push("prepare");
        expect(updater.state.status).toBe("installing");
      });
      const recover = vi.fn<() => Promise<void>>(async () => {});
      await updater.install(prepare, recover);
      expect(order).toEqual(["prepare"]);
      expect(FakeEngine.last!.installed).toBe(true);
      expect(recover).not.toHaveBeenCalled();
    });

    it("brings the server back and keeps the update ready when the installer can't start", async () => {
      const { updater } = ready();
      FakeEngine.last!.installFails = new Error("spawn EACCES");
      const recover = vi.fn<() => Promise<void>>(async () => {});
      await updater.install(async () => {}, recover);
      expect(recover).toHaveBeenCalledOnce();
      expect(updater.state).toMatchObject({ status: "ready", error: "spawn EACCES" });
    });

    it("recovers when stopping the server fails, and never installs", async () => {
      const { updater } = ready();
      const recover = vi.fn<() => Promise<void>>(async () => {});
      await updater.install(async () => {
        throw new Error("server did not stop");
      }, recover);
      expect(FakeEngine.last!.installed).toBe(false);
      expect(recover).toHaveBeenCalledOnce();
      expect(updater.state).toMatchObject({ status: "ready", error: "server did not stop" });
    });

    it("does nothing unless an update is ready", async () => {
      const { updater } = make(selfUpdate);
      const prepare = vi.fn<() => Promise<void>>(async () => {});
      await updater.install(prepare, async () => {});
      expect(prepare).not.toHaveBeenCalled();
    });
  });
});

describe("Updater, notice-only", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("builds no engine and reports a newer version from the feed", async () => {
    const fetch = feed("version: 1.5.0\nfiles: []\n");
    const { updater } = make(noticeOnly, fetch);
    expect(FakeEngine.last).toBeNull();
    updater.check();
    await settle();
    expect(fetch).toHaveBeenCalledWith(
      "https://github.com/acme/board/releases/latest/download/latest-linux.yml",
      expect.anything(),
    );
    expect(updater.state).toMatchObject({ status: "available", version: "1.5.0" });
  });

  it("is up to date when the feed has the running version", async () => {
    const { updater } = make(noticeOnly, feed("version: 1.4.2\n"));
    updater.check();
    await settle();
    expect(updater.state.status).toBe("up-to-date");
  });

  it("reads the feed app-update.yml names", async () => {
    const fetch = feed("version: 1.4.2\n");
    const updater = new Updater({
      initial: noticeOnly,
      repo,
      fetch,
      onChange: () => {},
      noticeFeed: "http://127.0.0.1:1/latest-linux.yml",
    });
    updater.check();
    await settle();
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:1/latest-linux.yml", expect.anything());
  });

  it("reports a 404, a network failure and a feed without a version as errors", async () => {
    for (const fetch of [
      feed("Not Found", 404),
      vi.fn<typeof globalThis.fetch>(async () => {
        throw new TypeError("fetch failed");
      }),
      feed("files: []\n"),
    ]) {
      const { updater } = make(noticeOnly, fetch);
      updater.check();
      await settle();
      expect(updater.state.status).toBe("error");
    }
  });

  it("runs one check at a time", async () => {
    const fetch = feed("version: 1.4.2\n");
    const { updater } = make(noticeOnly, fetch);
    updater.check();
    updater.check();
    await settle();
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("Updater, disabled", () => {
  it("never checks, starts no timers and builds no engine", () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { updater } = make(
      initialUpdateState({ mode: "disabled", reason: "dev builds" }, "0.0.0", true, null),
      fetch,
    );
    updater.start();
    updater.check();
    vi.advanceTimersByTime(2 * 60 * 60_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(FakeEngine.last).toBeNull();
  });

  it("turns itself off without a GitHub repo", () => {
    const updater = new Updater({
      initial: selfUpdate,
      repo: null,
      fetch: vi.fn<typeof globalThis.fetch>(),
      onChange: () => {},
    });
    expect(updater.state).toMatchObject({ mode: "disabled" });
    expect(FakeEngine.last).toBeNull();
  });
});
