export type ReviewToolbarTab =
  | "review"
  | "library"
  | "stats"
  | "admin";

export function reviewToolbarTabFromPathname(
  pathname: string,
): ReviewToolbarTab {
  if (pathname.startsWith("/library")) return "library";
  if (pathname.startsWith("/stats")) return "stats";
  if (pathname.startsWith("/admin")) return "admin";
  return "review";
}
