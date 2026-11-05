import type { MetadataRoute } from "next";

import { getSiteUrl } from "./site-url";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/privacy-policy", "/terms-and-conditions"],
        disallow: ["/api"],
      },
    ],
    sitemap: new URL("/sitemap.xml", getSiteUrl()).href,
  };
}
