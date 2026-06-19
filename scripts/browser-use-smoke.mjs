const DEFAULT_BROWSER_CLIENT_MODULE =
  "/Users/tsilva/.codex/plugins/cache/openai-bundled/browser/26.602.40724/scripts/browser-client.mjs";

const CORRECT_QUESTION =
  "Browser smoke correct card: what exact token proves this answer is correct?";
const INCORRECT_QUESTION =
  "Browser smoke incorrect card: what exact token is intentionally omitted?";
const CORRECT_ANSWER =
  "The answer includes browser-smoke-correct-token, which is the expected token.";
const INCORRECT_ANSWER = "This answer deliberately omits the required token.";

async function ensureBrowser() {
  if (globalThis.browser) {
    return globalThis.browser;
  }

  if (!globalThis.agent) {
    throw new Error(
      "Browser plugin runtime is not available. Run this script from Codex's node_repl after loading the Browser plugin.",
    );
  }

  const browserClientModule =
    globalThis.__WAXON_BROWSER_CLIENT_MODULE ?? DEFAULT_BROWSER_CLIENT_MODULE;
  const { setupBrowserRuntime } = await import(browserClientModule);
  await setupBrowserRuntime({ globals: globalThis });
  globalThis.browser = await agent.browsers.get("iab");
  return globalThis.browser;
}

async function waitForVisibleText(tab, text, timeoutMs = 20_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const hasText = await tab.playwright.evaluate((targetText) => {
      return document.body.textContent?.includes(targetText) ?? false;
    }, text);

    if (hasText) {
      return;
    }

    await tab.playwright.waitForTimeout(250);
  }

  const state = await tab.playwright.evaluate(() => ({
    url: window.location.href,
    text: document.body.textContent?.slice(0, 1_500) ?? "",
  }));

  throw new Error(
    `Timed out waiting for text: ${text}\nURL: ${state.url}\nBody: ${state.text}`,
  );
}

async function waitForRoutedText(tab, text) {
  try {
    await waitForVisibleText(tab, text, 12_000);
  } catch {
    await tab.reload();
    await tab.playwright.waitForLoadState({
      state: "domcontentloaded",
      timeoutMs: 20_000,
    });
    await waitForVisibleText(tab, text, 20_000);
  }
}

async function writeScreenshot(tab, name, screenshotDir) {
  try {
    const bytes = await tab.screenshot({ fullPage: false });
    const fs = await import("node:fs");
    const path = `${screenshotDir.replace(/\/$/, "")}/${name}.png`;
    await fs.promises.writeFile(path, bytes);
    return path;
  } catch (error) {
    return {
      skipped: true,
      reason: error instanceof Error ? error.message : "Screenshot failed.",
    };
  }
}

async function setupSmokeData(tab, baseUrl) {
  await tab.goto(`${baseUrl}/test-support/browser-smoke/setup`);
  await tab.playwright.waitForLoadState({
    state: "domcontentloaded",
    timeoutMs: 20_000,
  });
  await waitForVisibleText(tab, "Browser smoke setup ready");
}

async function submitCurrentReviewAnswer(tab, answer) {
  const textarea = tab.playwright.locator("textarea", {});
  const textareaCount = await textarea.count();

  if (textareaCount !== 1) {
    throw new Error(`Expected one answer textarea, found ${textareaCount}`);
  }

  await textarea.fill(answer, { timeoutMs: 5_000 });

  const submit = tab.playwright.getByRole("button", {
    name: "Submit answer",
    exact: true,
  });
  const submitCount = await submit.count();

  if (submitCount !== 1) {
    throw new Error(`Expected one submit button, found ${submitCount}`);
  }

  await submit.click({});
}

async function openQuestionDetails(tab, question) {
  const startedAt = Date.now();
  let rowCount = 0;

  while (Date.now() - startedAt < 20_000) {
    rowCount = await tab.playwright.evaluate((targetQuestion) => {
      return Array.from(document.querySelectorAll(".queue-row-card")).filter(
        (element) => element.textContent?.includes(targetQuestion),
      ).length;
    }, question);

    if (rowCount === 1) {
      break;
    }

    await tab.playwright.waitForTimeout(250);
  }

  const row = tab.playwright
    .locator(".queue-row-card", {})
    .filter({ hasText: question });
  const count = await row.count();

  if (count !== 1) {
    throw new Error(`Expected one queue row for ${question}, found ${count}`);
  }

  await row.click({});
  await waitForVisibleText(tab, "Question stats");
}

