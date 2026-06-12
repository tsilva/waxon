import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import {
  listQuestionBankItems,
  type QuestionBankStatusFilter,
} from "@/app/lib/questionBank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readPositiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value ?? "");

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInteger(value: string | null): number {
  const parsed = Number(value ?? "");

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function readStatus(value: string | null): QuestionBankStatusFilter {
  return value === "due" || value === "flagged" || value === "untagged"
    ? value
    : "all";
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  const url = new URL(request.url);

  return NextResponse.json(
    await listQuestionBankItems({
      userId: user.id,
      query: url.searchParams.get("q"),
      tagSlug: url.searchParams.get("tag"),
      status: readStatus(url.searchParams.get("status")),
      limit: readPositiveInteger(url.searchParams.get("limit"), 50),
      offset: readNonNegativeInteger(url.searchParams.get("offset")),
    }),
  );
}
