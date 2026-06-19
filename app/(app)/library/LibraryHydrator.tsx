"use client";

import { AuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";
import type { ConceptTagSummary } from "@/app/lib/conceptTags";
import type { QuestionBankPage } from "@/app/lib/questionBank";

type UserProfile = {
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

type LibraryPageClientProps = {
  initialQuestionBank?: QuestionBankPage | null;
  initialConceptTags?: ConceptTagSummary[] | null;
  initialUser?: UserProfile | null;
  showAdmin?: boolean;
};

type LibraryPageClientComponent = (
  props: LibraryPageClientProps,
) => React.ReactElement;

function loadLibraryPageClient(): Promise<LibraryPageClientComponent> {
  return import("./LibraryPageClient").then(
    (libraryModule) => libraryModule.default as LibraryPageClientComponent,
  );
}

export function LibraryHydrator(initialProps: LibraryPageClientProps) {
  return (
    <AuthenticatedClientHydrator
      componentProps={initialProps}
      loadClient={loadLibraryPageClient}
      staticSelector="[data-library-static]"
    />
  );
}
