import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const reviewAppPath = new URL(
  "../app/(app)/review/ReviewApp.tsx",
  import.meta.url,
);
const libraryPath = new URL(
  "../app/(app)/library/LibraryPageClient.tsx",
  import.meta.url,
);
const questionTagsPath = new URL("../app/QuestionTags.tsx", import.meta.url);
const questionBankFlagDialogPath = new URL(
  "../app/(app)/library/QuestionBankFlagDialog.tsx",
  import.meta.url,
);
const appStylesPath = new URL(
  "../app/(app)/app-globals.css",
  import.meta.url,
);

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/review",
});
for (const name of [
  "document",
  "HTMLElement",
  "HTMLButtonElement",
  "KeyboardEvent",
  "MouseEvent",
  "Node",
  "navigator",
] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: dom.window[name],
  });
}
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: dom.window,
});
dom.window.requestAnimationFrame = (callback: FrameRequestCallback) =>
  dom.window.setTimeout(() => callback(Date.now()), 0);
dom.window.cancelAnimationFrame = (handle: number) => dom.window.clearTimeout(handle);
dom.window.scrollTo = () => undefined;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { ReviewFlagDialog } = await import(
  "../app/(app)/review/ReviewFlagDialog.tsx"
);
const { QuestionBankFlagDialog } = await import(
  "../app/(app)/library/QuestionBankFlagDialog.tsx"
);

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function click(element: Element) {
  element.dispatchEvent(
    new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );
}

function mouseDown(element: Element) {
  element.dispatchEvent(
    new dom.window.MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    }),
  );
}

function keydown(element: Element, key: string, shiftKey = false) {
  const event = new dom.window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    shiftKey,
  });
  element.dispatchEvent(event);
  return event;
}

async function frame() {
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
}

test("Review exposes one Flag action and no other Library management action", async () => {
  const source = await readFile(reviewAppPath, "utf8");

  assert.equal(source.match(/aria-label="Flag current Question"/gu)?.length, 1);
  assert.equal(source.includes("<span>Flag</span>"), false);
  for (const forbiddenAction of [
    "Archive question",
    "Replace question",
    "Restore question",
  ]) {
    assert.equal(source.includes(forbiddenAction), false);
  }
});

test("Library exposes the shared Flag dialog only for Active Questions", async () => {
  const [source, dialogSource] = await Promise.all([
    readFile(libraryPath, "utf8"),
    readFile(questionBankFlagDialogPath, "utf8"),
  ]);

  assert.equal(source.includes('aria-label="Flag question"'), true);
  assert.equal(source.includes('question.lifecycle === "active"'), true);
  assert.equal(source.includes('<QuestionBankFlagDialog'), true);
  assert.equal(dialogSource.includes('<ReviewFlagDialog'), true);
  assert.equal(dialogSource.includes('surface="question-bank"'), true);
  assert.equal(source.includes('action: "flag"'), true);
  assert.equal(source.includes("reasons"), true);
  assert.equal(source.includes("detail"), true);
  assert.equal(source.includes("lean-attention-inbox"), false);
  assert.equal(source.includes("Attention inbox"), false);
});

test("Library reports a committed Flag separately from a failed refresh", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const container = document.querySelector<HTMLDivElement>("#root");
  assert.ok(container);
  const events: string[] = [];
  const submissions: unknown[] = [];
  const refreshErrors: string[] = [];

  function Harness() {
    const [open, setOpen] = React.useState(true);
    const bankRef = React.useRef<HTMLDivElement | null>(null);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "div",
        { ref: bankRef, tabIndex: -1 },
        "Library",
      ),
      open
        ? React.createElement(QuestionBankFlagDialog, {
            onClose: () => setOpen(false),
            onCommitted: () => {
              events.push("committed");
              bankRef.current?.focus();
            },
            onFlag: async (input) => {
              events.push("flagged");
              submissions.push(input);
            },
            onRefresh: async () => {
              events.push("refresh");
              throw new Error("GET refresh failed.");
            },
            onRefreshError: (message) => {
              events.push("refresh-error");
              refreshErrors.push(message);
            },
          })
        : null,
    );
  }

  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Harness)));
  await act(frame);
  const submit = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent?.includes("Flag Question"));
  assert.ok(submit);

  await act(async () => {
    click(submit);
    await Promise.resolve();
  });
  await act(frame);
  await act(async () => Promise.resolve());

  assert.deepEqual(submissions, [{ reasons: [], detail: "" }]);
  assert.deepEqual(events, [
    "flagged",
    "committed",
    "refresh",
    "refresh-error",
  ]);
  assert.deepEqual(refreshErrors, [
    "Question was Flagged, but the Library could not be refreshed. Reload to see the latest state.",
  ]);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement?.textContent, "Library");
  await act(async () => root.unmount());
});

