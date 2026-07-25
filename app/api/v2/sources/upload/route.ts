import { createHash } from "node:crypto";
import { del, put } from "@vercel/blob";
import { after, NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import { consumeUserRateLimit } from "@/app/lib/apiLimits";
import { v2Error } from "@/app/lib/v2/http";
import { runPendingJobs } from "@/app/lib/v2/service";
import { createSource } from "@/app/lib/v2/sources";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
]);

export async function POST(request: Request) {
  let uploadedUrl: string | null = null;
  try {
    const user = await getCurrentUser();
    const limited = consumeUserRateLimit({
      userId: user.id,
      route: "v2-source-upload",
      rules: [{ name: "hour", max: 10, windowMs: 60 * 60_000 }],
    });
    if (limited) {
      return limited;
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new Error("A source file is required.");
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error("The source is larger than 20 MB.");
    }
    const type = file.type || "text/plain";
    const isTextName = /\.(txt|md|markdown|csv)$/iu.test(file.name);
    const isPdf = type === "application/pdf" || /\.pdf$/iu.test(file.name);
    if (!isPdf && !isTextName && !ALLOWED_TYPES.has(type)) {
      throw new Error("Only PDF, Markdown, CSV, and text files are allowed.");
    }
    const safeName =
      file.name
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}._-]+/gu, "-")
        .slice(-180) || "source";
    const contentChecksum = createHash("sha256")
      .update(Buffer.from(await file.arrayBuffer()))
      .digest("hex");
    const blob = await put(`sources/${user.id}/${safeName}`, file, {
      access: "private",
      addRandomSuffix: true,
      contentType: type,
    });
    uploadedUrl = blob.url;
    const result = await createSource({
      userId: user.id,
      kind: isPdf ? "pdf" : "text",
      title:
        typeof form.get("title") === "string" && String(form.get("title")).trim()
          ? String(form.get("title")).slice(0, 300)
          : file.name,
      objectUrl: blob.url,
      mimeType: type,
      byteSize: file.size,
      contentChecksum,
    });
    if (result.reused) {
      await del(blob.url);
    }
    uploadedUrl = null;
    after(() => runPendingJobs({ userId: user.id, limit: 2 }));
    return NextResponse.json({ ok: true, ...result }, { status: 202 });
  } catch (error) {
    if (uploadedUrl) {
      await del(uploadedUrl).catch(() => undefined);
    }
    return v2Error(error);
  }
}
