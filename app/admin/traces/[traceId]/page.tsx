import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { getCurrentUser } from "@/app/lib/auth";
import { listLlmTraceInteractions } from "@/app/lib/llmTraceStore";
import { peekNextQuestion } from "@/app/lib/reviewQueue";
import { AdminPageClient } from "../../AdminPageClient";
import {
  ADMIN_VIEW_STATE_COOKIE,
  parseAdminViewStateCookie,
} from "../../adminViewStateCookie";

export const dynamic = "force-dynamic";

export default async function AdminTracePage({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  const currentUser = await getCurrentUser();

  if (!isAdminEmail(currentUser.email)) {
    notFound();
  }

  const { traceId } = await params;
  const cookieStore = await cookies();
  const initialViewState = parseAdminViewStateCookie(
    cookieStore.get(ADMIN_VIEW_STATE_COOKIE)?.value,
  );

  return (
    <AdminPageClient
      currentUser={currentUser}
      initialInteractions={await listLlmTraceInteractions()}
      initialDueCount={(await peekNextQuestion()).queueRemaining}
      initialViewState={initialViewState}
      selectedTraceId={traceId}
    />
  );
}