test("Review Flag dialog traps Tab during async empty submission and focuses the resting state", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const container = document.querySelector<HTMLDivElement>("#root");
  assert.ok(container);
  const save = deferred<void>();
  const submissions: unknown[] = [];

  function Harness() {
    const [open, setOpen] = React.useState(false);
    const restingRef = React.useRef<HTMLDivElement | null>(null);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "button",
        { onClick: () => setOpen(true), type: "button" },
        "Open",
      ),
      React.createElement(
        "div",
        { ref: restingRef, tabIndex: -1 },
        "Queue clear",
      ),
      open
        ? React.createElement(ReviewFlagDialog, {
            onClose: () => setOpen(false),
            onSubmit: async (input) => {
              submissions.push(input);
              await save.promise;
            },
            onSubmitted: () => restingRef.current?.focus(),
          })
        : null,
    );
  }

  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Harness)));
  const opener = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === "Open",
  );
  assert.ok(opener);
  await act(async () => click(opener));
  await act(frame);

  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  const firstReason = document.querySelector<HTMLButtonElement>(
    '.review-flag-reasons button',
  );
  const reasonsLegend = dialog?.querySelector("legend");
  const detailLabel = dialog?.querySelector<HTMLLabelElement>(
    "label.review-flag-detail",
  );
  const submit = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.includes("Flag Question"),
  );
  const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === "Cancel",
  );
  const close = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Close Flag dialog"]',
  );
  assert.ok(dialog);
  assert.ok(firstReason);
  assert.equal(reasonsLegend?.textContent, "What needs attention?");
  assert.equal(reasonsLegend?.classList.contains("sr-only"), true);
  assert.equal(
    detailLabel?.querySelector(".sr-only")?.textContent,
    "Optional detail",
  );
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.equal(document.activeElement, firstReason);
  assert.ok(submit);
  assert.ok(cancel);
  assert.ok(close);
  assert.equal(submit.classList.contains("v2-button-primary"), true);
  assert.equal(cancel.classList.contains("v2-button-secondary"), true);

  const secondReason = document.querySelectorAll<HTMLButtonElement>(
    ".review-flag-reasons button",
  )[1];
  assert.ok(secondReason);
  const firstTab = keydown(firstReason, "Tab");
  assert.equal(firstTab.defaultPrevented, true);
  assert.equal(document.activeElement, secondReason);

  let firstActivation!: KeyboardEvent;
  await act(async () => {
    firstActivation = keydown(firstReason, "Enter");
  });
  assert.equal(firstActivation.defaultPrevented, true);
  assert.equal(firstReason.getAttribute("aria-pressed"), "true");
  let secondActivation!: KeyboardEvent;
  await act(async () => {
    secondActivation = keydown(secondReason, " ");
  });
  assert.equal(secondActivation.defaultPrevented, true);
  assert.equal(secondReason.getAttribute("aria-pressed"), "true");
  await act(async () => {
    keydown(firstReason, "Enter");
    keydown(secondReason, " ");
  });
  assert.equal(firstReason.getAttribute("aria-pressed"), "false");
  assert.equal(secondReason.getAttribute("aria-pressed"), "false");

  close.focus();
  const reverseWrap = keydown(close, "Tab", true);
  assert.equal(reverseWrap.defaultPrevented, true);
  assert.equal(document.activeElement, submit);
  const forwardWrap = keydown(submit, "Tab");
  assert.equal(forwardWrap.defaultPrevented, true);
  assert.equal(document.activeElement, close);

  submit.focus();
  await act(async () => click(submit));
  assert.deepEqual(submissions, [{ reasons: [], detail: "" }]);
  assert.equal(
    dialog.querySelectorAll("button:not([disabled]), textarea:not([disabled])")
      .length,
    0,
  );

  const tab = keydown(submit, "Tab");
  assert.equal(tab.defaultPrevented, true);
  assert.equal(document.activeElement, dialog);
  const reverseTab = keydown(dialog, "Tab", true);
  assert.equal(reverseTab.defaultPrevented, true);
  assert.equal(document.activeElement, dialog);

  await act(async () => {
    save.resolve();
    await save.promise;
  });
  await act(frame);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement?.textContent, "Queue clear");
  await act(async () => root.unmount());
});

