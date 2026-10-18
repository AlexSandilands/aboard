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
  base64std: glue("Ab3+", "Cd4/", "Ef5g").repeat(4),
  base64url: glue("Zx9Kq2Lm".repeat(3), "_", "Pq4Rs7Tu".repeat(2)),
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
    ["standard base64", `value ${fake.base64std} end`],
    ["a word after the secret word", `${glue("AWS_", "SECRET_", "ACCESS_", "KEY")}=${"x7".repeat(8)}`],
    ["a word before the secret word", `export ${glue("PG", "PASS", "WORD")}=${"x7".repeat(8)}`],
    ["a secret name inside a value", `--set=${glue("to", "ken")}=${"x7".repeat(8)}`],
    ["a Basic authorization header", `${glue("Author", "ization")}: ${glue("Ba", "sic")} ${"x7".repeat(8)}`],
    ["a password in a URL", glue("post", "gres:/", "/app", ":", "x7".repeat(8), "@db", ":5432/main")],
    ["a base64url key", `value ${fake.base64url} end`],
    ["a secret flag and its value", `${glue("--pass", "word")} ${"x7".repeat(8)} --verbose`],
    ["a password after curl's -u", `${glue("curl -", "u ", "admin", ":")}${"x7".repeat(8)} host`],
    ["a password after --user=", `${glue("--us", "er=", "admin", ":")}${"x7".repeat(8)} host`],
    ["a quoted value with spaces", `${glue("pass", "word")}: "${glue("x7x7", "x7x7 ", "and more")}"`],
    ["a single-quoted value with spaces", `${glue("api", "Key")}='${glue("x7x7", "x7x7 ", "and more")}'`],
  ])("redacts %s", (_name, input) => {
    const out = redact(input);
    expect(leaks(out)).toBe(0);
    expect(out.includes("x7x7x7x7")).toBe(false);
    expect(out.includes("and more")).toBe(false);
    expect(out.includes("[redacted]")).toBe(true);
  });

  it("redacts a PEM key block", () => {
    const out = redact(
      ["a", pemLine("BEGIN"), glue("MII", "Ev", "Qz8".repeat(10)), "abc", pemLine("END"), "b"].join("\n"),
    );
    expect(out.includes("MIIE")).toBe(false);
    expect(out === "a\n[redacted]\nb").toBe(true);
  });

  it("redacts a PGP key block", () => {
    const pgpLine = (edge: string) =>
      glue("-".repeat(5), edge, " PGP", " PRIVATE", " KEY", " BLO", "CK", "-".repeat(5));
    const out = redact(["a", pgpLine("BEGIN"), "", glue("lQ", "dG", "Bm8".repeat(10)), pgpLine("END"), "b"].join("\n"));
    expect(out.includes("lQdG")).toBe(false);
    expect(out === "a\n[redacted]\nb").toBe(true);
  });

  it("keeps what isn't a secret: commits, uuids, paths, prose", () => {
    const uuid = ["1a2b3c4d", "5e6f", "4a7b", "8c9d", "0e1f2a3b4c5d"].join("-");
    const path = ["", "home", "dev", "aboard", "src", "index.ts"].join("/");
    const keep = `commit ${"a1b2c3d4e5".repeat(4)} in ${uuid} at ${path}`;
    expect(redact(keep)).toBe(keep);
    const config = ["max_tokens: 4096", "PORT=5317", "description: fix the password reset flow"].join("\n");
    expect(redact(config)).toBe(config);
    const deep = ["C:", "Users", "Dev", "Projects", "MyApp2", "src", "Components3", "Header.tsx"].join("/");
    expect(redact(deep)).toBe(deep);
    expect(redact("the token expired, so we pass the secret along")).toBe(
      "the token expired, so we pass the secret along",
    );
  });

  it("keeps code and config beside a secret name: types, calls, other names, numbers, paths", () => {
    const code = [
      "password: string;",
      "accessToken: string | null,",
      "secretsManager: SecretsManagerClient",
      "const token = fetchToken(options);",
      "apiKey = config.apiKey",
      "password = newPassword",
      "totalTokens: 154321",
      "max_tokens=200000",
      "PWD=/home/dev/aboard OLDPWD=/home/dev",
      "--token-file ./config/dev.txt",
    ].join("\n");
    expect(redact(code)).toBe(code);
  });

  it("keeps long runs made of words: a project folder, identifiers with a digit", () => {
    const folder = ["C", "", "Users", "dev", "", "t3", "worktrees", "aboard", "t3", "dad8ce25"].join("-");
    const names = [
      glue("handle", "OAuth2", "Callback", "For", "Provider", "Settings"),
      glue("parse", "ISO8601", "DateTime", "V2", "Format", "Strings"),
      ["load", "Config", "v2", "from", "remote", "storage", "backend"].join("_"),
    ];
    for (const keep of [folder, ...names]) expect(redact(`at ${keep} now`)).toBe(`at ${keep} now`);
  });

  it("scans a long run once, so a huge hyphenated or plain run is quick", () => {
    for (const run of ["a-".repeat(200_000), "a".repeat(400_000), "a=".repeat(200_000)]) {
      const started = performance.now();
      expect(redact(run) === run).toBe(true);
      expect(performance.now() - started).toBeLessThan(2000);
    }
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

  it("cuts huge text before redacting it, and drops a secret the first cut splits", async () => {
    // The prompt's limit is 1500 characters, and text is first cut at four times that.
    const { entries } = await condenseTranscript(
      lines([
        user(0, `${"\n".repeat(6000 - 8)}${fake.openai}`),
        assistant(1, tool("a", "Bash", { command: "cat big.log" })),
        user(1, [result("a", "a-b-c-d ".repeat(250_000), true)]),
      ]),
    );
    expect(entries[0]).toBe("[user #1] …");
    expect(entries[0]!.includes(fake.openai.slice(0, 6))).toBe(false);
    expect(entries[2]!.length).toBe("[error] Bash: ".length + 300);
  });

  it("drops only the tail of a long line the first cut splits, and still the split secret", async () => {
    const { entries } = await condenseTranscript(
      lines([
        user(0, `${";".repeat(6000 - 8)}${fake.openai}`),
        assistant(1, tool("a", "Bash", { command: "node build.js" })),
        user(1, [result("a", "x;".repeat(100_000), true)]),
      ]),
    );
    expect(entries[0]!.includes(fake.openai.slice(0, 6))).toBe(false);
    expect(entries[0] === `[user #1] ${";".repeat(1499)}…`).toBe(true);
    expect(entries[2] === `[error] Bash: ${"x;".repeat(150).slice(0, 299)}…`).toBe(true);
  });

  it("logs slash commands and compaction apart from turns, and an interrupted tool once", async () => {
    const command = [
      "<command-message>review</command-message>",
      "<command-name>/review</command-name>",
      "<command-args>the PR</command-args>",
    ].join("\n");
    const { entries, stats } = await condenseTranscript(
      lines([
        user(0, command),
        user(0, "<local-command-stdout>Total cost: 10 cents</local-command-stdout>"),
        assistant(1, tool("a", "Edit", { file_path: "/w/a.ts" })),
        user(2, [result("a", "The user doesn't want to proceed with this tool use.", true)]),
        user(2, [text("[Request interrupted by user for tool use]")]),
        assistant(3, tool("b", "Write", { file_path: "/w/b.ts" })),
        user(4, [
          result("b", "The user doesn't want to proceed with this tool use.", true),
          text("[Request interrupted by user for tool use]"),
        ]),
        user(5, "This session is being continued from a previous conversation. Summary: …", {
          isCompactSummary: true,
        }),
        user(6, "Go on"),
      ]),
    );
    expect(entries).toEqual([
      "[command] /review the PR",
      "[tool] Edit /w/a.ts",
      "[interrupted] [Request interrupted by user for tool use] (at Edit /w/a.ts)",
      "[tool] Write /w/b.ts",
      "[interrupted] [Request interrupted by user for tool use] (at Write /w/b.ts)",
      "[compacted] The earlier conversation was summarised to free up context.",
      "[user #1] Go on",
    ]);
    expect(stats).toMatchObject({ turns: 1, toolCalls: 2, errors: 0, denials: 0, interruptions: 2 });
  });

  it("keeps a denial the user didn't follow with an interruption", async () => {
    const { entries, stats } = await condenseTranscript(
      lines([
        user(0, "Edit it"),
        assistant(1, tool("a", "Edit", { file_path: "/w/a.ts" })),
        user(2, [result("a", "Permission to use Edit has been denied.", true)]),
        assistant(3, text("Understood.")),
        user(4, [text("[Request interrupted by user]")]),
      ]),
    );
    expect(entries).toEqual([
      "[user #1] Edit it",
      "[tool] Edit /w/a.ts",
      "[denied] Edit /w/a.ts",
      "[assistant] Understood.",
      "[interrupted] [Request interrupted by user]",
    ]);
    expect(stats).toMatchObject({ denials: 1, interruptions: 1 });
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
    expect(pageEntries(entries, 99, 25)).toMatchObject({ lines: [], offset: 99, next: null });
    expect(pageEntries(entries, -5, 25).offset).toBe(0);
  });
});
