const LOCAL_TEST_AUTH_DISABLED_VALUES = new Set(["1", "true", "yes"]);
const LOCAL_TEST_AUTH_ENABLED_VALUES = new Set(["1", "true", "yes"]);

export const localTestUser = {
  id: "local-test",
  displayName: "Tiago Silva",
  email: "eng.tiago.silva@gmail.com",
  avatarUrl: null,
} as const;

export function isLocalTestAuthEnabled(): boolean {
  const isLocalDevelopmentAuth =
    process.env.NODE_ENV === "development" &&
    !LOCAL_TEST_AUTH_DISABLED_VALUES.has(
      process.env.NEXT_PUBLIC_WAXON_DISABLE_LOCAL_TEST_AUTH?.trim().toLowerCase() ??
        "",
    );

  if (isLocalDevelopmentAuth) {
    return true;
  }

  const isBrowser = typeof window !== "undefined";
  const explicitAuditAuthValue = isBrowser
    ? process.env.NEXT_PUBLIC_WAXON_ENABLE_LOCAL_TEST_AUTH
    : process.env.WAXON_ENABLE_LOCAL_TEST_AUTH;
  const isExplicitAuditAuthEnabled = LOCAL_TEST_AUTH_ENABLED_VALUES.has(
    explicitAuditAuthValue?.trim().toLowerCase() ?? "",
  );

  return (
    isExplicitAuditAuthEnabled &&
    process.env.VERCEL !== "1" &&
    process.env.NEXT_PUBLIC_VERCEL !== "1"
  );
}
