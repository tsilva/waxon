import { AdminPageClient } from "../../AdminPageClient";
import { getAdminPageShellProps } from "../../adminPageShell";

export const dynamic = "force-dynamic";

export default async function AdminTracePage({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  const { traceId } = await params;
  const { currentUser, initialViewState } = await getAdminPageShellProps();

  return (
    <AdminPageClient
      currentUser={currentUser}
      initialInteractions={[]}
      initialDueCount={0}
      initialViewState={initialViewState}
      selectedTraceId={traceId}
    />
  );
}
