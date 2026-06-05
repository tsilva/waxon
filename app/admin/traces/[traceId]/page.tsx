import { notFound } from "next/navigation";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { getCurrentUser } from "@/app/lib/auth";
import { listLlmTraceInteractions } from "@/app/lib/llmTraceStore";
import { AdminPageClient } from "../../AdminPageClient";

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

  return (
    <AdminPageClient
      currentUser={currentUser}
      initialInteractions={await listLlmTraceInteractions()}
      selectedTraceId={traceId}
    />
  );
}
