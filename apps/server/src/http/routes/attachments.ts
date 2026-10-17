import { MAX_ATTACHMENT_BYTES, attachmentUrl } from "@repo/contracts";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { AppError } from "../../errors.ts";
import { errorResponse, handle, idParam, parseQuery } from "../respond.ts";

const UploadQuery = z.object({
  /** Omitted for an image pasted into the new-task box, whose task doesn't exist yet. */
  taskId: z.string().min(1).optional(),
  filename: z.string().max(200).optional(),
});

/** /api/attachments: images pasted into a task's text. The body of an upload is the image itself. */
export function registerAttachmentRoutes(app: Hono, { services }: AppContext): void {
  app.post(
    "/api/attachments",
    // Stops reading a body that runs past the cap, whatever its headers say; the service checks the size again.
    bodyLimit({
      maxSize: MAX_ATTACHMENT_BYTES,
      onError: (c) =>
        errorResponse(c, new AppError("VALIDATION", `The image is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`)),
    }),
    handle(async (c) => {
      const { taskId, filename } = parseQuery(c, UploadQuery);
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
