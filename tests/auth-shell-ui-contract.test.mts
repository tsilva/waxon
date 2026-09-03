import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/review",
});
for (const name of ["document", "HTMLElement", "Node", "navigator"] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  });
}
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: dom.window,
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { ClientAuthGateView } = await import("../app/AuthShell.tsx");

test("auth routes render only Clerk's prebuilt panels", async () => {
  const [layout, provider, signInPage, signUpPage, styles] = await Promise.all([
    readFile(new URL("../app/(auth)/layout.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/(auth)/ClerkAuthProvider.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/(auth)/sign-in/[[...sign-in]]/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/(auth)/sign-up/[[...sign-up]]/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../app/(auth)/auth-globals.css", import.meta.url),
      "utf8",
    ),
  ]);
  const authSource = [layout, provider, signInPage, signUpPage, styles].join(
    "\n",
  );

  assert.match(layout, /<ClerkAuthProvider/u);
  assert.match(provider, /<ClerkProvider/u);
  assert.match(signInPage, /<SignIn\s*\/>/u);
  assert.match(signUpPage, /<SignUp\s*\/>/u);
  assert.doesNotMatch(authSource, /AuthClerkHydrator|auth-static-shell/u);
  assert.doesNotMatch(authSource, /Continue to sign (?:in|up)/u);
});

test("the authenticated app shell stays hidden until Clerk confirms sign-in", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let redirectCount = 0;
  const redirectToSignIn = () => {
    redirectCount += 1;
  };
  const dashboardShell = React.createElement(
    "section",
    { "data-testid": "dashboard-shell" },
    "Dashboard placeholders",
  );

  await act(async () => {
    root.render(
      React.createElement(
        ClientAuthGateView,
        {
          isLoaded: false,
          isSignedIn: undefined,
          redirectToSignIn,
        },
        dashboardShell,
      ),
    );
  });

  assert.equal(container.querySelector("[data-testid='dashboard-shell']"), null);
  assert.equal(redirectCount, 0);

  await act(async () => {
    root.render(
      React.createElement(
        ClientAuthGateView,
        {
          isLoaded: true,
          isSignedIn: false,
          redirectToSignIn,
        },
        dashboardShell,
      ),
    );
  });

  assert.equal(container.querySelector("[data-testid='dashboard-shell']"), null);
  assert.equal(redirectCount, 1);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
