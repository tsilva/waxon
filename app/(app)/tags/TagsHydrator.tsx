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

async function loadTagsHydrationProps(): Promise<TagsPageClientProps> {
  const [tagsResult, userResult] = await Promise.allSettled([
    fetch("/api/concept-tags", { cache: "no-store" }),
    fetch("/api/user", { cache: "no-store" }),
  ]);
  const tagsData =
    tagsResult.status === "fulfilled" && tagsResult.value.ok
      ? ((await tagsResult.value.json()) as { conceptTags?: ConceptTagSummary[] })
      : null;
  const initialUser =
    userResult.status === "fulfilled" && userResult.value.ok
      ? ((await userResult.value.json()) as UserProfile)
      : null;

  return {
    initialConceptTags: tagsData?.conceptTags ?? null,
    initialUser,
  };
}

export function TagsHydrator() {
  const [TagsPageClient, setTagsPageClient] =
    useState<TagsPageClientComponent | null>(null);
  const [AuthenticatedProviders, setAuthenticatedProviders] =
    useState<AuthenticatedProvidersComponent | null>(null);
  const [hydrationProps, setHydrationProps] =
    useState<TagsPageClientProps | null>(null);

  useEffect(() => {
    let isCancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const loadTagsApp = () => {
      if (isCancelled || TagsPageClient) {
        return;
      }

      void Promise.all([
        import("./TagsPageClient"),
        import("@/app/AuthenticatedProviders"),
        loadTagsHydrationProps(),
      ]).then(([tagsModule, providerModule, nextProps]) => {
        if (!isCancelled) {
          setHydrationProps(nextProps);
          setAuthenticatedProviders(
            () =>
              providerModule.AuthenticatedProviders as AuthenticatedProvidersComponent,
          );
          setTagsPageClient(() => tagsModule.default as TagsPageClientComponent);
        }
      });
    };

    const loadOnInteraction = () => loadTagsApp();

    window.addEventListener("pointerdown", loadOnInteraction, { once: true });
    window.addEventListener("keydown", loadOnInteraction, { once: true });
    timeoutId = globalThis.setTimeout(loadTagsApp, 9000);

    return () => {
      isCancelled = true;
      window.removeEventListener("pointerdown", loadOnInteraction);
      window.removeEventListener("keydown", loadOnInteraction);

      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
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
