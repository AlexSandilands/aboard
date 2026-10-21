import { BRAND, type ApiErrorBody, type IconCandidate, type Project } from "@repo/contracts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findIconCandidates, resolveIconFile } from "./projectIcons.ts";
import { createTestHarness } from "./test/harness.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), `${BRAND.id}-icons-`));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function put(root: string, path: string, size = 10): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "x".repeat(size));
}

const paths = (found: IconCandidate[]) => found.map((candidate) => candidate.path);
const noGit = async () => ({ code: 128, stdout: "", stderr: "not a git repository" });

describe("findIconCandidates", () => {
  it("keeps images under 2 MB and ranks icon-like names, then shallower paths", async () => {
    const root = tempDir();
    put(root, "readme.md");
    put(root, "photo.png");
    put(root, "docs/shot.jpg");
    put(root, "assets/logo.svg");
    put(root, "favicon.ico");
    put(root, "deep/er/icon.webp");
    put(root, "big.png", 2 * 1024 * 1024 + 1);
    put(root, "empty.png", 0);
    put(root, "notes.txt");
    const found = await findIconCandidates(root, noGit);
    expect(paths(found)).toEqual(["favicon.ico", "assets/logo.svg", "deep/er/icon.webp", "photo.png", "docs/shot.jpg"]);
    expect(found[0]).toEqual({ path: "favicon.ico", name: "favicon.ico", bytes: 10 });
  });

  it("walks a folder that isn't a repo, skipping build folders, stopping at 4 levels, never following links", async () => {
    const root = tempDir();
    for (const dir of ["node_modules", ".git", "dist", "build", ".next", "coverage"]) put(root, `${dir}/a.png`);
    put(root, "a/b/c/d/e.png");
    put(root, "a/b/c/d/f/too-deep.png");
    put(root, "src/ok.png");
    const outside = tempDir();
    put(outside, "secret.png");
    symlinkSync(join(outside, "secret.png"), join(root, "link.png"));
    symlinkSync(outside, join(root, "linked-dir"), "dir");
    expect(paths(await findIconCandidates(root, noGit))).toEqual(["src/ok.png", "a/b/c/d/e.png"]);
  });

  it("caps the list at 60", async () => {
    const root = tempDir();
    for (let i = 0; i < 70; i++) put(root, `img${String(i).padStart(2, "0")}.png`);
    expect(await findIconCandidates(root, noGit)).toHaveLength(60);
  });

  it("returns nothing for a folder that doesn't exist", async () => {
    expect(await findIconCandidates(join(tempDir(), "gone"), noGit)).toEqual([]);
  });

  it("lists a git folder with git, so ignored files are left out", async () => {
    const root = tempDir();
    execFileSync("git", ["init", "-q"], { cwd: root });
    put(root, ".gitignore");
    writeFileSync(join(root, ".gitignore"), "ignored/\n");
    put(root, "ignored/logo.png");
    // Deeper than the walk goes: only git would find it.
    put(root, "a/b/c/d/e/f/kept.png");
    put(root, "vendor/pkg/kept-too.png");
    expect(paths(await findIconCandidates(root))).toEqual(["vendor/pkg/kept-too.png", "a/b/c/d/e/f/kept.png"]);
  });
});

describe("icon candidate routes", () => {
  const setup = async () => {
    const h = createTestHarness();
    const root = tempDir();
    put(root, "assets/logo.svg");
    put(root, "photo.png");
    const created = await h.request("/api/projects", { method: "POST", json: { workspaceRoot: root } });
    const project = (await created.json()) as Project;
    return { h, root, project };
  };

  it("lists the candidates and serves a listed file with its type", async () => {
    const { h, project } = await setup();
    const list = await h.request(`/api/projects/${project.id}/icon-candidates`);
    expect(paths((await list.json()) as IconCandidate[])).toEqual(["assets/logo.svg", "photo.png"]);
    const file = await h.request(
      `/api/projects/${project.id}/icon-candidates/file?path=${encodeURIComponent("assets/logo.svg")}`,
    );
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/svg+xml");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await file.text()).toBe("x".repeat(10));
  });

  it("refuses paths outside the candidate list, including ../ and absolute ones", async () => {
    const { h, project, root } = await setup();
    put(root, "notes.txt");
    const outside = tempDir();
    put(outside, "secret.png");
    for (const path of [
      "notes.txt",
      "../secret.png",
      `../${basename(outside)}/secret.png`,
      join(outside, "secret.png"),
      "missing.png",
    ]) {
      const res = await h.request(`/api/projects/${project.id}/icon-candidates/file?path=${encodeURIComponent(path)}`);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(((await res.json()) as ApiErrorBody).error.code).toBe("NOT_FOUND");
    }
  });

  it("refuses a file whose real path leads out of the folder", async () => {
    const root = tempDir();
    const outside = tempDir();
    put(outside, "secret.png");
    put(root, "ok.png");
    // The scan doesn't walk into a linked folder, so this stops at the candidate list; the real-path check behind it is a second line.
    symlinkSync(outside, join(root, "linked"), "dir");
    expect(await resolveIconFile(root, "linked/secret.png")).toBeNull();
    expect(await resolveIconFile(root, "ok.png")).toMatchObject({ contentType: "image/png" });
  });

  it("returns an empty list for the General project and a missing folder", async () => {
    const { h, project, root } = await setup();
    const general = (await (await h.request("/api/projects/general", { method: "POST" })).json()) as Project;
    const none = await h.request(`/api/projects/${general.id}/icon-candidates`);
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual([]);
    rmSync(root, { recursive: true, force: true });
    const gone = await h.request(`/api/projects/${project.id}/icon-candidates`);
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual([]);
    const file = await h.request(`/api/projects/${general.id}/icon-candidates/file?path=a.png`);
    expect(file.status).toBe(404);
  });

  it("404s an unknown project", async () => {
    const { h } = await setup();
    expect((await h.request("/api/projects/nope/icon-candidates")).status).toBe(404);
  });
});
