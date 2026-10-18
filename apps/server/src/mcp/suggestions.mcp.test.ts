import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createTestHarness } from "../test/harness.ts";

type Harness = ReturnType<typeof createTestHarness>;

async function connect(h: Harness) {
  const client = new Client({ name: "improver", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4317/mcp"), {
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      headers.set("host", "127.0.0.1:4317");
      return Promise.resolve(h.app.request(url.pathname + url.search, { ...init, headers }));
    },
  });
  await client.connect(transport);
  return client;
}

describe("suggestion tools", () => {
  let h: Harness;
  let agent: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await agent.callTool({ name, arguments: args })) as CallToolResult;
    return {
      isError: result.isError === true,
      text: result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
    };
  };

  beforeEach(async () => {
    h = createTestHarness({ userHome: mkdtempSync(join(tmpdir(), "suggestions-mcp-")) });
    agent = await connect(h);
  });
  afterEach(async () => {
    await agent.close();
  });

  it("lists, reads and suggests, and only the user decides", async () => {
    const list = await call("list_editable_prompts");
    expect(list.text).toContain(
      "- builtin:review  Built-in review skill (built-in: accepting saves it as the user's own skill)",
    );
    expect(list.text).toContain("used by: Review skill (board)");

    const read = await call("get_editable_prompt", { target: "builtin:review" });
    const hash = /^hash: (\w+)$/m.exec(read.text)?.[1];
    expect(hash).toBeTruthy();
    expect(read.text).toContain("earlier suggestions: none\n\n----- current text -----\n# Local review");

    const stale = await call("suggest_change", {
      target: "builtin:review",
      baseHash: "nope",
      proposed: "# Local review\n\nBe brief.",
      rationale: "Shorter.",
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/^CONFLICT: .*\nCall get_editable_prompt again/);

    const made = await call("suggest_change", {
      target: "builtin:review",
      baseHash: hash,
      proposed: "# Local review\n\nBe brief.",
      rationale: "Shorter.",
      evidence: ["#3"],
      actor: "improver",
    });
    expect(made.isError).toBe(false);
    expect(made.text).toContain("nothing has changed yet");
    expect(h.services.suggestions.list().items[0]).toMatchObject({
      actor: "improver",
      evidence: ["#3"],
      status: "open",
    });

    // The next read shows what became of it, so a later agent doesn't propose a rejected change again.
    h.services.suggestions.reject(h.services.suggestions.list().items[0]!.id, "user");
    const again = await call("get_editable_prompt", { target: "builtin:review" });
    expect(again.text).toMatch(/\nearlier suggestions \(newest first\):\n- \d{4}-\d{2}-\d{2} rejected: Shorter\.\n/);

    const unknown = await call("get_editable_prompt", { target: "skill:/etc/passwd" });
    expect(unknown.text).toMatch(/^NOT_FOUND: .*\nlist_editable_prompts lists the targets you can use\.$/);
  });
});
