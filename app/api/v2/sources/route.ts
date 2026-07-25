import { after, NextResponse } from "next/server";
import {
  consumeUserRateLimit,
  readJsonBodyWithLimit,
} from "@/app/lib/apiLimits";
import { getCurrentUser } from "@/app/lib/auth";
import { isRecord, v2Error } from "@/app/lib/v2/http";
import { runPendingJobs } from "@/app/lib/v2/service";
import {
  createGroundedTopicSource,
  createSource,
} from "@/app/lib/v2/sources";

export async function POST(request: Request) {
  const parsed = await readJsonBodyWithLimit(request, 2 * 1024 * 1024);
  if (!parsed.ok) {
    return parsed.response;
  }
  try {
    const user = await getCurrentUser();
    const limited = consumeUserRateLimit({
      userId: user.id,
      route: "v2-source-capture",
      rules: [{ name: "hour", max: 20, windowMs: 60 * 60_000 }],
    });
    if (limited) {
      return limited;
    }
    if (!isRecord(parsed.value)) {
      throw new Error("Source material is required.");
    }
    const kind =
      parsed.value.kind === "url" ||
      parsed.value.kind === "topic" ||
      parsed.value.kind === "paste"
        ? parsed.value.kind
        : "paste";
    const title =
      typeof parsed.value.title === "string"
        ? parsed.value.title.slice(0, 300)
        : "";
    const rawText =
      typeof parsed.value.text === "string"
        ? parsed.value.text.slice(0, 1_000_000)
        : null;
    const originalUrl =
      typeof parsed.value.url === "string"
        ? parsed.value.url.slice(0, 4_000)
        : null;
    if (
      (kind === "url" && !originalUrl) ||
      (kind === "topic" && (!rawText || rawText.trim().length < 3)) ||
      (kind === "paste" && (!rawText || rawText.trim().length < 40))
    ) {
      throw new Error(
        kind === "topic"
          ? "Describe the topic you want to cover."
          : "Add a URL or at least 40 characters of source text.",
      );
    }
    const result =
      kind === "topic"
        ? await createGroundedTopicSource({
            userId: user.id,
            query: rawText ?? "",
          })
        : await createSource({
            userId: user.id,
            kind,
            title: title || originalUrl || "Pasted source",
            rawText: kind === "url" ? null : rawText,
            originalUrl: kind === "url" ? originalUrl : null,
          });
    after(() => runPendingJobs({ userId: user.id, limit: 2 }));
    return NextResponse.json({ ok: true, ...result }, { status: 202 });
  } catch (error) {
    return v2Error(error);
  }
}
