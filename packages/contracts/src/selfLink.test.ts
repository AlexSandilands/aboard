import { describe, expect, it } from "vitest";
import { AGENT_HARNESSES, AgentHarness } from "./agentSessions.ts";
import {
  SELF_LINK_FAILED,
  SELF_LINK_HOSTS,
  SELF_LINK_OTHER_HOST,
  selfLinkCall,
  selfLinkHostLine,
  selfLinkHostsFor,
  selfLinkLookups,
  selfLinkReminder,
  sessionLinkLine,
  t3ThreadLinkLine,
} from "./selfLink.ts";

const STALE_T3_TOOL = ["t3_thread", "configuration"].join("_");

describe("self-link registry", () => {
  it("has T3 Code and one entry per harness, each with somewhere to look", () => {
    expect(SELF_LINK_HOSTS.map((host) => host.id)).toEqual(["t3-code", ...AgentHarness.options]);
    for (const host of SELF_LINK_HOSTS) expect(host.lookups.length).toBeGreaterThan(0);
  });

  it.each(SELF_LINK_HOSTS.map((host) => host.id))("%s has a link call and says where its id comes from", (id) => {
    const line = selfLinkHostLine(id, '"#4"', "Implementing #4");
    expect(line).toContain(selfLinkCall(id, '"#4"', "Implementing #4"));
    expect(line).toContain(selfLinkLookups(id));
    expect(line).toContain('task: "#4"');
    expect(line).not.toContain(STALE_T3_TOOL);
  });

  it("names exactly one variable for each harness", () => {
    for (const harness of AgentHarness.options) {
      expect(selfLinkLookups(harness).match(/\$[A-Z_]+/g)).toEqual(
        Array(2).fill(`$${AGENT_HARNESSES[harness].idEnvVar}`),
      );
    }
  });

  it("sends T3 Code to its tool, then the message references, and names no variable", () => {
    const line = selfLinkHostLine("t3-code", '"#4"', "x");
    expect(line).toContain('link(task: "#4", value: "<thread id>")');
    expect(selfLinkLookups("t3-code").indexOf("t3_thread_configure")).toBeLessThan(
      selfLinkLookups("t3-code").indexOf("T3 references"),
    );
    expect(line).not.toContain("$");
    expect(t3ThreadLinkLine("to the task")).not.toContain("$");
  });
});

describe("selfLinkReminder", () => {
  const input = { task: '"#4"', label: "Implementing #4" };

  it("gives a known harness its own lookup and T3 Code's, not the other CLIs'", () => {
    const text = selfLinkReminder({ ...input, harness: "codex" }).join("\n");
    expect(text).toContain("$CODEX_THREAD_ID");
    expect(text).toContain("t3_thread_configure");
    expect(text).not.toContain("$CLAUDE_CODE_SESSION_ID");
    expect(text).not.toContain(SELF_LINK_OTHER_HOST);
  });

  it("gives an unknown client every host and the route for a host not listed", () => {
    const text = selfLinkReminder({ ...input, harness: null }).join("\n");
    for (const { idEnvVar } of Object.values(AGENT_HARNESSES)) expect(text).toContain(`$${idEnvVar}`);
    expect(text).toContain(SELF_LINK_OTHER_HOST);
    expect(selfLinkHostsFor(null)).toHaveLength(SELF_LINK_HOSTS.length);
  });

  it("always says what to do when nothing works", () => {
    for (const harness of [null, ...AgentHarness.options]) {
      expect(selfLinkReminder({ ...input, harness })).toContain(SELF_LINK_FAILED);
    }
  });
});

describe("prompt lines", () => {
  it("names every harness and its variable", () => {
    const line = sessionLinkLine({ label: "Implementing #4" });
    for (const { label, idEnvVar } of Object.values(AGENT_HARNESSES)) {
      expect(line).toContain(label);
      expect(line).toContain(`$${idEnvVar}`);
    }
    expect(line).toContain('link(agentSession: {harness, sessionId, cwd}, label: "Implementing #4")');
  });

  it("takes a task argument when it covers several tasks", () => {
    expect(sessionLinkLine({ label: "x", everyTask: true })).toContain("link(task, agentSession: ");
    expect(t3ThreadLinkLine("to every task", true)).toContain('link(task, value: "<thread id>")');
  });
});
