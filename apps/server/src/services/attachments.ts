import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  attachmentExtension,
  attachmentIdsIn,
  isAttachmentPathId,
  MAX_ATTACHMENT_BYTES,
  type TaskAttachment,
} from "@repo/contracts";
import { nowIso } from "../db/database.ts";
import { AppError, notFound } from "../errors.ts";
import type { Core } from "./core.ts";

/** Where an image uploaded for a task that doesn't exist yet waits. */
const PENDING_DIR = "_pending";
/** How long an image no task claimed is kept. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
/** The cleanup also runs on an upload when this long has passed since the last one. */
const SWEEP_EVERY_MS = 60 * 60 * 1000;

export interface UploadInput {
  /** The task it belongs to; null for the new-task box, whose task is created later (see `claim`). */
  taskId: string | null;
  filename: string;
  mime: string;
  bytes: Uint8Array;
}

export interface AttachmentsService {
  /** Stores an image. Refuses other types, anything over the size cap, and bytes that aren't the type they claim. */
  upload(input: UploadInput): TaskAttachment;
  get(id: string): TaskAttachment;
  /** The image's bytes. */
  read(id: string): { attachment: TaskAttachment; bytes: Buffer };
  /** The task's images with their absolute paths on disk, for agents that can open files. */
  forTask(taskId: string): Array<TaskAttachment & { path: string }>;
  /** Gives the unclaimed images that `text` refers to to the task. */
  claim(taskId: string, text: string | null | undefined): void;
  /**
   * The images pasted into a launch dialog, in order, with their files' paths. Refuses an id that isn't an image on
   * disk, or one that belongs to a task other than `taskId` (with no task, any claimed one).
   */
  forLaunch(ids: readonly string[], taskId: string | null): Array<TaskAttachment & { path: string }>;
  /** Gives these unclaimed images to the task, and returns them where they now are. */
  claimIds(taskId: string, ids: readonly string[]): Array<TaskAttachment & { path: string }>;
  /** Deletes a deleted task's files. Call after the delete committed. */
  removeFilesOf(taskId: string): void;
  /** Removes unclaimed images older than a day, and files of tasks that no longer exist. */
  sweep(): void;
}

/** True when the leading bytes are those of the image type `mime` claims, so a file can't pass as something else. */
export function matchesMime(mime: string, b: Uint8Array): boolean {
  const at = (offset: number, text: string) => Array.from(text).every((ch, i) => b[offset + i] === ch.charCodeAt(0));
  switch (mime) {
    case "image/png":
      return b[0] === 0x89 && at(1, "PNG");
    case "image/jpeg":
      return b[0] === 0xff && b[1] === 0xd8;
    case "image/gif":
      return at(0, "GIF8");
    case "image/webp":
      return at(0, "RIFF") && at(8, "WEBP");
    default:
      return false;
  }
}

