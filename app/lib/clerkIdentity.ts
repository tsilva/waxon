const canonicalWaxonUserId = /^clerk:user_[A-Za-z0-9_-]+$/;

type ClerkIdentity = {
  id: string;
  externalId?: string | null;
};

export function appUserIdForClerkUser(identity: ClerkIdentity): string {
  const externalId = identity.externalId?.trim();

  if (externalId && canonicalWaxonUserId.test(externalId)) {
    return externalId;
  }

  return `clerk:${identity.id}`;
}
