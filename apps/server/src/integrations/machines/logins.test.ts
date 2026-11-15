import { describe, expect, it } from "vitest";
import { createLoginDetector, type ProbeResult } from "./logins.ts";

const ok: ProbeResult = { code: 0, stdout: "", stderr: "" };
const failed: ProbeResult = { code: 1, stdout: "", stderr: "" };

/** A machine where `installed` are on the PATH and each command line answers as `answers` says (exit 1 otherwise). */
function machine(installed: string[], answers: Record<string, ProbeResult>) {
  const ran: string[] = [];
  const detector = createLoginDetector({
    env: {},
    find: (command) => (installed.includes(command) ? `/usr/bin/${command}` : null),
    run: (exe, args) => {
      const line = `${exe.replace("/usr/bin/", "")} ${args.join(" ")}`;
      ran.push(line);
      const key = Object.keys(answers).find((k) => line.startsWith(k));
      return Promise.resolve(key ? answers[key]! : failed);
    },
  });
  return { detector, ran };
}

const states = async (detector: { logins(): Promise<Array<{ name: string; state: string }>> }) =>
  Object.fromEntries((await detector.logins()).map((l) => [l.name, l.state]));

describe("a runner's logins", () => {
  it("reports each CLI as logged in, logged out or missing", async () => {
    const { detector } = machine(["claude", "gh", "git"], {
      "claude auth status": ok,
      "gh auth status": failed,
    });
    const logins = await detector.logins();
    expect(logins.map((l) => [l.name, l.state])).toEqual([
      ["claude", "ok"],
      ["codex", "missing"],
      ["gh", "logged-out"],
      ["git", "logged-out"],
    ]);
    expect(logins.find((l) => l.name === "gh")?.detail).toContain("gh auth login");
  });

  it("counts gh's credential helper as a way to push only while gh is logged in", async () => {
    const helper = {
      code: 0,
      stdout: "credential.https://github.com.helper !/usr/bin/gh auth git-credential\n",
      stderr: "",
    };
    const out = machine(["gh", "git"], { "git config": helper });
    expect(await states(out.detector)).toMatchObject({ gh: "logged-out", git: "logged-out" });
    const loggedIn = machine(["gh", "git"], { "git config": helper, "gh auth status": ok });
    expect(await states(loggedIn.detector)).toMatchObject({ gh: "ok", git: "ok" });
  });

  it("takes another credential helper, or an SSH key GitHub greets, as a way to push", async () => {
    const store = machine(["git"], { "git config": { code: 0, stdout: "credential.helper store\n", stderr: "" } });
    expect(await states(store.detector)).toMatchObject({ git: "ok" });
    const key = machine(["git", "ssh"], {
      "ssh -T": {
        code: 1,
        stdout: "",
        stderr: "Hi alex! You've successfully authenticated, but GitHub does not provide shell access.",
      },
    });
    expect(await states(key.detector)).toMatchObject({ git: "ok" });
  });

  it("answers within the wait with what was last known, and catches up afterwards", async () => {
    let release: (result: ProbeResult) => void = () => {};
    const detector = createLoginDetector({
      env: {},
      find: (command) => (command === "gh" ? "/usr/bin/gh" : null),
      run: () => new Promise((resolve) => (release = resolve)),
    });
    expect(await states({ logins: () => detector.loginsWithin(10) })).toMatchObject({ gh: "unknown", git: "unknown" });
    release(ok);
    expect(await states(detector)).toMatchObject({ gh: "ok", claude: "missing" });
    expect(await states({ logins: () => detector.loginsWithin(10) })).toMatchObject({ gh: "ok" });
  });

  it("says unknown when a check doesn't finish, and reuses an answer for a minute", async () => {
    const { detector, ran } = machine(["claude"], { "claude auth status": { code: null, stdout: "", stderr: "" } });
    expect(await states(detector)).toMatchObject({ claude: "unknown" });
    const count = ran.length;
    await detector.logins();
    expect(ran).toHaveLength(count);
  });
});
