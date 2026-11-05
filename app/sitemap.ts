import type { MetadataRoute } from "next";

import { getSiteUrl } from "./site-url";

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = getSiteUrl();
  return ["/", "/privacy-policy", "/terms-and-conditions"].map((path) => ({
    url: new URL(path, siteUrl).href,
  }));
}
