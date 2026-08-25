import { auth, clerkClient } from "@clerk/nextjs/server";
import * as Sentry from "@sentry/nextjs";
import { eq } from "drizzle-orm";
import { getV2Db } from "@/app/db/v2/client";
import { learnerSettings, users } from "@/app/db/v2/schema";
import { appUserIdForClerkUser } from "@/app/lib/clerkIdentity";
import { isLocalTestAuthEnabled, localTestUser } from "@/app/lib/localTestAuth";
import type { UserProfile } from "@/app/lib/userProfile";

export type AuthenticatedUser = UserProfile;

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

function setTraceIdentity(input: {
  userId: string;
  email: string;
  displayName: string;
}): void {
  Sentry.setUser({
    id: input.userId,
    email: input.email,
    username: input.displayName,
  });
  Sentry.setTag("user_id", input.userId);
  Sentry.setContext("waxon", {
    userId: input.userId,
  });
}

export async function getCurrentUser(): Promise<AuthenticatedUser> {
  const db = getV2Db();

  if (isLocalTestAuthEnabled()) {
    const now = new Date();
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

    setTraceIdentity({
      userId: localUserId,
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

    await db
      .insert(learnerSettings)
      .values({ userId: row.id })
      .onConflictDoNothing({ target: learnerSettings.userId });

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
  const now = new Date();

  const userId = appUserIdForClerkUser(clerkUser);
  setTraceIdentity({ userId, email, displayName });

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

  if (!row) {
    throw new Error("Could not load current user.");
  }

  await db
    .insert(learnerSettings)
    .values({ userId })
    .onConflictDoNothing({ target: learnerSettings.userId });

  return row;
}
