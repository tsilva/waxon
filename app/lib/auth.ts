import { auth, clerkClient } from "@clerk/nextjs/server";
import * as Sentry from "@sentry/nextjs";
import { eq } from "drizzle-orm";
import { getV2Db } from "@/app/db/v2/client";
import { learnerSettings, users } from "@/app/db/v2/schema";
import { appUserIdForClerkUser } from "@/app/lib/clerkIdentity";
import {
  getLocalTestLearner,
  isLocalTestAuthEnabled,
} from "@/app/lib/localTestAuth";
import { ExpiringCache } from "@/app/lib/expiringCache";
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

const profiles = new ExpiringCache<string, AuthenticatedUser>(60_000, 512);

export function invalidateUserProfile(userId: string) {
  profiles.delete(userId);
  profiles.delete(`local:${getLocalTestLearner().email}`);
}

export async function getCurrentUser(options: { fresh?: boolean } = {}): Promise<AuthenticatedUser> {
  const db = getV2Db();
  const local = isLocalTestAuthEnabled() ? getLocalTestLearner() : null;
  // Verify the session for EVERY request, even when the display profile is cached.
  const clerkUserId = local ? null : (await auth.protect()).userId;
  const key = local ? `local:${local.email}` : appUserIdForClerkUser({ id: clerkUserId! });
  if (options.fresh) profiles.delete(key);
  const row = await profiles.get(key, async () => {
    const [existing] = await db.select({
      id: users.id, displayName: users.displayName, email: users.email,
      avatarUrl: users.avatarUrl,
    }).from(users).where(local ? eq(users.email, local.email) : eq(users.id, key)).limit(1);
    if (local && existing) return existing;

    const clerkUser = clerkUserId ? await (await clerkClient()).users.getUser(clerkUserId) : null;
    const email = local?.email ?? clerkUser!.primaryEmailAddress?.emailAddress ??
      clerkUser!.emailAddresses[0]?.emailAddress ?? `${clerkUserId}@clerk.local`;
    const displayName = local?.displayName ?? normalizeDisplayName({
      fullName: clerkUser!.fullName, firstName: clerkUser!.firstName,
      lastName: clerkUser!.lastName, username: clerkUser!.username, email,
    });
    if (existing?.email === email && existing.displayName === displayName) return existing;
    const [saved] = await db.insert(users).values({
      id: existing?.id ?? local?.id ?? key, email, displayName,
    }).onConflictDoUpdate({ target: users.id, set: { email, displayName, updatedAt: new Date() } })
      .returning({ id: users.id, displayName: users.displayName, email: users.email, avatarUrl: users.avatarUrl });
    if (!saved) throw new Error("Could not load current user.");
    // Provision only on a missing learner; ordinary reads have no writes.
    if (!existing) await db.insert(learnerSettings).values({ userId: saved.id })
      .onConflictDoNothing({ target: learnerSettings.userId });
    return saved;
  });
  setTraceIdentity({ userId: row.id, email: row.email, displayName: row.displayName });
  return row;
}
