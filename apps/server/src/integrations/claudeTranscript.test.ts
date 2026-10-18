import { describe, expect, it } from "vitest";
import { condenseTranscript, pageEntries, redact } from "./claudeTranscript.ts";

// Fake secrets are assembled at runtime from short pieces, so no token-shaped string sits in the repo (a gateway may
// kill a session that reads one). Assertions check them with `includes`, so a failure can't print one either.
const glue = (...parts: string[]) => parts.join("");
const jwtHead = glue("ey", "J");
const fake = {
  openai: glue("sk", "-", "Ab1Cd2Ef".repeat(4)),
  github: glue("gh", "p_", "aB3dE5gH7j".repeat(3)),
  bearer: glue("Bear", "er ", "aB3dE5gH7".repeat(3)),
  jwt: [jwtHead, jwtHead, "c2ln"].map((head) => glue(head, "Qw7".repeat(4))).join("."),
  base64: "Zx9Kq2Lm".repeat(4),
  pairing: "ABCD".repeat(3),
};
const leaks = (text: string) => Object.values(fake).filter((secret) => text.includes(secret)).length;
const pemLine = (edge: string) => glue("-".repeat(5), edge, " PRIVATE", " KEY", "-".repeat(5));

async function* lines(entries: object[]) {
  for (const e of entries) yield JSON.stringify(e);
}

const at = (minute: number) => `2026-10-18T10:${String(minute).padStart(2, "0")}:00.000Z`;
const user = (minute: number, content: unknown, extra: object = {}) => ({
  type: "user",
  timestamp: at(minute),
  message: { role: "user", content },
  ...extra,
});
const assistant = (minute: number, ...content: object[]) => ({
  type: "assistant",
  timestamp: at(minute),
  message: { role: "assistant", content },
});
const text = (value: string) => ({ type: "text", text: value });
const tool = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
const result = (id: string, content: string, isError = false) => ({
  type: "tool_result",
  tool_use_id: id,
  content,
  ...(isError ? { is_error: true } : {}),
});

describe("redact", () => {
  it.each([
    ["an API key", `key ${fake.openai} here`],
    ["a GitHub token", `token is ${fake.github}.`],
    ["a bearer token", `Authorization: ${fake.bearer}`],
    ["a JWT", `jwt ${fake.jwt} end`],
    ["a long mixed-case run", `value ${fake.base64} end`],
    ["a named secret", `API_TOKEN=${"x7".repeat(8)}`],
    ["a pairing code", `pairing code: ${fake.pairing}`],
    ["a pairing link", `open http://127.0.0.1/pair#token=${fake.pairing}`],
  ])("redacts %s", (_name, input) => {
    const out = redact(input);
    expect(leaks(out)).toBe(0);
    expect(out.includes("x7x7x7x7")).toBe(false);
    expect(out.includes("[redacted]")).toBe(true);
  });

  it("redacts a PEM key block", () => {
    const out = redact(
      ["a", pemLine("BEGIN"), glue("MII", "Ev", "Qz8".repeat(10)), "abc", pemLine("END"), "b"].join("\n"),
    );
    expect(out.includes("MIIE")).toBe(false);
    expect(out === "a\n[redacted]\nb").toBe(true);
  });

  it("keeps what isn't a secret: commits, uuids, paths, prose", () => {
    const uuid = ["1a2b3c4d", "5e6f", "4a7b", "8c9d", "0e1f2a3b4c5d"].join("-");
    const path = ["", "home", "dev", "aboard", "src", "index.ts"].join("/");
    const keep = `commit ${"a1b2c3d4e5".repeat(4)} in ${uuid} at ${path}`;
    expect(redact(keep)).toBe(keep);
    expect(redact("the token expired, so we pass the secret along")).toBe(
      "the token expired, so we pass the secret along",
    );
  });
});

