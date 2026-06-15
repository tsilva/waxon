"use client";

import { useEffect, useState } from "react";
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
type AuthenticatedProvidersComponent = (props: {
  children: React.ReactNode;
}) => React.ReactElement;

export function TagsHydrator() {
  const [TagsPageClient, setTagsPageClient] =
    useState<TagsPageClientComponent | null>(null);
  const [AuthenticatedProviders, setAuthenticatedProviders] =
    useState<AuthenticatedProvidersComponent | null>(null);
  const [hydrationProps] = useState<TagsPageClientProps>({});

  useEffect(() => {
    let isCancelled = false;

    const loadTagsApp = () => {
      if (isCancelled || TagsPageClient) {
        return;
      }

      void Promise.all([
        import("./TagsPageClient"),
        import("@/app/AuthenticatedProviders"),
      ]).then(([tagsModule, providerModule]) => {
        if (!isCancelled) {
          setAuthenticatedProviders(
            () =>
              providerModule.AuthenticatedProviders as AuthenticatedProvidersComponent,
          );
          setTagsPageClient(() => tagsModule.default as TagsPageClientComponent);
        }
      });
    };

    loadTagsApp();

    return () => {
      isCancelled = true;
    };
  }, [TagsPageClient]);

  useEffect(() => {
    if (!TagsPageClient) {
      return;
    }

    const staticView = document.querySelector("[data-tags-static]");
    staticView?.setAttribute("inert", "");
  }, [TagsPageClient]);

  if (!TagsPageClient || !AuthenticatedProviders || !hydrationProps) {
    return null;
  }

  return (
    <>
      <style>{`[data-tags-static]{display:none}`}</style>
      <AuthenticatedProviders>
        <TagsPageClient {...hydrationProps} />
      </AuthenticatedProviders>
    </>
  );
}
