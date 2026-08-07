export type ReviewToolbarTab =
  | "review"
  | "library"
  | "admin";

export function reviewToolbarTabFromPathname(
  pathname: string,
): ReviewToolbarTab {
  if (pathname.startsWith("/library")) return "library";
  if (pathname.startsWith("/admin")) return "admin";
  return "review";
}
