import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Only GitHub's own modules touch GitHub (docs/decisions/0014-git-hosts.md): everything else reaches it through a
// GitHost from the GitHosts registry, so another host can plug in without touching the poller, merges or Autopilot.

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** GitHub's internals: running gh, its API client, its GraphQL queries and mapping, its status and reads. */
const GITHUB_INTERNALS = new Set(["gh.ts", "githubApi.ts", "githubSnapshot.ts", "githubStatus.ts", "githubReads.ts"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

const isTest = (file: string) => file.endsWith(".test.ts") || file.startsWith("test/");
const isGithubModule = (file: string) => /^integrations\/github[A-Za-z]*\.ts$/.test(file);

/** Each module a file imports (or re-exports from), with whether the import is types only. */
function imports(text: string): { module: string; typeOnly: boolean }[] {
  return [...text.matchAll(/^(?:import|export)(\s+type)?\s[^;]*?from\s+"([^"]+)";/gms)].map((m) => ({
    module: m[2]!.split("/").pop()!,
    typeOnly: Boolean(m[1]),
  }));
}

describe("the git host boundary", () => {
  const files = sourceFiles(SRC.replace(/\/$/, "")).map((path) => ({
    file: relative(SRC, path).replaceAll("\\", "/"),
    text: readFileSync(path, "utf8"),
  }));

  it("finds the source files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("keeps GitHub's internals inside integrations/github*.ts", () => {
    const leaks = files
      .filter(({ file }) => !isTest(file) && !isGithubModule(file))
      .flatMap(({ file, text }) =>
        imports(text)
          .filter(({ module }) => GITHUB_INTERNALS.has(module))
          // The composition root takes a `RunGh` override for tests; that type is all it may name.
          .filter(({ module, typeOnly }) => !(file === "integrations/index.ts" && module === "gh.ts" && typeOnly))
          .map(({ module }) => `${file} imports ${module}`),
      );
    expect(leaks).toEqual([]);
  });

  it("builds GitHub's host only where the hosts are wired", () => {
    const builders = files
      .filter(({ file }) => !isTest(file) && !isGithubModule(file))
      .filter(({ text }) => imports(text).some(({ module }) => module === "githubHost.ts"))
      .map(({ file }) => file);
    expect(builders).toEqual(["integrations/index.ts"]);
  });
});
