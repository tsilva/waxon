import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/db/client";
import { users } from "@/app/db/schema";
import { getCurrentUser } from "@/app/lib/auth";
import type { UserProfile } from "@/app/lib/userProfile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_AVATAR_DATA_URL_LENGTH = 700_000;
const AVATAR_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i;

function toUserProfile(row: UserProfile): UserProfile {
  return {
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    avatarUrl: row.avatarUrl,
  };
}

function validateAvatarUrl(avatarUrl: unknown): string | null {
  if (avatarUrl === null) {
    return null;
  }

  if (typeof avatarUrl !== "string") {
    throw new Error("Avatar must be an image data URL.");
  }

  if (avatarUrl.length > MAX_AVATAR_DATA_URL_LENGTH) {
    throw new Error("Avatar image is too large.");
  }

  if (!AVATAR_DATA_URL_PATTERN.test(avatarUrl)) {
    throw new Error("Avatar must be a PNG, JPEG, WebP, or GIF image.");
  }

  return avatarUrl;
}

export async function GET() {
  return NextResponse.json(await getCurrentUser());
}

export async function PATCH(request: NextRequest) {
  let avatarUrl: string | null;

  try {
    const payload = (await request.json()) as { avatarUrl?: unknown };
    avatarUrl = validateAvatarUrl(payload.avatarUrl);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not update avatar.",
      },
      { status: 400 },
    );
  }

  const currentUser = await getCurrentUser();
  const [row] = await db
    .update(users)
    .set({
      avatarUrl,
      updatedAt: Date.now(),
    })
    .where(eq(users.id, currentUser.id))
    .returning({
      id: users.id,
      displayName: users.displayName,
      email: users.email,
      avatarUrl: users.avatarUrl,
    });

  if (!row) {
    return NextResponse.json(
      { error: "Could not update avatar." },
      { status: 500 },
    );
  }

  return NextResponse.json(toUserProfile(row));
}
