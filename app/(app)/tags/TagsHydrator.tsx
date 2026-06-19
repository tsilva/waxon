"use client";

import { AuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";
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

type TagsPageClientComponent = (props: TagsPageClientProps) => React.ReactElement;

function loadTagsPageClient(): Promise<TagsPageClientComponent> {
  return import("./TagsPageClient").then(
    (tagsModule) => tagsModule.default as TagsPageClientComponent,
  );
}

export function TagsHydrator() {
  return (
    <AuthenticatedClientHydrator
      componentProps={{}}
      loadClient={loadTagsPageClient}
      staticSelector="[data-tags-static]"
    />
  );
}
