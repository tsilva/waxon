"use client";

import { createAuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";
import type { ConceptTagSummary } from "@/app/lib/conceptTags";

type UserProfile = {
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

type TagsPageClientProps = {
  initialConceptTags?: ConceptTagSummary[] | null;
  initialUser?: UserProfile | null;
  showAdmin?: boolean;
};

export const TagsHydrator =
  createAuthenticatedClientHydrator<TagsPageClientProps>({
    loadClient: () => import("./TagsPageClient").then((module) => module.default),
    staticSelector: "[data-tags-static]",
  });
