import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import {
  parseQuestionBankQuery,
  queryQuestionBankItems,
} from "@/app/lib/questionBank";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  const url = new URL(request.url);

  return NextResponse.json(
    await queryQuestionBankItems({
      userId: user.id,
      ...parseQuestionBankQuery(url.searchParams),
    }),
  );
}
