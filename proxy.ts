import {
  clerkMiddleware,
  createRouteMatcher,
} from "@clerk/nextjs/server";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";

const isProtectedRoute = createRouteMatcher([
  "/admin(.*)",
  "/api(.*)",
  "/decks(.*)",
  "/review(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  if (isProtectedRoute(request) && !isLocalTestAuthEnabled()) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/__clerk/:path*",
    "/(api|trpc)(.*)",
  ],
};
