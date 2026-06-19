export function libraryTagHref(slug: string): string {
  const params = new URLSearchParams();

  params.set("tag", slug);
  return `/library?${params.toString()}`;
}
