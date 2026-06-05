import { notFound } from "next/navigation";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { getCurrentUser } from "@/app/lib/auth";
import { listLlmTraceInteractions } from "@/app/lib/llmTraceStore";
import { AdminPageClient } from "./AdminPageClient";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const currentUser = await getCurrentUser();

  if (!isAdminEmail(currentUser.email)) {
    notFound();
  }

  return (
    <AdminPageClient
      currentUser={currentUser}
      initialInteractions={await listLlmTraceInteractions()}
    />
  );
}
