export type AuthenticatedUser = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

const DEFAULT_AUTHENTICATED_USER: AuthenticatedUser = {
  id: "tsilva",
  displayName: "Tiago Silva",
  email: "tsilva@localhost",
  avatarUrl: null,
};

export function getCurrentUser(): AuthenticatedUser {
  return DEFAULT_AUTHENTICATED_USER;
}
