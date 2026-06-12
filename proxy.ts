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

export default clerkMiddleware(async (auth, request) => {
  if (request.nextUrl.pathname === "/") {
    if (isLocalTestAuthEnabled()) {
      return NextResponse.redirect(new URL("/review", request.url));
    }

    const { userId } = await auth();

    if (userId) {
      return NextResponse.redirect(new URL("/review", request.url));
    }
  }

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
