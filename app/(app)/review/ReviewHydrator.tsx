"use client";

import { createAuthenticatedClientHydrator } from "../AuthenticatedClientHydrator";
import type { ReviewAppProps } from "./ReviewApp";

export const ReviewHydrator =
  createAuthenticatedClientHydrator<ReviewAppProps>({
    loadClient: () => import("./ReviewApp").then((module) => module.default),
    staticSelector: "[data-review-static]",
  });
