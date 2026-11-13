import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The installer is a file Arch users download by itself, so it can't read the product name or the GitHub repo from
// package.json the way the rest of the code does. This holds its copies to package.json instead.
const root = new URL("../", import.meta.url);
const script = readFileSync(new URL("packaging/install-arch.sh", root), "utf8");
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  name: string;
  repository: { url: string };
};

function variable(name: string): string | undefined {
  return new RegExp(`^${name}=(.*)$`, "m").exec(script)?.[1];
}

describe("install-arch.sh", () => {
  const github = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");

  it("names the repo after the package", () => {
    expect(variable("repo")).toBe(pkg.name);
  });

  it("points at the GitHub repo in package.json", () => {
    expect(variable("github")).toBe(github);
    expect(variable("key_url")).toBe(
      `${github.replace("github.com", "raw.githubusercontent.com")}/main/packaging/pacman-signing-key.asc`,
    );
  });

  it("shows the download URL the release serves it at", () => {
    expect(script).toContain(`curl -fsSLO ${github}/releases/download/pacman/install-arch.sh`);
  });
});
