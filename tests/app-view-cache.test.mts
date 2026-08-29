import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
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
const { AppViewCacheProvider, useAppViewCache } = await import(
  "../app/AppViewCache.tsx"
);
type ViewCache = ReturnType<typeof useAppViewCache>;

test("the authenticated view cache deduplicates preloads and keys drafts to questions", async () => {
  const requests: string[] = [];
  const library = {
    questions: [],
    counts: { active: 2, flagged: 1, archived: 0 },
  };
  const review = {
    question: {
      questionId: "question-1",
      prompt: "Prompt",
      total: 2,
      scheduledFor: null,
    },
    recentAnswers: [],
    waitingOnEvaluation: false,
    timezone: "Europe/Lisbon",
    localDay: "2026-08-29",
    summary: { queueRemaining: 2, nextScheduledOn: null },
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      return new Response(
        JSON.stringify(url.includes("/library") ? library : review),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  let cache: ViewCache | null = null;
  function Harness() {
    cache = useAppViewCache();
    return null;
  }

  const container = document.querySelector<HTMLDivElement>("#root");
  assert.ok(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        AppViewCacheProvider,
        null,
        React.createElement(Harness),
      ),
    );
  });
  const mountedCache = cache as ViewCache | null;
  assert.ok(mountedCache);

  await Promise.all([
    mountedCache.preloadLibrary(),
    mountedCache.preloadLibrary(),
  ]);
  assert.equal(requests.filter((url) => url.includes("/library")).length, 1);
  assert.deepEqual(mountedCache.readLibrary(), library);

  mountedCache.writeReviewDraft("question-1", "My unfinished answer");
  assert.equal(
    mountedCache.readReviewDraft("question-1"),
    "My unfinished answer",
  );
  assert.equal(mountedCache.readReviewDraft("question-2"), "");

  await mountedCache.preloadReview();
  assert.deepEqual(mountedCache.readReview(), review);

  await act(async () => root.unmount());
});

test("Review and Library warm each other and navigation links opt into prefetching", async () => {
  const [reviewSource, librarySource, toolbarSource, hydratorSource] =
    await Promise.all([
      readFile(
        new URL("../app/(app)/review/ReviewApp.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../app/(app)/library/LibraryPageClient.tsx",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(new URL("../app/ReviewToolbar.tsx", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../app/(app)/AuthenticatedClientHydrator.tsx",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);

  assert.match(reviewSource, /viewCache\.preloadLibrary\(\)/u);
  assert.match(reviewSource, /LibraryHydrator\.preload\(\)/u);
  assert.match(reviewSource, /useState\(!initialReview\)/u);
  assert.match(librarySource, /viewCache\.preloadReview\(\)/u);
  assert.match(librarySource, /ReviewHydrator\.preload\(\)/u);
  assert.match(librarySource, /useState\(!initialData\)/u);
  assert.match(toolbarSource, /href="\/review"\s+prefetch/u);
  assert.match(toolbarSource, /href="\/library"\s+prefetch/u);
  assert.match(
    hydratorSource,
    /useState<ComponentType<TProps> \| null>\(\(\) => preloadedClient\)/u,
  );
});
