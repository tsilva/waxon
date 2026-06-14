import { AdminPageClient } from "./AdminPageClient";
import { getAdminPageShellProps } from "./adminPageShell";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { currentUser, initialViewState } = await getAdminPageShellProps();

  return (
    <AdminPageClient
      currentUser={currentUser}
      initialInteractions={[]}
      initialDueCount={0}
      initialViewState={initialViewState}
    />
  );
}
