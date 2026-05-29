import { NextResponse } from "next/server";
import { skipQuestion } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json()) as {
    question?: unknown;
  };

  if (typeof body.question !== "string") {
    return NextResponse.json(
      {
        error: "Question is required.",
      },
      {
        status: 400,
      },
    );
  }

  return NextResponse.json(await skipQuestion({ question: body.question }));
}
