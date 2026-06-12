import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import {
  listConceptTags,
  listQuestionsForConceptTag,
  mergeConceptTags,
  normalizeConceptSlug,
  renameConceptTag,
  setConceptTagActive,
} from "@/app/lib/conceptTags";
import { invalidateReviewQueue } from "@/app/lib/reviewQueue";
import { readJsonBodyWithLimit } from "@/app/lib/apiLimits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CONCEPT_TAG_BODY_BYTES = 8 * 1024;

export async function GET(request: Request) {
  const user = await getCurrentUser();
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug")?.trim();

  if (slug) {
    return NextResponse.json({
      questions: await listQuestionsForConceptTag({
        userId: user.id,
        slug,
      }),
    });
  }

  return NextResponse.json({
    conceptTags: await listConceptTags({ userId: user.id }),
  });
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  const parsed = await readJsonBodyWithLimit(request, MAX_CONCEPT_TAG_BODY_BYTES);

  if (!parsed.ok) {
    return parsed.response;
  }

  const payload =
    parsed.value && typeof parsed.value === "object"
      ? (parsed.value as Record<string, unknown>)
      : {};
  const action = typeof payload.action === "string" ? payload.action : "";
  const slug = normalizeConceptSlug(payload.slug);

  try {
    if (action === "set-active") {
      const active = payload.active === true;
      const conceptTag = await setConceptTagActive({
        userId: user.id,
        slug,
        active,
      });

      invalidateReviewQueue(user.id);
      return NextResponse.json({ ok: true, conceptTag });
    }

    if (action === "rename") {
      const conceptTag = await renameConceptTag({
        userId: user.id,
        fromSlug: slug,
        toSlug: normalizeConceptSlug(payload.toSlug),
      });

      invalidateReviewQueue(user.id);
      return NextResponse.json({ ok: true, conceptTag });
    }

    if (action === "merge") {
      const conceptTag = await mergeConceptTags({
        userId: user.id,
        fromSlug: slug,
        toSlug: normalizeConceptSlug(payload.toSlug),
      });

      invalidateReviewQueue(user.id);
      return NextResponse.json({ ok: true, conceptTag });
    }

    return NextResponse.json(
      { ok: false, error: "Unsupported concept tag action." },
      { status: 400 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not update concept tag.";

    return NextResponse.json(
      { ok: false, error: message },
      {
        status:
          message.includes("not found")
            ? 404
            : message.includes("invalid")
              ? 400
              : 500,
      },
    );
  }
}