async function assertAdminTrace(tab, baseUrl, expectedQuestion) {
  await tab.goto(`${baseUrl}/admin`);
  await tab.playwright.waitForLoadState({
    state: "domcontentloaded",
    timeoutMs: 20_000,
  });
  await waitForVisibleText(tab, "Admin traces");
  await waitForVisibleText(tab, "Answer submitted");

  const hasTrace = await tab.playwright.evaluate((question) => {
    return document.body.textContent?.includes(question) ?? false;
  }, expectedQuestion);

  if (!hasTrace) {
    throw new Error(`Admin traces did not include ${expectedQuestion}`);
  }
}

export async function runWaxonBrowserSmoke(options = {}) {
  const baseUrl = options.baseUrl ?? "http://localhost:3000";
  const screenshotDir = options.screenshotDir ?? "/private/tmp";
  const browser = await ensureBrowser();
  await browser.nameSession("Waxon Browser Smoke");

  const tab = await browser.tabs.new();
  const results = {
    baseUrl,
    screenshots: {},
    checks: [],
  };

  await tab.goto(`${baseUrl}/library`);
  await tab.playwright.waitForLoadState({
    state: "domcontentloaded",
    timeoutMs: 20_000,
  });
  await setupSmokeData(tab, baseUrl);

  await tab.goto(`${baseUrl}/library`);
  await tab.playwright.waitForLoadState({
    state: "domcontentloaded",
    timeoutMs: 20_000,
  });
  await waitForRoutedText(tab, CORRECT_QUESTION);
  await waitForRoutedText(tab, INCORRECT_QUESTION);
  results.screenshots.library = await writeScreenshot(
    tab,
    "waxon-browser-smoke-library",
    screenshotDir,
  );
  results.checks.push("Library renders both seeded smoke cards.");

  await openQuestionDetails(tab, CORRECT_QUESTION);
  await waitForVisibleText(tab, "LLM answer");
  results.screenshots.questionDetails = await writeScreenshot(
    tab,
    "waxon-browser-smoke-question-details",
    screenshotDir,
  );
  results.checks.push("Question details modal opens from the library queue.");

  const closeStats = tab.playwright.getByRole("button", {
    name: "Close stats",
    exact: true,
  });
  if ((await closeStats.count()) !== 1) {
    throw new Error("Expected one Close stats button.");
  }
  await closeStats.click({});

  await tab.goto(`${baseUrl}/review`);
  await tab.playwright.waitForLoadState({
    state: "domcontentloaded",
    timeoutMs: 20_000,
  });
  await waitForRoutedText(tab, CORRECT_QUESTION);
  await submitCurrentReviewAnswer(tab, CORRECT_ANSWER);
  await waitForVisibleText(tab, "Contains the expected smoke token.", 30_000);
  results.checks.push("Correct answer resolves to score 10.");

  await waitForVisibleText(tab, INCORRECT_QUESTION);
  await submitCurrentReviewAnswer(tab, INCORRECT_ANSWER);
  await waitForVisibleText(tab, "Missing the expected smoke token.", 30_000);
  results.screenshots.review = await writeScreenshot(
    tab,
    "waxon-browser-smoke-review-results",
    screenshotDir,
  );
  results.checks.push("Incorrect answer resolves to score 2.");

  await tab.goto(`${baseUrl}/library`);
  await tab.playwright.waitForLoadState({
    state: "domcontentloaded",
    timeoutMs: 20_000,
  });
  await waitForRoutedText(tab, INCORRECT_QUESTION);
  await openQuestionDetails(tab, INCORRECT_QUESTION);
  await waitForVisibleText(tab, INCORRECT_ANSWER);
  await waitForVisibleText(tab, "2");
  results.screenshots.updatedQuestionDetails = await writeScreenshot(
    tab,
    "waxon-browser-smoke-updated-question-details",
    screenshotDir,
  );
  results.checks.push("Question details show the persisted incorrect attempt.");

  await assertAdminTrace(tab, baseUrl, INCORRECT_QUESTION);
  results.screenshots.admin = await writeScreenshot(
    tab,
    "waxon-browser-smoke-admin-traces",
    screenshotDir,
  );
  results.checks.push("Admin traces include browser-smoke answer evaluations.");

  const logs = await tab.dev.logs({
    levels: ["error", "warn"],
    limit: 50,
  });
  results.console = logs;

  const unexpectedLogs = logs.filter(
    (log) =>
      !log.message.includes("favicon") &&
      !log.message.includes("Clerk has been loaded with development keys"),
  );

  if (unexpectedLogs.length > 0) {
    throw new Error(`Unexpected browser console messages: ${JSON.stringify(logs)}`);
  }

  return results;
}
