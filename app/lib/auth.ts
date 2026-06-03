export type AuthenticatedUser = {
  id: string;
  displayName: string;
  email: string;
};

const DEFAULT_AUTHENTICATED_USER: AuthenticatedUser = {
  id: "tsilva",
  displayName: "Tiago Silva",
  email: "tsilva@localhost",
};

export function getCurrentUser(): AuthenticatedUser {
  return DEFAULT_AUTHENTICATED_USER;
}
