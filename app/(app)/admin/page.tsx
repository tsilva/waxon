import { AppStaticLoadingView } from "../AppStaticLoadingView";
import { AdminHydrator } from "./AdminHydrator";
import { getAdminPageShellProps } from "./adminPageShell";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { currentUser, initialViewState } = await getAdminPageShellProps();

  return (
    <>
      <AppStaticLoadingView staticView="admin" />
      <AdminHydrator
        currentUser={currentUser}
        initialViewState={initialViewState}
      />
    </>
  );
}
