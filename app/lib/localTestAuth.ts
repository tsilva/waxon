const LOCAL_TEST_AUTH_DISABLED_VALUES = new Set(["1", "true", "yes"]);

export const localTestUser = {
  id: "local-test",
  displayName: "Tiago Silva",
  email: "eng.tiago.silva@gmail.com",
  avatarUrl: null,
} as const;

export function isLocalTestAuthEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    !LOCAL_TEST_AUTH_DISABLED_VALUES.has(
      process.env.NEXT_PUBLIC_WAXON_DISABLE_LOCAL_TEST_AUTH?.trim().toLowerCase() ??
        "",
    )
  );
}
