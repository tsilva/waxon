import { getCurrentUser } from "@/app/lib/auth";
import { listQuestionBankItems } from "@/app/lib/questionBank";
import { LibraryHydrator } from "./LibraryHydrator";
import { LibraryStaticView } from "./LibraryStaticView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  const user = await getCurrentUser();
  const initialQuestionBank = await listQuestionBankItems({
    userId: user.id,
    limit: 6,
  });

  return (
    <>
      <LibraryStaticView
        initialQuestionBank={initialQuestionBank}
        userEmail={user.email}
      />
      <LibraryHydrator
        initialQuestionBank={initialQuestionBank}
        initialUser={{
          displayName: user.displayName,
          email: user.email,
          avatarUrl: user.avatarUrl,
        }}
      />
    </>
  );
}
