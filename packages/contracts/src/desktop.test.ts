import { describe, expect, it } from "vitest";
import { brandEnv } from "./brand.ts";
import { DESKTOP_SANDBOX_ENV, desktopSandboxEnv, readDesktopSandbox } from "./desktop.ts";

const sandbox = { home: "/tmp/sandbox-wt", serverPort: 51_234, webPort: 51_235 };
const realHome = "/home/me/.board";

describe("desktopSandboxEnv", () => {
  const env = desktopSandboxEnv(
    {
      PATH: "/bin",
      ELECTRON_RUN_AS_NODE: "1",
      [brandEnv("TOKEN")]: "secret",
      [brandEnv("HOME")]: realHome,
    },
    sandbox,
  );

  it("points the shell at the sandbox's server and Vite", () => {
    expect(env[brandEnv("PORT")]).toBe("51234");
    expect(env[brandEnv("WEB_PORT")]).toBe("51235");
    expect(env[brandEnv("DEV_URL")]).toBe("http://127.0.0.1:51235/");
    expect(env[DESKTOP_SANDBOX_ENV]).toBe(sandbox.home);
    expect(env.PATH).toBe("/bin");
  });

  it("drops the user's own token and data dir and run-as-node", () => {
    expect(env[brandEnv("TOKEN")]).toBeUndefined();
    expect(env[brandEnv("HOME")]).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});

describe("readDesktopSandbox", () => {
  it("is null for a normal run", () => {
    expect(readDesktopSandbox({ [brandEnv("PORT")]: "4317" }, realHome)).toBeNull();
  });

  it("reads back what desktopSandboxEnv wrote", () => {
    expect(readDesktopSandbox(desktopSandboxEnv({}, sandbox), realHome)).toEqual(sandbox);
  });

  it("refuses the real data dir or anything inside it", () => {
    for (const home of [realHome, `${realHome}/`, "/HOME/me/.board/data", "", "relative/sandbox"]) {
      const env = { ...desktopSandboxEnv({}, sandbox), [DESKTOP_SANDBOX_ENV]: home };
      expect(readDesktopSandbox(env, realHome)).toHaveProperty("error");
    }
    // A sibling that merely shares the prefix is not the real dir.
    const sibling = { ...desktopSandboxEnv({}, sandbox), [DESKTOP_SANDBOX_ENV]: `${realHome}-sandbox` };
    expect(readDesktopSandbox(sibling, realHome)).toMatchObject({ home: `${realHome}-sandbox` });
  });

  it("refuses the real board's ports", () => {
    const onRealServer = desktopSandboxEnv({}, { ...sandbox, serverPort: 4317 });
    expect(readDesktopSandbox(onRealServer, realHome)).toHaveProperty("error");
    const onRealWeb = desktopSandboxEnv({}, { ...sandbox, webPort: 5317 });
    expect(readDesktopSandbox(onRealWeb, realHome)).toHaveProperty("error");
    // No port at all falls back to the real one.
    const noPort = desktopSandboxEnv({}, sandbox);
    delete noPort[brandEnv("PORT")];
    expect(readDesktopSandbox(noPort, realHome)).toHaveProperty("error");
  });

  it("needs the sandbox's Vite on localhost", () => {
    for (const url of [undefined, "", "not a url", "http://example.com:51235/", "http://127.0.0.1/"]) {
      const env = { ...desktopSandboxEnv({}, sandbox), [brandEnv("DEV_URL")]: url };
      expect(readDesktopSandbox(env, realHome)).toHaveProperty("error");
    }
  });
});
