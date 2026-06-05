import { NextResponse } from "next/server";
import { peekNextQuestion } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const excludeQuestion = url.searchParams.get("excludeQuestion");

  return NextResponse.json(await peekNextQuestion({ excludeQuestion }));
}
