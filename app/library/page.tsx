import LibraryPageClient from "./LibraryPageClient";
import { isAdminEmail } from "@/app/lib/adminAccess";
import { getCurrentUser } from "@/app/lib/auth";
import { listConceptTags } from "@/app/lib/conceptTags";
import { listQuestionBankItems } from "@/app/lib/questionBank";

export default async function LibraryPage() {
  const user = await getCurrentUser();
  const [questionBank, conceptTags] = await Promise.all([
    listQuestionBankItems({ userId: user.id }),
    listConceptTags({ userId: user.id }),
  ]);

  return (
    <LibraryPageClient
      initialQuestionBank={questionBank}
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
