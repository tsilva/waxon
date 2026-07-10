"use client";

import { createAuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";

export const TagsHydrator =
  createAuthenticatedClientHydrator({
    loadClient: () => import("./TagsPageClient").then((module) => module.default),
    staticSelector: "[data-tags-static]",
  });
