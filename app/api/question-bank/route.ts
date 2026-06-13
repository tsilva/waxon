import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import {
  listQuestionBankItems,
  normalizeQuestionBankSort,
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
      tagSlugs: url.searchParams.getAll("tag"),
      status: readStatus(url.searchParams.get("status")),
      sort: normalizeQuestionBankSort(url.searchParams.get("sort")),
      limit: readPositiveInteger(url.searchParams.get("limit"), 50),
      offset: readNonNegativeInteger(url.searchParams.get("offset")),
    }),
  );
}
