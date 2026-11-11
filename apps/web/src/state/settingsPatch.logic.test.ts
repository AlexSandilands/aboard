import type { AppSettings, UpdateSettingsInput } from "@repo/contracts";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { applySettingsPatch } from "./settingsPatch.logic";
import { SETTINGS_QUERY_KEY, settingsWriteOptions, withPendingSettingsWrites } from "./settingsWrites";

/** The fields these tests read; the rest of AppSettings plays no part in the merges. */
const baseSettings = (): AppSettings =>
  ({
    githubPolling: true,
    providers: [{ id: "claude-code", enabled: true, cliPath: null }],
    handoffMenus: { "claude-code": true, codex: true },
    operationModels: { digest: { tier: "light" }, orchestrate: { tier: "deep" } },
    modelTiers: {
      light: { description: null, t3: null },
      standard: { description: "Everyday", t3: null },
      deep: { description: null, t3: null },
    },
    notifications: { muteInQuietHours: false, kinds: { thread_waiting: true, pr_checks_failing: true } },
    keybindings: { "board.search": "mod+k" },
    backupDir: "/backups",
    backupRemote: null,
    machineName: "laptop",
    machineNameIsDefault: true,
    t3TokenSet: false,
  }) as unknown as AppSettings;

describe("applySettingsPatch", () => {
  it("replaces plain fields and lists, and leaves the rest alone", () => {
    const settings = baseSettings();
    const next = applySettingsPatch(settings, {
      githubPolling: false,
      providers: [{ id: "codex", enabled: true }],
      keybindings: {},
    });
    expect(next.githubPolling).toBe(false);
    expect(next.providers).toEqual([{ id: "codex", enabled: true }]);
    expect(next.keybindings).toEqual({});
    expect(next.handoffMenus).toBe(settings.handoffMenus);
    expect(settings.githubPolling).toBe(true);
  });

  it("merges operation models, and null puts one back to its default", () => {
    const next = applySettingsPatch(baseSettings(), {
      operationModels: { digest: null, ask: { tier: "standard" } },
    });
    expect(next.operationModels).toEqual({ orchestrate: { tier: "deep" }, ask: { tier: "standard" } });
  });

  it("merges hand-off menus, tiers and notification switches per key", () => {
    const next = applySettingsPatch(baseSettings(), {
      handoffMenus: { codex: false },
      modelTiers: { light: { description: "Cheap", t3: null } },
      notifications: { kinds: { pr_checks_failing: false } },
    });
    expect(next.handoffMenus).toEqual({ "claude-code": true, codex: false });
    expect(next.modelTiers.light.description).toBe("Cheap");
    expect(next.modelTiers.standard.description).toBe("Everyday");
    expect(next.notifications).toEqual({
      muteInQuietHours: false,
      kinds: { thread_waiting: true, pr_checks_failing: false },
    });
  });

  it("stores blank backup paths as none and never caches the token", () => {
    const next = applySettingsPatch(baseSettings(), { backupDir: "", t3Token: "secret" });
    expect(next.backupDir).toBeNull();
    expect(next.t3TokenSet).toBe(true);
    expect(next).not.toHaveProperty("t3Token");
    expect(applySettingsPatch(next, { t3Token: null }).t3TokenSet).toBe(false);
  });

  it("sets a machine name, and leaves a cleared one for the server, which knows the host name", () => {
    const named = applySettingsPatch(baseSettings(), { machineName: "work" });
    expect(named).toMatchObject({ machineName: "work", machineNameIsDefault: false });
    expect(applySettingsPatch(named, { machineName: null })).toMatchObject({ machineName: "work" });
  });

  it("can be applied twice to the same effect", () => {
    const input = { operationModels: { digest: null }, handoffMenus: { codex: false } } as const;
    const once = applySettingsPatch(baseSettings(), input);
    expect(applySettingsPatch(once, input)).toEqual(once);
  });
});

/** A fake server holding the settings, whose replies the test releases one at a time. */
function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let stored = baseSettings();
  // Reads like useSettings: the server's copy with the writes in flight on top.
  queryClient.setQueryDefaults(SETTINGS_QUERY_KEY, {
    queryFn: async () => withPendingSettingsWrites(queryClient, stored),
  });
  queryClient.setQueryData(SETTINGS_QUERY_KEY, stored);
  const replies: Array<() => void> = [];
  const failures: Error[] = [];
  const save = vi.fn<(input: UpdateSettingsInput) => Promise<AppSettings>>(
    (input: UpdateSettingsInput) =>
      new Promise<AppSettings>((resolve, reject) => {
        replies.push(() => {
          if (input.githubPolling === false) return reject(new Error("refused"));
          stored = applySettingsPatch(stored, input);
          resolve(stored);
        });
      }),
  );
  const options = settingsWriteOptions(queryClient, save, (error) => failures.push(error));
  const write = (input: UpdateSettingsInput) =>
    new MutationObserver(queryClient, options).mutate(input).catch(() => undefined);
  const cached = () => queryClient.getQueryData<AppSettings>(SETTINGS_QUERY_KEY)!;
  /** Lets the next queued request reach the fake server. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { queryClient, save, write, cached, replies, failures, flush };
}

describe("settings writes", () => {
  it("show in the cache before the server answers", () => {
    const { write, cached } = setup();
    void write({ operationModels: { digest: { tier: "deep" } } });
    expect(cached().operationModels.digest).toEqual({ tier: "deep" });
  });

  it("reach the server one at a time, in order, and an early reply doesn't undo a later edit", async () => {
    const { write, cached, replies, save, flush } = setup();
    const first = write({ handoffMenus: { codex: false } });
    const second = write({ operationModels: { digest: null } });
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    replies.shift()!();
    await first;
    // The first reply knows nothing of the second edit, which is still on screen.
    expect(cached().handoffMenus.codex).toBe(false);
    expect(cached().operationModels).not.toHaveProperty("digest");
    await flush();
    expect(save).toHaveBeenCalledTimes(2);
    replies.shift()!();
    await second;
    expect(cached().operationModels).not.toHaveProperty("digest");
  });

  it("drop a failed edit and keep the others when the settings are read again", async () => {
    const { queryClient, write, cached, replies, failures, flush } = setup();
    const failing = write({ githubPolling: false });
    const later = write({ handoffMenus: { codex: false } });
    expect(cached().githubPolling).toBe(false);
    await flush();
    replies.shift()!();
    await failing;
    // The failure invalidated the settings; nothing observes them here, so read them as a mounted page would.
    await queryClient.refetchQueries({ queryKey: SETTINGS_QUERY_KEY, type: "all" });
    expect(failures.map((e) => e.message)).toEqual(["refused"]);
    expect(cached().githubPolling).toBe(true);
    expect(cached().handoffMenus.codex).toBe(false);
    await flush();
    replies.shift()!();
    await later;
    expect(cached().handoffMenus.codex).toBe(false);
  });
});
