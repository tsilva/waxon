import type { ReviewToolbarTab } from "@/app/ReviewToolbar";

export type ToolbarSnapshotDetail = {
  activeTab: ReviewToolbarTab;
  dueCount: number;
  menuAvatarUrl: string | null;
  menuDisplayName: string;
  menuEmail: string;
};

export const toolbarSnapshotEvent = "waxon:toolbar-snapshot";
export const localSettingsEvent = "waxon:open-local-settings";
