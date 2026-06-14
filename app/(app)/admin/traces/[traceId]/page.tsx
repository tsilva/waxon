import { AdminHydrator } from "../../AdminHydrator";
import { getAdminPageShellProps } from "../../adminPageShell";
import { AdminStaticView } from "../../AdminStaticView";

export const dynamic = "force-dynamic";

export default async function AdminTracePage({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  const { traceId } = await params;
  const { currentUser, initialViewState } = await getAdminPageShellProps();

  return (
    <>
      <AdminStaticView />
      <AdminHydrator
        currentUser={currentUser}
        initialViewState={initialViewState}
        selectedTraceId={traceId}
      />
    </>
  );
}
