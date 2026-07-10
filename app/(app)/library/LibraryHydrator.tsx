"use client";

import { createAuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";

export const LibraryHydrator =
  createAuthenticatedClientHydrator({
    loadClient: () =>
      import("./LibraryPageClient").then((module) => module.default),
    staticSelector: "[data-library-static]",
  });
