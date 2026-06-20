"use client";

import { createAuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";
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

export const LibraryHydrator =
  createAuthenticatedClientHydrator<LibraryPageClientProps>({
    loadClient: () =>
      import("./LibraryPageClient").then((module) => module.default),
    staticSelector: "[data-library-static]",
  });
