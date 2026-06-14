import { localTestUser } from "@/app/lib/localTestAuth";
import { NextResponse, type NextRequest } from "next/server";

const localClerkUser = {
  id: localTestUser.id,
  fullName: localTestUser.displayName,
  firstName: "Tiago",
  lastName: "Silva",
  username: "eng.tiago.silva",
  primaryEmailAddress: {
    emailAddress: localTestUser.email,
  },
  emailAddresses: [
    {
      emailAddress: localTestUser.email,
    },
  ],
};

export const auth = {
  protect: async () => ({
    userId: localTestUser.id,
  }),
};

export async function clerkClient() {
  return {
    users: {
      getUser: async () => localClerkUser,
    },
  };
}

export function createRouteMatcher(patterns: string[]) {
  return (request: NextRequest) => {
    const pathname = request.nextUrl.pathname;

    return patterns.some((pattern) => {
      if (pattern.endsWith("(.*)")) {
        return pathname.startsWith(pattern.slice(0, -4));
      }

      return pathname === pattern;
    });
  };
}

export function clerkMiddleware(
  handler: (
    authObject: typeof auth,
    request: NextRequest,
  ) => Promise<void> | void,
) {
  return async (request: NextRequest) => {
    await handler(auth, request);

    return NextResponse.next();
  };
}
