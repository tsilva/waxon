"use client";

import { Trash2, Upload, User } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { usePageScrollLock } from "@/app/lib/usePageScrollLock";
import type { UserProfile } from "@/app/lib/userProfile";
import { useToolbarState } from "@/app/ToolbarState";

const MAX_AVATAR_UPLOAD_BYTES = 512 * 1024;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Could not read avatar image."));
    };
    reader.onerror = () => reject(new Error("Could not read avatar image."));
    reader.readAsDataURL(file);
  });
}

export function LocalAccountSettings({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { currentUser, setCurrentUser } = useToolbarState();
  const [isAvatarUpdating, setIsAvatarUpdating] = useState(false);
  const [avatarMessage, setAvatarMessage] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  usePageScrollLock(isOpen);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isOpen, onClose]);

  async function saveAvatar(avatarUrl: string | null) {
    setIsAvatarUpdating(true);
    setAvatarMessage(null);

    try {
      const response = await fetch("/api/user", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarUrl }),
      });
      const data = (await response.json()) as UserProfile | { error?: string };

      if (!response.ok) {
        throw new Error(
          "error" in data && data.error
            ? data.error
            : "Could not update avatar.",
        );
      }

      setCurrentUser(data as UserProfile);
      setAvatarMessage(avatarUrl ? "Avatar updated." : "Avatar removed.");
    } catch (error) {
      setAvatarMessage(
        error instanceof Error ? error.message : "Could not update avatar.",
      );
    } finally {
      setIsAvatarUpdating(false);
    }
  }

  async function handleAvatarFileChange(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
      setAvatarMessage("Choose a PNG, JPEG, WebP, or GIF image.");
      return;
    }

    if (file.size > MAX_AVATAR_UPLOAD_BYTES) {
      setAvatarMessage("Choose an image under 512 KB.");
      return;
    }

    try {
      await saveAvatar(await readFileAsDataUrl(file));
    } catch (error) {
      setAvatarMessage(
        error instanceof Error ? error.message : "Could not read avatar image.",
      );
    }
  }

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="settings-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
      >
        <div className="settings-modal-header">
          <div>
            <p className="settings-modal-kicker">User settings</p>
            <h2 className="settings-modal-title" id="settings-modal-title">
              Profile
            </h2>
          </div>
          <button
            className="stats-modal-close"
            type="button"
            aria-label="Close settings"
            onClick={onClose}
          />
        </div>

        <div className="settings-profile">
          <div className="settings-avatar-preview" aria-hidden="true">
            {currentUser?.avatarUrl ? (
              <span
                className="settings-avatar-image"
                style={{ backgroundImage: `url("${currentUser.avatarUrl}")` }}
              />
            ) : (
              <User aria-hidden="true" />
            )}
          </div>

          <div className="settings-profile-copy">
            <dl className="settings-profile-details">
              <div>
                <dt>Name</dt>
                <dd>{currentUser?.displayName ?? "Loading..."}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{currentUser?.email ?? "Loading..."}</dd>
              </div>
            </dl>

            <div className="settings-avatar-actions">
              <input
                ref={avatarInputRef}
                className="settings-avatar-input"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(event) => void handleAvatarFileChange(event)}
              />
              <button
                className="settings-action-primary"
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={isAvatarUpdating}
              >
                <Upload aria-hidden="true" />
                <span>{isAvatarUpdating ? "Uploading..." : "Upload avatar"}</span>
              </button>
              <button
                className="settings-action-secondary"
                type="button"
                onClick={() => void saveAvatar(null)}
                disabled={isAvatarUpdating || !currentUser?.avatarUrl}
              >
                <Trash2 aria-hidden="true" />
                <span>Remove</span>
              </button>
            </div>

            {avatarMessage ? (
              <p className="settings-status" aria-live="polite">
                {avatarMessage}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
