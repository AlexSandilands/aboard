import { BRAND, type DesktopUpdateState, type GitHubRepository } from "@repo/contracts";
import electronUpdater, { type AppUpdater } from "electron-updater";
import {
  describeUpdateError,
  feedVersion,
  isNewerVersion,
  latestFeedUrl,
  reduceUpdate,
  releaseNotesUrl,
  type UpdateEvent,
} from "./shell.logic.ts";

// electron-updater is CommonJS; its classes are on the default export once bundled.
const { AppImageUpdater, NsisUpdater } = electronUpdater;

/** The first check waits for the app to settle; later ones are an hour apart. */
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 60 * 60_000;
const FEED_TIMEOUT_MS = 30_000;

export interface UpdaterOptions {
  initial: DesktopUpdateState;
  /** Where releases live; null (no GitHub `repository`) leaves updates off. */
  repo: GitHubRepository | null;
  /** The feed a notice-only install reads, from `app-update.yml`; defaults to `repo`'s latest release. */
  noticeFeed?: string | null;
  /** Electron's `net.fetch`, so the notice-only check goes through the system proxy like the rest of the app. */
  fetch: typeof globalThis.fetch;
  onChange(state: DesktopUpdateState): void;
}

const log = {
  info: (message: unknown) => console.log(`[${BRAND.id}] updater:`, message),
  warn: (message: unknown) => console.warn(`[${BRAND.id}] updater:`, message),
  error: (message: unknown) => console.error(`[${BRAND.id}] updater:`, message),
};

/**
 * The app's updates: one state, which the tray, Settings and the title-bar pill show. A self-updating install
 * (Windows installer, AppImage) checks GitHub Releases with electron-updater and downloads in the background; nothing
 * installs until `install` is called. A notice-only install reads the latest release's feed and only reports the
 * version. A disabled one does nothing at all, and never touches the network.
 */
export class Updater {
  private current: DesktopUpdateState;
  private readonly engine: AppUpdater | null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private checking: Promise<void> | null = null;

  constructor(private readonly options: UpdaterOptions) {
    this.current = options.initial;
    if (!options.repo) this.current = { ...this.current, mode: "disabled", disabledReason: "builds without a repo" };
    this.engine = this.current.mode === "self-update" ? this.createEngine() : null;
  }

  get state(): DesktopUpdateState {
    return this.current;
  }

  /** Starts the automatic checks: the first shortly after start, then hourly, each only while auto-check is on. */
  start(): void {
    if (this.current.mode === "disabled") return;
    const tick = () => {
      if (this.current.autoCheck) this.check();
    };
    this.timers.push(setTimeout(tick, FIRST_CHECK_MS), setInterval(tick, CHECK_EVERY_MS));
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /** Checks now (Check now, or an automatic check). Does nothing while a check, download or install is under way. */
  check(): void {
    if (this.current.mode === "disabled" || this.checking) return;
    const status = this.current.status;
    if (status === "downloading" || status === "ready" || status === "installing") return;
    this.checking = (this.engine ? this.checkSelfUpdate() : this.checkFeed()).finally(() => {
      this.checking = null;
    });
  }

  setAutoCheck(enabled: boolean): void {
    this.apply({ type: "auto-check", enabled });
  }

  /** The release page of the version on offer, or the list of releases. */
  releaseNotesUrl(): string | null {
    return this.options.repo ? releaseNotesUrl(this.options.repo, this.current.version) : null;
  }

  /**
   * Installs the downloaded update and restarts into it. `prepare` stops what must stop first (the server); when the
   * install can't start, `recover` brings it back and the app keeps running, with the error in the state.
   */
  async install(prepare: () => Promise<void>, recover: () => Promise<void>): Promise<void> {
    const engine = this.engine;
    if (!engine || this.current.status !== "ready") return;
    this.apply({ type: "installing" });
    try {
      await prepare();
    } catch (error) {
      this.apply({ type: "install-failed", message: describeUpdateError(error) });
      await recover();
      return;
    }
    // quitAndInstall reports a failure to start the installer only as an `error` event, synchronously.
    let failure: unknown = null;
    const onError = (error: Error) => {
      failure = error;
    };
    engine.on("error", onError);
    try {
      // Silent (no installer UI, no admin prompt for the per-user install), then start the new version.
      engine.quitAndInstall(true, true);
    } catch (error) {
      failure = error;
    } finally {
      engine.off("error", onError);
    }
    if (failure === null) return;
    log.error(failure);
    this.apply({ type: "install-failed", message: describeUpdateError(failure) });
    await recover();
  }

  private apply(event: UpdateEvent): void {
    const next = reduceUpdate(this.current, event);
    if (next === this.current || JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.options.onChange(next);
  }

  private createEngine(): AppUpdater {
    // Built explicitly rather than through `autoUpdater`, which on Linux would pick the .deb/.rpm/pacman updaters
    // (they install with pkexec) for a package manager's install. Both read resources/app-update.yml.
    const engine = process.platform === "win32" ? new NsisUpdater() : new AppImageUpdater();
    engine.logger = log;
    engine.autoDownload = true;
    // Nothing installs without the click; a quit (Windows shutting down, say) never starts the installer.
    engine.autoInstallOnAppQuit = false;
    engine.allowPrerelease = false;
    engine.allowDowngrade = false;
    engine.on("checking-for-update", () => this.apply({ type: "checking" }));
    engine.on("update-available", (info) => this.apply({ type: "found", version: info.version, at: Date.now() }));
    engine.on("update-not-available", () => this.apply({ type: "up-to-date", at: Date.now() }));
    engine.on("download-progress", (progress) => this.apply({ type: "progress", percent: progress.percent }));
    engine.on("update-downloaded", (info) => this.apply({ type: "downloaded", version: info.version }));
    engine.on("error", (error) => {
      log.warn(error.message);
      this.apply({ type: "error", message: describeUpdateError(error), at: Date.now() });
    });
    return engine;
  }

  private async checkSelfUpdate(): Promise<void> {
    try {
      // The events above carry the outcome; the promise only settles the check.
      await this.engine!.checkForUpdates();
    } catch {
      // Reported through the `error` event.
    }
  }

  /** A notice-only install reads the latest release's Linux feed and compares versions; it downloads nothing else. */
  private async checkFeed(): Promise<void> {
    this.apply({ type: "checking" });
    try {
      const feed = this.options.noticeFeed ?? latestFeedUrl(this.options.repo!);
      const response = await this.options.fetch(feed, {
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const version = feedVersion(await response.text());
      if (!version) throw new Error("The release's update feed has no version.");
      const at = Date.now();
      this.apply(
        isNewerVersion(version, this.current.currentVersion)
          ? { type: "found", version, at }
          : { type: "up-to-date", at },
      );
    } catch (error) {
      log.warn(error instanceof Error ? error.message : error);
      this.apply({ type: "error", message: describeUpdateError(error), at: Date.now() });
    }
  }
}
