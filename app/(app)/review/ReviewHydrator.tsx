"use client";

import { createAuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";

export const ReviewHydrator =
  createAuthenticatedClientHydrator({
    loadClient: () => import("./ReviewApp").then((module) => module.default),
    staticSelector: "[data-review-static]",
  });
