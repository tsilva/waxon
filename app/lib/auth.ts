import { auth, clerkClient } from "@clerk/nextjs/server";
import * as Sentry from "@sentry/nextjs";
import { and, eq } from "drizzle-orm";
import { db } from "@/app/db/client";
import { authAccounts, users } from "@/app/db/schema";
import { isLocalTestAuthEnabled, localTestUser } from "@/app/lib/localTestAuth";

export type AuthenticatedUser = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

const CLERK_PROVIDER = "clerk";

function normalizeDisplayName(input: {
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  email: string;
}): string {
  const displayName =
    input.fullName?.trim() ||
    [input.firstName, input.lastName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(" ") ||
    input.username?.trim() ||
    input.email.split("@")[0]?.trim();

  return displayName || "Waxon user";
}

function appUserIdForClerkUser(clerkUserId: string): string {
  return `clerk:${clerkUserId}`;
}

export function getDeckIdForUser(userId: string): string {
  return `${userId}:deep-learning`;
}

function setTraceIdentity(input: {
  userId: string;
  deckId: string;
  email: string;
  displayName: string;
}): void {
  Sentry.setUser({
    id: input.userId,
    email: input.email,
    username: input.displayName,
  });
  Sentry.setTag("user_id", input.userId);
  Sentry.setTag("deck_id", input.deckId);
  Sentry.setContext("waxon", {
    userId: input.userId,
    deckId: input.deckId,
  });
}

export async function getCurrentUser(): Promise<AuthenticatedUser> {
  if (isLocalTestAuthEnabled()) {
    const now = Date.now();
    const [existingLocalUser] = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.email, localTestUser.email))
      .limit(1);

    const localUserId = existingLocalUser?.id ?? localTestUser.id;
    const localUserDisplayName =
      existingLocalUser?.displayName ?? localTestUser.displayName;
    const localUserEmail = existingLocalUser?.email ?? localTestUser.email;
    const deckId = getDeckIdForUser(localUserId);

    setTraceIdentity({
      userId: localUserId,
      deckId,
      email: localUserEmail,
      displayName: localUserDisplayName,
    });

    const [row] = await db
      .insert(users)
      .values({
        id: localUserId,
        displayName: localUserDisplayName,
        email: localUserEmail,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          displayName: localUserDisplayName,
          email: localUserEmail,
          updatedAt: now,
        },
      })
      .returning({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        avatarUrl: users.avatarUrl,
      });

    if (!row) {
      throw new Error("Could not load current user.");
    }

    return row;
  }

  const authObject = await auth.protect();
  const clerkUserId = authObject.userId;
  const client = await clerkClient();
  const clerkUser = await client.users.getUser(clerkUserId);
  const email =
    clerkUser.primaryEmailAddress?.emailAddress ??
    clerkUser.emailAddresses[0]?.emailAddress ??
    `${clerkUserId}@clerk.local`;
  const displayName = normalizeDisplayName({
    fullName: clerkUser.fullName,
    firstName: clerkUser.firstName,
    lastName: clerkUser.lastName,
    username: clerkUser.username,
    email,
  });
  const now = Date.now();

  const [existingAccount] = await db
    .select({ userId: authAccounts.userId })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.provider, CLERK_PROVIDER),
        eq(authAccounts.providerAccountId, clerkUserId),
      ),
    )
    .limit(1);

  const userId = existingAccount?.userId ?? appUserIdForClerkUser(clerkUserId);
  const deckId = getDeckIdForUser(userId);

  setTraceIdentity({ userId, deckId, email, displayName });

  const [row] = await db
    .insert(users)
    .values({
      id: userId,
      displayName,
      email,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        displayName,
        email,
        updatedAt: now,
      },
    })
    .returning({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
      avatarUrl: users.avatarUrl,
    });

  await db
    .insert(authAccounts)
    .values({
      userId,
      provider: CLERK_PROVIDER,
      providerAccountId: clerkUserId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [authAccounts.provider, authAccounts.providerAccountId],
      set: {
        userId,
        updatedAt: now,
      },
    });

  if (!row) {
    throw new Error("Could not load current user.");
  }

  return row;
}
