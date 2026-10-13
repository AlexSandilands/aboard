import type { AppSettings } from "@taskboard/contracts";
import type { Core } from "./core.ts";
import type { SettingsService } from "./types.ts";

interface StoredSettings {
  jiraBaseUrl: string | null;
  githubPolling: boolean;
  t3LinkTarget: AppSettings["t3LinkTarget"];
  t3Token: string | null;
}

const DEFAULTS: StoredSettings = { jiraBaseUrl: null, githubPolling: true, t3LinkTarget: "desktop", t3Token: null };

/** App settings stored as key/value JSON. The T3 token never leaves the server. */
export function createSettingsService(core: Core): SettingsService {
  const { repos } = core;

  const load = (): StoredSettings => {
    const stored = repos.settings.all();
    const pick = <K extends keyof StoredSettings>(key: K): StoredSettings[K] =>
      stored.has(key) ? (stored.get(key) as StoredSettings[K]) : DEFAULTS[key];
    return {
      jiraBaseUrl: pick("jiraBaseUrl"),
      githubPolling: pick("githubPolling"),
      t3LinkTarget: pick("t3LinkTarget"),
      t3Token: pick("t3Token"),
    };
  };

  const get = (): AppSettings => {
    const { t3Token, ...rest } = load();
    return { ...rest, t3TokenSet: Boolean(t3Token) };
  };

  return {
    get,
    update(input) {
      core.write(() => {
        const blankToNull = (v: string | null) => (v ? v : null);
        if (input.jiraBaseUrl !== undefined) {
          repos.settings.set("jiraBaseUrl", blankToNull(input.jiraBaseUrl?.replace(/\/+$/, "") ?? null));
        }
        if (input.githubPolling !== undefined) repos.settings.set("githubPolling", input.githubPolling);
        if (input.t3LinkTarget !== undefined) repos.settings.set("t3LinkTarget", input.t3LinkTarget);
        if (input.t3Token !== undefined) repos.settings.set("t3Token", blankToNull(input.t3Token));
      });
      return get();
    },
    t3Token: () => load().t3Token,
  };
}
