import assert from "node:assert/strict";
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
