import { AppStaticLoadingView } from "../../../AppStaticLoadingView";
import { AdminHydrator } from "../../AdminHydrator";
import { getAdminPageShellProps } from "../../adminPageShell";

export const dynamic = "force-dynamic";

export default async function AdminTracePage({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  const { traceId } = await params;
  const { initialViewState } = await getAdminPageShellProps();

  return (
    <>
      <AppStaticLoadingView staticView="admin" />
      <AdminHydrator
        initialViewState={initialViewState}
        selectedTraceId={traceId}
      />
    </>
  );
}