describe("condenseTranscript", () => {
  it("lists prompts, tool calls, errors, denials and each turn's final text, with the totals", async () => {
    const { entries, stats } = await condenseTranscript(
      lines([
        { type: "queue-operation", timestamp: at(0) },
        user(0, "Fix the bug", { promptSource: "sdk" }),
        assistant(
          1,
          { type: "thinking", thinking: "hmm" },
          text("Looking."),
          tool("a", "Read", { file_path: "/w/a.ts" }),
        ),
        user(1, [result("a", "file body")]),
        assistant(2, tool("b", "Bash", { command: "pnpm test\n--run" })),
        user(2, [result("b", "Exit code 1\nboom", true)]),
        assistant(3, tool("c", "Edit", { file_path: "/w/a.ts", old_string: "x" })),
        user(3, [result("c", "The user doesn't want to proceed with this tool use.", true)], {
          permissionDecision: { decision: "reject" },
        }),
        assistant(4, text("Fixed it.")),
        user(10, "Thanks, now the docs"),
        assistant(12, text("Docs done.")),
      ]),
    );
    expect(entries).toEqual([
      "[user #1] Fix the bug",
      "[tool] Read /w/a.ts",
      "[tool] Bash pnpm test --run",
      "[error] Bash: Exit code 1 boom",
      "[tool] Edit /w/a.ts",
      "[denied] Edit /w/a.ts",
      "[assistant] Fixed it.",
      "[user #2] Thanks, now the docs",
      "[assistant] Docs done.",
    ]);
    expect(stats).toMatchObject({
      turns: 2,
      toolCalls: 3,
      errors: 1,
      denials: 1,
      retries: 0,
      interruptions: 0,
      startedAt: at(0),
      endedAt: at(12),
      durationMs: 12 * 60_000,
    });
  });

  it("marks a call repeated after it failed, an API error and an interruption", async () => {
    const { entries, stats } = await condenseTranscript(
      lines([
        user(0, [text("Run it")]),
        assistant(1, tool("a", "Bash", { command: "make" })),
        user(1, [result("a", "no rule", true)]),
        assistant(2, tool("b", "Bash", { command: "make" })),
        user(2, [result("b", "ok")]),
        { ...assistant(3, text("Overloaded, retrying")), isApiErrorMessage: true },
        assistant(4, text("Half an answer")),
        user(5, [text("[Request interrupted by user]")]),
        user(6, "Continue"),
      ]),
    );
    expect(entries).toEqual([
      "[user #1] Run it",
      "[tool] Bash make",
      "[error] Bash: no rule",
      "[tool] Bash make (retry)",
      "[retry] API error: Overloaded, retrying",
      "[assistant] Half an answer",
      "[interrupted] [Request interrupted by user]",
      "[user #2] Continue",
    ]);
    expect(stats).toMatchObject({ turns: 2, toolCalls: 2, errors: 1, retries: 2, interruptions: 1 });
  });

  it("skips subagent traffic, meta and system messages, and lines it can't parse", async () => {
    async function* mixed() {
      yield "not json";
      yield JSON.stringify(user(0, "Real prompt"));
      yield JSON.stringify(user(1, "Subagent prompt", { isSidechain: true }));
      yield JSON.stringify(user(1, "Injected context", { isMeta: true }));
      yield JSON.stringify(user(1, [text("<system-reminder>be brief</system-reminder>")]));
      yield '{"type":"assistant","message":{"content":[{"type":"te';
      yield "";
    }
    const { entries } = await condenseTranscript(mixed());
    expect(entries).toEqual(["[user #1] Real prompt"]);
  });

  it("redacts before it cuts, and cuts long text", async () => {
    const { entries } = await condenseTranscript(
      lines([
        user(0, `${"a ".repeat(1400)}${fake.openai}`),
        assistant(1, tool("a", "mcp__board__link", { value: fake.github })),
        user(1, [result("a", `denied for ${fake.bearer}`, true)]),
        assistant(2, text(`The key is ${fake.openai}. ${"word ".repeat(600)}`)),
      ]),
    );
    const all = entries.join("\n");
    expect(leaks(all)).toBe(0);
    expect(entries[0]!.length).toBe("[user #1] ".length + 1500);
    expect(entries[0]!.endsWith("…")).toBe(true);
    expect(entries[1] === "[tool] mcp__board__link [redacted]").toBe(true);
    expect(entries[2] === "[error] mcp__board__link: denied for Bearer [redacted]").toBe(true);
    expect(entries[3]!.startsWith("[assistant] The key is [redacted]. word")).toBe(true);
  });

  it("reports an empty transcript", async () => {
    const { entries, stats } = await condenseTranscript(lines([{ type: "ai-title", aiTitle: "x" }]));
    expect(entries).toEqual([]);
    expect(stats).toMatchObject({ turns: 0, startedAt: null, durationMs: null });
  });
});

describe("pageEntries", () => {
  const entries = ["a".repeat(10), "b".repeat(10), "c".repeat(10), "d".repeat(10)];

  it("fills a page up to the limit and says where the next starts", () => {
    const first = pageEntries(entries, 0, 25);
    expect(first).toMatchObject({ offset: 0, total: 4, next: 2 });
    expect(first.lines).toEqual(entries.slice(0, 2));
    const second = pageEntries(entries, first.next!, 25);
    expect(second).toMatchObject({ offset: 2, next: null });
    expect(second.lines).toEqual(entries.slice(2));
  });

  it("always returns one entry, even one over the limit, and clamps the offset", () => {
    expect(pageEntries(entries, 1, 3)).toMatchObject({ lines: [entries[1]], next: 2 });
    expect(pageEntries(entries, 99, 25)).toMatchObject({ lines: [], offset: 4, next: null });
    expect(pageEntries(entries, -5, 25).offset).toBe(0);
  });
});
