import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { getCurrentUser } from "@/app/lib/auth";
import {
  ADMIN_VIEW_STATE_COOKIE,
  parseAdminViewStateCookie,
} from "./adminViewStateCookie";

export async function getAdminPageShellProps() {
  const currentUser = await getCurrentUser();

  if (!isAdminEmail(currentUser.email)) {
    notFound();
  }

  const cookieStore = await cookies();
  const initialViewState = parseAdminViewStateCookie(
    cookieStore.get(ADMIN_VIEW_STATE_COOKIE)?.value,
  );

  return {
    currentUser,
    initialViewState,
  };
}
