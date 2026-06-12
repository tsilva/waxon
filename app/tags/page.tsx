import TagsPageClient from "./TagsPageClient";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { getCurrentUser } from "@/app/lib/auth";
import { listConceptTags } from "@/app/lib/conceptTags";

export default async function TagsPage() {
  const user = await getCurrentUser();
  const conceptTags = await listConceptTags({ userId: user.id });

  return (
    <TagsPageClient
      initialConceptTags={conceptTags}
      initialUser={{
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
      }}
      showAdmin={isAdminEmail(user.email)}
    />
  );
}