test("Review Flag dialog toggles reasons, reports errors, dismisses, and restores focus", async () => {
  document.body.innerHTML = '<button id="opener">Flag</button><div id="root"></div>';
  const opener = document.querySelector<HTMLButtonElement>("#opener");
  const container = document.querySelector<HTMLDivElement>("#root");
  assert.ok(opener);
  assert.ok(container);
  opener.focus();
  let closes = 0;
  const submissions: unknown[] = [];
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(ReviewFlagDialog, {
        onClose: () => {
          closes += 1;
        },
        onSubmit: async (input) => {
          submissions.push(input);
          throw new Error("Flag could not be saved.");
        },
        onSubmitted: () => undefined,
      }),
    ),
  );
  await act(frame);

  const reasons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.review-flag-reasons button'),
  );
  const [firstReason, secondReason] = reasons;
  assert.ok(firstReason);
  assert.ok(secondReason);
  assert.equal(firstReason.textContent?.trim(), "Question is unclear");
  await act(async () => {
    click(firstReason);
    click(secondReason);
  });
  assert.equal(firstReason.getAttribute("aria-pressed"), "true");
  assert.equal(secondReason.getAttribute("aria-pressed"), "true");

  const detail = document.querySelector<HTMLTextAreaElement>(
    'textarea[name="detail"]',
  );
  assert.ok(detail);
  const setTextareaValue = Object.getOwnPropertyDescriptor(
    dom.window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  assert.ok(setTextareaValue);
  await act(async () => {
    setTextareaValue.call(detail, "The expected answer conflicts with the stored standard.");
    detail.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });

  const submit = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.includes("Flag Question"),
  );
  assert.ok(submit);
  await act(async () => {
    click(submit);
    await Promise.resolve();
  });
  assert.deepEqual(submissions, [
    {
      reasons: ["prompt_unclear", "answer_standard_incorrect"],
      detail: "The expected answer conflicts with the stored standard.",
    },
  ]);
  assert.equal(document.querySelector('[role="alert"]')?.textContent, "Flag could not be saved.");

  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  const backdrop = document.querySelector<HTMLElement>(".review-flag-backdrop");
  assert.ok(dialog);
  assert.ok(backdrop);
  await act(async () => mouseDown(backdrop));
  assert.equal(closes, 1);
  await act(async () => keydown(dialog, "Escape"));
  assert.equal(closes, 2);
  await act(async () => root.unmount());
  assert.equal(document.activeElement, opener);
});

