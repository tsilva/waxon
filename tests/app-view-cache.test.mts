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
  let adminRequestFails = false;
  const library = {
    questions: [],
    counts: { active: 2, flagged: 1, archived: 0 },
  };
  const review = {
    question: {
      questionId: "question-1",
      prompt: "Prompt",
      relatedTags: [],
      total: 2,
      scheduledFor: null,
    },
    recentAnswers: [],
    waitingOnEvaluation: false,
    timezone: "Europe/Lisbon",
    localDay: "2026-08-29",
    summary: { queueRemaining: 2, nextScheduledOn: null },
  };
  const admin = {
    interactions: [
      {
        id: "interaction-1",
        title: "Answer evaluation: Prompt",
        kind: "Answer evaluation" as const,
        startedAt: "2026-08-29T10:00:00.000Z",
        status: "ok" as const,
        calls: [],
      },
    ],
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      const payload = url.includes("/api/admin/traces")
        ? admin
        : url.includes("/library")
          ? library
          : review;
      return new Response(
        JSON.stringify(payload),
        {
          status:
            adminRequestFails && url.includes("/api/admin/traces") ? 500 : 200,
          headers: { "Content-Type": "application/json" },
        },
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
  assert.equal(mountedCache.readAdminTraces(), null);

  await Promise.all([
    mountedCache.preloadAdmin(),
    mountedCache.preloadAdmin(),
  ]);
  assert.equal(
    requests.filter((url) => url.includes("/api/admin/traces")).length,
    1,
  );
  assert.deepEqual(mountedCache.readAdminTraces(), admin.interactions);

  mountedCache.writeAdminTraces([]);
  assert.deepEqual(mountedCache.readAdminTraces(), []);

  const adminView = {
    preset: "7d" as const,
    fromDate: "2026-08-23",
    toDate: "2026-08-29",
    typeFilter: "all" as const,
    statusFilter: "all" as const,
    searchTerm: "evaluation",
    sortKey: "startedAt" as const,
    sortDirection: "desc" as const,
    expandedInteractionId: "interaction-1",
  };
  mountedCache.writeAdminView(adminView);
  assert.deepEqual(mountedCache.readAdminView(), adminView);

  mountedCache.writeAdminTraces(admin.interactions);
  adminRequestFails = true;
  await assert.rejects(mountedCache.refreshAdminTraces());
  assert.deepEqual(mountedCache.readAdminTraces(), admin.interactions);
  await mountedCache.preloadAdmin();
  assert.deepEqual(mountedCache.readAdminTraces(), admin.interactions);
  adminRequestFails = false;

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

test("authenticated views warm their routes, clients, and data", async () => {
  const [
    reviewSource,
    librarySource,
    toolbarSource,
    hydratorSource,
    providersSource,
    adminHydratorSource,
    adminClientSource,
  ] =
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
      readFile(
        new URL("../app/AuthenticatedProviders.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/(app)/admin/AdminHydrator.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../app/(app)/admin/AdminPageClient.tsx", import.meta.url),
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
  assert.match(toolbarSource, /href="\/admin"\s+prefetch/u);
  assert.match(providersSource, /canViewAdmin\s+&&/u);
  assert.match(providersSource, /router\.prefetch\("\/admin"\)/u);
  assert.match(providersSource, /AdminHydrator\.preload\(\)/u);
  assert.match(providersSource, /viewCache\.preloadAdmin\(\)/u);
  assert.match(
    adminHydratorSource,
    /preload:\s*AdminPageClientHydrator\.preload/u,
  );
  assert.match(adminClientSource, /viewCache\.readAdminTraces\(\)/u);
  assert.match(adminClientSource, /cachedInteractions\s*!==\s*null/u);
  assert.match(
    adminClientSource,
    /useState\(\s*\(\) => !initialAdminState\.hasLoadedInteractions/u,
  );
  assert.match(adminClientSource, /viewCache\.readAdminView\(\)/u);
  assert.match(adminClientSource, /viewCache\.refreshAdminTraces\(\)/u);
  assert.match(adminClientSource, /viewCache\.writeAdminView\(viewState\)/u);
  assert.match(
    hydratorSource,
    /useState<ComponentType<TProps> \| null>\(\(\) => preloadedClient\)/u,
  );
});
