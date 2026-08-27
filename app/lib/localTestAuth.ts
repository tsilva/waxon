const LOCAL_TEST_AUTH_DISABLED_VALUES = new Set(["1", "true", "yes"]);

export const localTestUser = {
  id: "local-test",
  displayName: "Tiago Silva",
  email: "eng.tiago.silva@gmail.com",
  avatarUrl: null,
} as const;

export const browserAcceptanceTestLearner = {
  id: "issue-20-native-browser-learner",
  displayName: "Issue 20 browser learner",
  email: "issue-20-browser@waxon.invalid",
  avatarUrl: null,
} as const;

export function isBrowserAcceptanceLearnerEnabled(): boolean {
  return process.env.NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER === "1";
}

export function getLocalTestLearner() {
  return isBrowserAcceptanceLearnerEnabled()
    ? browserAcceptanceTestLearner
    : localTestUser;
}

export function isLocalTestAuthEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    !LOCAL_TEST_AUTH_DISABLED_VALUES.has(
      process.env.NEXT_PUBLIC_WAXON_DISABLE_LOCAL_TEST_AUTH?.trim().toLowerCase() ??
        "",
    )
  );
}
