import { authenticateRequestRequireUser } from "@/lib/api-auth";
import { reportError } from "@/lib/observability";
import { getRequestByIdForUser } from "@/lib/supabase/requests";
import {
  contentDisposition,
  getObject,
  isObjectStorageConfigured,
} from "@/lib/storage/object-store";

/**
 * GET /api/requests/{id}/raw: a captured email's exact message as
 * message/rfc822. From object storage when the receiver kept it there
 * (`email.stored`), whatever its size; otherwise from the database copy,
 * which exists only for messages up to 1 MiB.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequestRequireUser(request);
  if (!auth.success) return auth.response;

  const { id } = await params;
  try {
    const record = await getRequestByIdForUser(auth.userId, id);
    if (!record) return Response.json({ error: "not_found" }, { status: 404 });
    if (record.kind !== "email" || !record.email) {
      return Response.json({ error: "not_an_email" }, { status: 400 });
    }

    const headers = {
      "content-type": "message/rfc822",
      "content-disposition": contentDisposition(`email-${record.id.slice(0, 8)}.eml`),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    };

    if (record.email.stored && isObjectStorageConfigured()) {
      const object = await getObject(`m/${record.id}/raw.eml`);
      if (object?.body) {
        const length = object.headers.get("content-length");
        return new Response(object.body, {
          headers: length ? { ...headers, "content-length": length } : headers,
        });
      }
    }

    if (record.email.truncated.raw) {
      return Response.json(
        { error: "not_kept", message: "The full message was larger than 1 MiB and was not kept." },
        { status: 404 }
      );
    }
    const bytes = record.bodyRaw
      ? Buffer.from(record.bodyRaw, "base64")
      : Buffer.from(record.body ?? "", "utf8");
    return new Response(bytes, { headers });
  } catch (error) {
    reportError("Failed to read a raw email", error);
    return Response.json({ error: "Failed to read the message" }, { status: 500 });
  }
}
