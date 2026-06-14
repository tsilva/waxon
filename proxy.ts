import {
  clerkMiddleware,
  createRouteMatcher,
} from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isLocalTestAuthEnabled } from "@/app/lib/localTestAuth";

const isProtectedRoute = createRouteMatcher([
  "/admin(.*)",
  "/api(.*)",
  "/decks(.*)",
  "/learn(.*)",
  "/library(.*)",
  "/review(.*)",
  "/stats(.*)",
]);

const isPublicStaticPage = createRouteMatcher([
  "/",
  "/privacy-policy",
  "/robots.txt",
  "/sitemap.xml",
  "/terms-and-conditions",
]);

const handleClerkMiddleware = clerkMiddleware(async (auth, request) => {
  if (isProtectedRoute(request) && !isLocalTestAuthEnabled()) {
    await auth.protect();
  }
});

export default function proxy(
  ...args: Parameters<typeof handleClerkMiddleware>
) {
  const [request] = args;

  if (request.nextUrl.pathname === "/") {
    if (isLocalTestAuthEnabled()) {
      return NextResponse.redirect(new URL("/review", request.url));
    }

    if (request.cookies.has("__session")) {
      return NextResponse.redirect(new URL("/review", request.url));
    }
  }

  if (isPublicStaticPage(request)) {
    return NextResponse.next();
  }

  if (isLocalTestAuthEnabled() && isProtectedRoute(request)) {
    return NextResponse.next();
  }

  return handleClerkMiddleware(...args);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/__clerk/:path*",
    "/(api|trpc)(.*)",
  ],
};