test("Review Flag modal has a narrow responsive contract and Library groups question details behind one disclosure", async () => {
  const [styles, questionBank, questionTags] = await Promise.all([
    readFile(appStylesPath, "utf8"),
    readFile(libraryPath, "utf8"),
    readFile(questionTagsPath, "utf8"),
  ]);

  const style = document.createElement("style");
  style.textContent = styles;
  document.head.append(style);
  const narrowRules = Array.from(style.sheet?.cssRules ?? [])
    .filter((rule): rule is CSSMediaRule => "media" in rule)
    .filter((rule) => rule.media.mediaText === "(max-width: 760px)")
    .flatMap((rule) => Array.from(rule.cssRules));
  const dialogRule = narrowRules.find(
    (rule) => "selectorText" in rule && rule.selectorText === ".review-flag-dialog",
  ) as CSSStyleRule | undefined;
  const reasonsRule = narrowRules.find(
    (rule) => "selectorText" in rule && rule.selectorText === ".review-flag-reasons",
  ) as CSSStyleRule | undefined;
  const legendRule = Array.from(style.sheet?.cssRules ?? []).find(
    (rule) =>
      "selectorText" in rule &&
      rule.selectorText === ".review-flag-form legend",
  ) as CSSStyleRule | undefined;
  assert.equal(legendRule?.style.getPropertyValue("margin-bottom"), "12px");
  assert.equal(
    dialogRule?.style.getPropertyValue("max-height"),
    "calc(100svh - 20px)",
  );
  assert.equal(dialogRule?.style.getPropertyValue("overflow"), "auto");
  assert.equal(
    reasonsRule?.style.getPropertyValue("grid-template-columns"),
    "minmax(0, 1fr)",
  );
  assert.equal(questionBank.includes("const [detailsOpen, setDetailsOpen] = useState(false)"), true);
  assert.equal(questionBank.includes('className="lean-question-detail-grid"'), true);
  assert.equal(questionBank.includes("hidden={!detailsOpen}"), true);
  assert.equal(questionBank.includes('aria-expanded={detailsOpen}'), true);
  assert.equal(questionBank.includes('"Show question details"'), true);
  assert.equal(questionBank.includes('"Hide question details"'), true);
  assert.equal(questionBank.includes('<ChevronDown className="lean-question-collapse-icon"'), true);
  assert.equal(questionBank.includes('<span className="lean-question-detail-label">Flag details</span>'), true);
  assert.equal(questionBank.includes('<span className="lean-question-detail-label">Answer standard</span>'), true);
  assert.equal(questionBank.includes("<summary>Flag details</summary>"), false);
  assert.equal(questionBank.includes("<summary>Answer standard</summary>"), false);
  assert.equal(questionBank.includes("flag.detail"), true);
  assert.equal(questionBank.includes("question-bank-flag-detail"), true);
  assert.equal(questionBank.includes('question.lifecycle !== "flagged"'), false);
  assert.equal(
    questionBank.includes(
      '<span className={`lean-lifecycle is-${question.lifecycle}`}>{question.lifecycle[0]?.toUpperCase()}{question.lifecycle.slice(1)}</span>',
    ),
    true,
  );
  assert.equal(questionBank.includes("const comparisonTags = ["), true);
  assert.equal(questionBank.includes('comparison: "missing" as const'), true);
  assert.equal(questionBank.includes('? "matched" as const'), true);
  assert.equal(questionBank.includes(': "extra" as const'), true);
  assert.equal(
    questionBank.includes(
      'ariaLabel={question.referenceTags === null ? "Predicted Tags" : "Tag comparison"}',
    ),
    true,
  );
  assert.equal(questionTags.includes('const tagClassName = `is-${tag.comparison ?? "unscored"}`'), true);
  assert.equal(questionBank.includes('className="lean-question-ground-truth"'), false);
  assert.equal(questionBank.includes("Ground Truth Tags"), false);
  assert.equal(styles.includes(".lean-question-tags button.is-missing"), true);
  assert.equal(styles.includes(".lean-question-tags button.is-extra"), true);
  assert.equal(questionBank.includes("Learner flag"), false);
  const questionFooterIndex = questionBank.indexOf(
    '<div className="lean-question-footer">',
  );
  const questionDateIndex = questionBank.indexOf(
    'className="lean-question-date"',
  );
  const questionToggleIndex = questionBank.indexOf(
    'aria-controls={`question-details-${question.id}`}',
  );
  assert.equal(questionDateIndex > questionFooterIndex, true);
  assert.equal(questionDateIndex < questionToggleIndex, true);
  assert.equal(styles.includes(".lean-flag-origin"), false);
  assert.equal(
    styles.includes(".lean-flag-reasons > span {\n  display: inline-flex"),
    false,
  );

  const tagRule = Array.from(style.sheet?.cssRules ?? []).find(
    (rule) =>
      "selectorText" in rule && rule.selectorText === ".lean-question-tags button",
  ) as CSSStyleRule | undefined;
  const questionFooterRule = Array.from(style.sheet?.cssRules ?? []).find(
    (rule) =>
      "selectorText" in rule && rule.selectorText === ".lean-question-footer",
  ) as CSSStyleRule | undefined;
  const collapsedQuestionRule = Array.from(style.sheet?.cssRules ?? []).find(
    (rule) =>
      "selectorText" in rule &&
      rule.selectorText === ".lean-question-row-collapsed",
  ) as CSSStyleRule | undefined;
  const collapsedQuestionHeadingRule = Array.from(
    style.sheet?.cssRules ?? [],
  ).find(
    (rule) =>
      "selectorText" in rule &&
      rule.selectorText ===
        ".lean-question-row-collapsed .lean-question-copy h2",
  ) as CSSStyleRule | undefined;
  const questionSideRule = Array.from(style.sheet?.cssRules ?? []).find(
    (rule) =>
      "selectorText" in rule && rule.selectorText === ".lean-question-side",
  ) as CSSStyleRule | undefined;
  const questionDateRule = Array.from(style.sheet?.cssRules ?? []).find(
    (rule) =>
      "selectorText" in rule && rule.selectorText === ".lean-question-date",
  ) as CSSStyleRule | undefined;
  assert.equal(tagRule?.style.getPropertyValue("border-radius"), "7px");
  assert.equal(tagRule?.style.getPropertyValue("cursor"), "pointer");
  assert.equal(questionFooterRule?.style.getPropertyValue("justify-content"), "flex-end");
  assert.equal(
    collapsedQuestionRule?.style.getPropertyValue("padding-bottom"),
    "10px",
  );
  assert.equal(
    collapsedQuestionHeadingRule?.style.getPropertyValue("margin-bottom"),
    "0",
  );
  assert.equal(questionSideRule?.style.getPropertyValue("flex-direction"), "column");
  assert.equal(
    questionSideRule?.style.getPropertyValue("justify-content"),
    "space-between",
  );
  assert.equal(questionDateRule?.style.getPropertyValue("display"), "inline-flex");
  assert.equal(questionDateRule?.style.getPropertyValue("white-space"), "nowrap");
  style.remove();
});

