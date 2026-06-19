import type { ReviewToolbarTab } from "@/app/toolbarTypes";

export type ToolbarSnapshotDetail = {
  activeTab: ReviewToolbarTab;
  menuAvatarUrl: string | null;
  menuDisplayName: string;
  menuEmail: string;
};

export type ToolbarDueCountDetail = {
  dueCount: number;
};

export const toolbarSnapshotEvent = "waxon:toolbar-snapshot";
export const toolbarDueCountEvent = "waxon:toolbar-due-count";
export const localSettingsEvent = "waxon:open-local-settings";
