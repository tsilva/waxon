import { auth, clerkClient } from "@clerk/nextjs/server";
import * as Sentry from "@sentry/nextjs";
import { and, eq } from "drizzle-orm";
import { db } from "@/app/db/client";
import { authAccounts, users } from "@/app/db/schema";

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

async function findLegacyClaimUserId(email: string): Promise<string | null> {
  const legacyUserId = process.env.WAXON_CLAIM_LEGACY_USER_ID?.trim();

  if (!legacyUserId) {
    return null;
  }

  const legacyEmail = process.env.WAXON_CLAIM_LEGACY_EMAIL?.trim().toLowerCase();

  if (legacyEmail && email.trim().toLowerCase() !== legacyEmail) {
    return null;
  }

  const [legacyUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, legacyUserId))
    .limit(1);

  if (!legacyUser) {
    return null;
  }

  const [existingClaim] = await db
    .select({ id: authAccounts.id })
    .from(authAccounts)
    .where(eq(authAccounts.userId, legacyUserId))
    .limit(1);

  return existingClaim ? null : legacyUser.id;
}

export function getDeckIdForUser(userId: string): string {
  return userId === "tsilva" ? "deep-learning" : `${userId}:deep-learning`;
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

  const userId =
    existingAccount?.userId ??
    (await findLegacyClaimUserId(email)) ??
    appUserIdForClerkUser(clerkUserId);
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
