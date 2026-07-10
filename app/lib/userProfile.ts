export type UserProfile = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

export type UserProfileSummary = Pick<
  UserProfile,
  "displayName" | "email" | "avatarUrl"
>;
