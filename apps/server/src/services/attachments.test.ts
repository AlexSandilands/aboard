import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { attachmentToken, BRAND, MAX_ATTACHMENT_BYTES } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createRepos } from "../db/repos/index.ts";
import { openDatabase } from "../db/database.ts";
import { createTestHarness } from "../test/harness.ts";
import { copyAttachmentFiles, readDumpDir, writeDumpDir } from "./backup/files.ts";
import { restoreBoard } from "./backup/restore.ts";

/** Starts with a PNG's signature, which is all the upload checks; the rest is filler. */
const png = (size = 64): Uint8Array => {
  const bytes = new Uint8Array(size).fill(7);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), `${BRAND.id}-attachments-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const h = createTestHarness();
  const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const task = h.services.tasks.create({ projectId: project.id, title: "Bug" });
  const upload = (taskId: string | null, bytes: Uint8Array = png(), type = "image/png") =>
    h.request(
      `/api/attachments?${new URLSearchParams({ ...(taskId ? { taskId } : {}), filename: "shot.png" }).toString()}`,
      {
        method: "POST",
        headers: { "content-type": type },
        body: new Blob([bytes]),
      },
    );
  return { ...h, project, task, upload };
}

/** The data dir's attachments folder, from where one of its files is. */
const attachmentsDirOf = (path: string) => dirname(dirname(path));

describe("attachment routes", () => {
  it("stores an image under the task and serves it back", async () => {
    const { upload, request, task, services } = setup();
    const res = await upload(task.id);
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; url: string };
    expect(created).toMatchObject({ taskId: task.id, filename: "shot.png", mime: "image/png", size: 64 });

    const [stored] = services.attachments.forTask(task.id);
    expect(stored!.path).toContain(join(task.id, `${created.id}.png`));
    expect(readFileSync(stored!.path)).toEqual(Buffer.from(png()));

    const served = await request(created.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png());
  });

  it("refuses other types, bytes that aren't the type they claim, empty and oversized files", async () => {
    const { upload, task } = setup();
    expect((await upload(task.id, png(), "text/html")).status).toBe(400);
    expect((await upload(task.id, new TextEncoder().encode("<script>"), "image/png")).status).toBe(400);
    expect((await upload(task.id, new Uint8Array(0))).status).toBe(400);
    expect((await upload(task.id, png(MAX_ATTACHMENT_BYTES + 1))).status).toBe(400);
    expect((await upload("nope")).status).toBe(404);
  });

  it("answers 404 for an unknown image, and asks for the token when one is set", async () => {
    const { request } = setup();
    expect((await request("/api/attachments/missing")).status).toBe(404);
    const guarded = createTestHarness({ token: "secret" });
    expect((await guarded.request("/api/attachments/missing")).status).toBe(401);
    expect((await guarded.request("/api/attachments/missing?token=secret")).status).toBe(404);
  });
});

describe("attachment files", () => {
  it("are deleted with the task", async () => {
    const { upload, task, services } = setup();
    await upload(task.id);
    const [stored] = services.attachments.forTask(task.id);
    expect(existsSync(stored!.path)).toBe(true);
    services.tasks.update(task.id, { archived: true }, "user");
    services.tasks.delete(task.id, "user");
    expect(existsSync(stored!.path)).toBe(false);
    expect(services.attachments.forTask(task.id)).toEqual([]);
  });

  it("are claimed by the task created with a description that refers to them", async () => {
    const { upload, project, services } = setup();
    const kept = (await (await upload(null)).json()) as { id: string };
    const stray = (await (await upload(null)).json()) as { id: string };
    const task = services.tasks.create({
      projectId: project.id,
      title: "From a screenshot",
      description: `It looks like this ${attachmentToken(kept.id)}`,
    });
    const claimed = services.attachments.forTask(task.id);
    expect(claimed.map((a) => a.id)).toEqual([kept.id]);
    expect(existsSync(claimed[0]!.path)).toBe(true);
    expect(services.attachments.get(stray.id).taskId).toBeNull();
  });

  it("sweep removes old files waiting for a task that have no row, and keeps recent ones", async () => {
    const { upload, services, task } = setup();
    await upload(task.id);
    const [stored] = services.attachments.forTask(task.id);
    const pending = join(attachmentsDirOf(stored!.path), "_pending");
    mkdirSync(pending, { recursive: true });
    const old = join(pending, `${"a".repeat(8)}-0000-0000-0000-${"b".repeat(12)}.png`);
    const recent = join(pending, `${"c".repeat(8)}-0000-0000-0000-${"d".repeat(12)}.png`);
    writeFileSync(old, "x");
    writeFileSync(recent, "x");
    const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(old, longAgo, longAgo);
    services.attachments.sweep();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("sweep removes unclaimed images after a day", async () => {
    const { upload, services, db } = setup();
    const stray = (await (await upload(null)).json()) as { id: string };
    services.attachments.sweep();
    expect(services.attachments.get(stray.id).id).toBe(stray.id);
    db.prepare("UPDATE task_attachments SET created_at = '2020-01-01T00:00:00.000Z'").run();
    services.attachments.sweep();
    expect(() => services.attachments.get(stray.id)).toThrow(/not found/);
  });
});

describe("attachments whose rows can't be trusted", () => {
  it("never become a path: a restored row with odd ids or type is not served, listed or deleted through", async () => {
    const { upload, task, services, db, request } = setup();
    const created = (await (await upload(task.id)).json()) as { id: string };
    // What a crafted backup could leave in the table: a type that is an Object.prototype key, and a path-like id.
    db.prepare("UPDATE task_attachments SET mime = 'constructor' WHERE id = ?").run(created.id);
    expect((await request(`/api/attachments/${created.id}`)).status).toBe(404);
    expect(services.attachments.forTask(task.id)).toEqual([]);
    db.prepare(
      "INSERT INTO task_attachments (id, task_id, filename, mime, size, created_at) VALUES (?, ?, 'x', 'image/png', 1, '2026-01-01T00:00:00.000Z')",
    ).run("../../escape", task.id);
    expect(services.attachments.forTask(task.id)).toEqual([]);
    // Deleting by something that isn't a task id removes nothing (a real one is a UUID, never "..").
    await upload(task.id);
    const [first] = services.attachments.forTask(task.id);
    const folder = join(dirname(dirname(first!.path)), "not-an-id");
    mkdirSync(folder);
    services.attachments.removeFilesOf("not-an-id");
    expect(existsSync(folder)).toBe(true);
  });
});

describe("attachment cleanup", () => {
  it("deleting a project deletes its tasks' images", async () => {
    const { upload, task, project, services } = setup();
    await upload(task.id);
    const [stored] = services.attachments.forTask(task.id);
    services.projects.delete(project.id);
    expect(existsSync(stored!.path)).toBe(false);
  });

  it("a backup folder keeps files of its own under attachments/", async () => {
    const { upload, task, services } = setup();
    await upload(task.id);
    const [stored] = services.attachments.forTask(task.id);
    const dir = tempDir();
    mkdirSync(join(dir, "attachments"), { recursive: true });
    writeFileSync(join(dir, "attachments", "notes.txt"), "mine");
    writeDumpDir(dir, services.backup.dump(), attachmentsDirOf(stored!.path));
    expect(readFileSync(join(dir, "attachments", "notes.txt"), "utf8")).toBe("mine");
  });
});

describe("attachments in a backup", () => {
  it("round-trips the rows and the files, and drops files of deleted tasks", async () => {
    const { upload, task, services } = setup();
    await upload(task.id, png(100));
    await upload(null);
    const [stored] = services.attachments.forTask(task.id);
    const attachmentsDir = attachmentsDirOf(stored!.path);

    const dir = tempDir();
    const dump = services.backup.dump();
    // A task's images are in its bundle; the unclaimed one stays out.
    expect(dump.tasks.flatMap((b) => b.task_attachments)).toHaveLength(1);
    const first = writeDumpDir(dir, dump, attachmentsDir);
    expect(first.written).toContain(`attachments/${task.id}/${stored!.id}.png`);
    expect(writeDumpDir(dir, dump, attachmentsDir).written).toEqual([]);

    const dbPath = join(tempDir(), "data.sqlite");
    const to = tempDir();
    const result = restoreBoard(dbPath, readDumpDir(dir), { attachments: { from: dir, to } });
    expect(result.attachments).toEqual({ copied: 1, missing: 0 });
    expect(readFileSync(join(to, task.id, `${stored!.id}.png`))).toEqual(Buffer.from(png(100)));
    const restored = openDatabase(dbPath);
    try {
      const { path: _path, ...row } = stored!;
      expect(createRepos(restored).attachments.forTask(task.id)).toEqual([row]);
    } finally {
      restored.close();
    }

    services.tasks.update(task.id, { archived: true }, "user");
    services.tasks.delete(task.id, "user");
    const second = writeDumpDir(dir, services.backup.dump(), attachmentsDir);
    expect(second.removed).toContain(`attachments/${task.id}/${stored!.id}.png`);
    expect(existsSync(join(dir, "attachments"))).toBe(false);
  });

  it("puts one task's images back with it, and reports files a single-file dump lacks", async () => {
    const { upload, task, services } = setup();
    await upload(task.id);
    const [stored] = services.attachments.forTask(task.id);
    const dir = tempDir();
    const dump = services.backup.dump();
    writeDumpDir(dir, dump, attachmentsDirOf(stored!.path));

    services.tasks.update(task.id, { archived: true }, "user");
    services.tasks.delete(task.id, "user");
    expect(existsSync(stored!.path)).toBe(false);
    services.backup.restoreTask(dump, task.number, { actor: "user", attachmentsFrom: dir });
    expect(existsSync(stored!.path)).toBe(true);
    expect(services.attachments.forTask(task.id)).toHaveLength(1);

    const rows = dump.tasks.flatMap((b) => b.task_attachments);
    expect(copyAttachmentFiles(rows, null, tempDir())).toEqual({ copied: 0, missing: 1 });
    // A backup is untrusted: a row whose ids aren't ids is never turned into a path.
    expect(copyAttachmentFiles([{ ...rows[0]!, id: "../../escape" }], dir, tempDir())).toEqual({
      copied: 0,
      missing: 1,
    });
  });
});