export function createAttachmentsService(core: Core, dir: string): AttachmentsService {
  const { repos } = core;
  /**
   * Where the image's file is; null when the row doesn't describe one. Rows a restored backup brought are
   * untrusted: ids and type become path segments, so anything but a UUID and a known type is refused.
   */
  const pathOf = (a: TaskAttachment): string | null => {
    const ext = attachmentExtension(a.mime);
    if (!ext || !isAttachmentPathId(a.id) || (a.taskId !== null && !isAttachmentPathId(a.taskId))) return null;
    return join(dir, a.taskId ?? PENDING_DIR, `${a.id}.${ext}`);
  };
  let lastSweep = 0;

  const get = (id: string): TaskAttachment => {
    const attachment = repos.attachments.get(id);
    if (!attachment) throw notFound("Attachment", id);
    return attachment;
  };

  /** Moves an unclaimed image's file and row to the task; one already claimed (or gone) is left alone. */
  const moveToTask = (id: string, taskId: string) => {
    const attachment = repos.attachments.get(id);
    if (!attachment || attachment.taskId !== null) return;
    const from = pathOf(attachment);
    const to = pathOf({ ...attachment, taskId });
    if (from && to) {
      mkdirSync(join(to, ".."), { recursive: true });
      if (existsSync(from)) renameSync(from, to);
    }
    repos.attachments.setTask(id, taskId);
  };

  return {
    upload({ taskId, filename, mime, bytes }) {
      // Images nobody claimed, and folders of tasks that are gone, are cleaned up now and then, not only at startup.
      if (Date.now() - lastSweep > SWEEP_EVERY_MS) this.sweep();
      if (!attachmentExtension(mime)) {
        throw new AppError("VALIDATION", `Only PNG, JPEG, GIF and WebP images can be attached, not ${mime || "this"}`);
      }
      if (bytes.length === 0) throw new AppError("VALIDATION", "The image is empty");
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        throw new AppError("VALIDATION", `The image is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
      }
      if (!matchesMime(mime, bytes)) throw new AppError("VALIDATION", `The file is not a valid ${mime} image`);
      return core.write((fx) => {
        if (taskId && !repos.tasks.get(taskId)) throw notFound("Task", taskId);
        const attachment: TaskAttachment = {
          id: randomUUID(),
          taskId,
          filename: filename.replace(/[\\/\r\n]/g, "_").slice(0, 200) || "image",
          mime,
          size: bytes.length,
          createdAt: nowIso(),
        };
        const path = pathOf(attachment)!;
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, bytes);
        try {
          repos.attachments.insert(attachment);
        } catch (error) {
          rmSync(path, { force: true });
          throw error;
        }
        if (taskId) fx.detail(taskId);
        return attachment;
      });
    },

    get,

    read(id) {
      const attachment = get(id);
      const path = pathOf(attachment);
      if (!path || !existsSync(path)) throw notFound("Attachment file", id);
      return { attachment, bytes: readFileSync(path) };
    },

    forTask: (taskId) =>
      repos.attachments.forTask(taskId).flatMap((a) => {
        const path = pathOf(a);
        return path ? [{ ...a, path }] : [];
      }),

    claim(taskId, text) {
      for (const id of attachmentIdsIn(text)) moveToTask(id, taskId);
    },

    forLaunch(ids, taskId) {
      return [...new Set(ids)].map((id) => {
        const attachment = repos.attachments.get(id);
        const path = attachment ? pathOf(attachment) : null;
        if (!attachment || !path || !existsSync(path)) {
          throw new AppError("VALIDATION", "An image was removed before the launch; paste it again");
        }
        if (attachment.taskId !== null && attachment.taskId !== taskId) {
          throw new AppError("VALIDATION", "An image belongs to another task");
        }
        return { ...attachment, path };
      });
    },

    claimIds(taskId, ids) {
      core.write((fx) => {
        for (const id of ids) moveToTask(id, taskId);
        fx.detail(taskId);
      });
      return this.forLaunch(ids, taskId);
    },

    removeFilesOf(taskId) {
      if (!isAttachmentPathId(taskId)) return;
      rmSync(join(dir, taskId), { recursive: true, force: true });
    },

    sweep() {
      lastSweep = Date.now();
      const cutoff = new Date(core.now().getTime() - PENDING_TTL_MS).toISOString();
      for (const attachment of repos.attachments.orphansBefore(cutoff)) {
        const path = pathOf(attachment);
        if (path) rmSync(path, { force: true });
        repos.attachments.delete(attachment.id);
      }
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        if (name !== PENDING_DIR && !repos.tasks.get(name)) rmSync(join(dir, name), { recursive: true, force: true });
      }
      // Files waiting for a task whose row is gone: a whole-board restore swaps the database, and a crash between
      // writing a file and its row leaves one too. Old enough that an upload still being recorded isn't caught.
      const pending = join(dir, PENDING_DIR);
      if (!existsSync(pending)) return;
      for (const name of readdirSync(pending)) {
        const path = join(pending, name);
        if (repos.attachments.get(name.split(".")[0]!) || statSync(path).mtimeMs > Date.now() - PENDING_TTL_MS)
          continue;
        rmSync(path, { force: true });
      }
    },
  };
}
