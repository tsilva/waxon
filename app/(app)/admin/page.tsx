import { AdminHydrator } from "./AdminHydrator";
import { getAdminPageShellProps } from "./adminPageShell";
import { AdminStaticView } from "./AdminStaticView";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { currentUser, initialViewState } = await getAdminPageShellProps();

  return (
    <>
      <AdminStaticView />
      <AdminHydrator
        currentUser={currentUser}
        initialViewState={initialViewState}
      />
    </>
  );
}
