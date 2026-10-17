import { MAX_ATTACHMENT_BYTES, attachmentUrl } from "@repo/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { AppError } from "../../errors.ts";
import { handle, idParam, parseQuery } from "../respond.ts";

const UploadQuery = z.object({
  /** Omitted for an image pasted into the new-task box, whose task doesn't exist yet. */
  taskId: z.string().min(1).optional(),
  filename: z.string().max(200).optional(),
});

/** /api/attachments: images pasted into a task's text. The body of an upload is the image itself. */
export function registerAttachmentRoutes(app: Hono, { services }: AppContext): void {
  app.post(
    "/api/attachments",
    handle(async (c) => {
      const { taskId, filename } = parseQuery(c, UploadQuery);
      // Refused before the body is read; the service checks the real size again.
      if (Number(c.req.header("content-length") ?? 0) > MAX_ATTACHMENT_BYTES) {
        throw new AppError("VALIDATION", `The image is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
      }
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const mime = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      const attachment = services.attachments.upload({
        taskId: taskId ?? null,
        filename: filename ?? "image",
        mime,
        bytes,
      });
      return c.json({ ...attachment, url: attachmentUrl(attachment.id) }, 201);
    }),
  );
  app.get(
    "/api/attachments/:id",
    handle((c) => {
      const { attachment, bytes } = services.attachments.read(idParam(c));
      return c.body(new Uint8Array(bytes), 200, {
        "content-type": attachment.mime,
        // The type was checked on upload; these keep a browser from treating the bytes as anything else.
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
        // An image's bytes never change under its id.
        "cache-control": "private, max-age=31536000, immutable",
      });
    }),
  );
}