test("Review question scroller reserves room for the Flag interaction ring", async () => {
  const styles = await readFile(appStylesPath, "utf8");
  const style = document.createElement("style");
  style.textContent = styles;
  document.head.append(style);

  const rules = Array.from(style.sheet?.cssRules ?? []);
  const questionAreaRule = rules.find(
    (rule) => "selectorText" in rule && rule.selectorText === ".question-area",
  ) as CSSStyleRule | undefined;
  const flagStateRule = rules.find(
    (rule) =>
      "selectorText" in rule &&
      (rule as CSSStyleRule).selectorText.replace(/\s+/gu, " ") ===
        ".review-flag-trigger:hover, .review-flag-trigger:focus-visible",
  ) as CSSStyleRule | undefined;

  assert.ok(questionAreaRule);
  assert.ok(flagStateRule);

  const outlineWidth = Number.parseFloat(
    flagStateRule.style.getPropertyValue("outline"),
  );
  const outlineOffset = Number.parseFloat(
    flagStateRule.style.getPropertyValue("outline-offset"),
  );
  const inlinePadding = Number.parseFloat(
    questionAreaRule.style.getPropertyValue("padding-inline") || "0",
  );

  assert.ok(
    inlinePadding >= outlineWidth + outlineOffset,
    `Expected at least ${outlineWidth + outlineOffset}px inline clearance, received ${inlinePadding}px.`,
  );
  style.remove();
});

test("Library programmatic focus target suppresses the browser default outline", async () => {
  const [librarySource, styles] = await Promise.all([
    readFile(libraryPath, "utf8"),
    readFile(appStylesPath, "utf8"),
  ]);
  assert.equal(
    librarySource.includes(
      'className="question-bank-stage" id="library-panel" tabIndex={-1}',
    ),
    true,
  );
  assert.equal(
    librarySource.includes('document.getElementById("library-panel")?.focus()'),
    true,
  );

  const style = document.createElement("style");
  style.textContent = styles;
  document.head.append(style);
  const stageRule = Array.from(style.sheet?.cssRules ?? []).find(
    (rule) =>
      "selectorText" in rule && rule.selectorText === ".question-bank-stage",
  ) as CSSStyleRule | undefined;

  assert.ok(stageRule);
  assert.equal(stageRule.style.getPropertyValue("outline"), "0");
  style.remove();
});
