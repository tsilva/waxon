import { NextResponse } from "next/server";
import { getCurrentUser } from "@/app/lib/auth";
import { waxonApplication } from "@/app/lib/v2/application";
import { v2Error } from "@/app/lib/v2/http";

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    const url = new URL(request.url);
    return NextResponse.json(
      await waxonApplication.forLearner(user.id).tags.list({
        search: url.searchParams.get("search") ?? "",
        cursor: url.searchParams.get("cursor") ?? undefined,
      }),
    );
  } catch (error) {
    return v2Error(error);
  }
}
