type ClerkIdentity = {
  id: string;
};

export function appUserIdForClerkUser(identity: ClerkIdentity): string {
  return `clerk:${identity.id}`;
}
