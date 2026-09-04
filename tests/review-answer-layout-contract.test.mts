import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const styles = await readFile(
  new URL("../app/(app)/app-globals.css", import.meta.url),
  "utf8",
);
const reviewApp = await readFile(
  new URL("../app/(app)/review/ReviewApp.tsx", import.meta.url),
  "utf8",
);
const reviewQueueRoute = await readFile(
  new URL("../app/api/v2/review/queue/route.ts", import.meta.url),
  "utf8",
);
const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
const style = dom.window.document.createElement("style");
style.textContent = styles;
dom.window.document.head.append(style);

function styleRule(selector: string): CSSStyleRule | undefined {
  return Array.from(style.sheet?.cssRules ?? []).find(
    (rule): rule is CSSStyleRule =>
      "selectorText" in rule && rule.selectorText === selector,
  );
}

test("resolved-answer metadata stays in flow and cannot cover evaluation controls", () => {
  const footer = styleRule(".previous-row-footer");
  const metadata = styleRule(".previous-row-meta");
  assert.ok(footer);
  assert.ok(metadata);
  assert.equal(footer.style.getPropertyValue("display"), "flex");
  assert.equal(
    footer.style.getPropertyValue("justify-content"),
    "space-between",
  );
  assert.equal(metadata.style.getPropertyValue("position"), "static");
  assert.equal(metadata.style.getPropertyValue("flex"), "1 1 auto");
  assert.equal(metadata.style.getPropertyValue("width"), "auto");
});

test("previous answers start collapsed but a newly completed evaluation opens", () => {
  assert.match(reviewApp, /const \[open, setOpen\] = useState\(false\);/u);
  assert.match(
    reviewApp,
    /previousEvaluationStatus\.current === "pending"\s*&&\s*evaluation\.status !== "pending"/u,
  );
});

test("only expanded answers put the Markdown copy action in the bottom-left footer", () => {
  assert.match(reviewApp, /hidden=\{!open\}/u);
  assert.match(
    reviewApp,
    /<div className="previous-row-footer">\s*\{open \? \(\s*<div className="review-handoff-actions">/u,
  );
  assert.match(reviewApp, /aria-label="Copy review as Markdown"/u);
  assert.doesNotMatch(reviewApp, />Copy Markdown</u);
  assert.match(
    reviewApp,
    /navigator\.clipboard\.writeText\(reviewHandoffMarkdown\(turn\)\)/u,
  );
  const actions = styleRule(".review-handoff-actions");
  assert.ok(actions);
  assert.equal(actions.style.getPropertyValue("justify-content"), "flex-start");
});

test("Review presents learner-friendly results without internal domain labels", () => {
  assert.match(reviewApp, /Result:/u);
  assert.match(
    reviewApp,
    /incorrect: \{ label: "Incorrect", symbol: "C" \}/u,
  );
  assert.match(reviewApp, /partial: \{ label: "Partial", symbol: "B" \}/u);
  assert.match(reviewApp, /correct: \{ label: "Correct", symbol: "A" \}/u);
  assert.match(
    reviewApp,
    /evaluation\.canCorrectRecallResult \? \(\s*<fieldset className="review-grade-correction">/u,
  );
  assert.doesNotMatch(reviewApp, /correctionOpen/u);
  assert.match(reviewApp, /Change evaluation/u);
  assert.doesNotMatch(reviewApp, /Recall (?:Target|Result)/u);
  assert.match(reviewApp, /Retry evaluation/u);
  assert.doesNotMatch(reviewApp, /GRADE_DISPLAY/u);
  assert.doesNotMatch(reviewApp, /\["again", "hard", "good", "easy"\]/u);
});

test("Review can advance to another due Question without submitting an answer", () => {
  assert.match(reviewApp, /aria-label="Next question"/u);
  assert.doesNotMatch(reviewApp, /<span>Next<\/span>/u);
  assert.match(reviewApp, /onClick=\{nextQuestion\}/u);
  assert.match(
    reviewApp,
    /loadQueue\(\{ afterQuestionId: current\.questionId \}\)/u,
  );
  assert.match(reviewApp, /question\.total <= 1/u);
  assert.match(reviewApp, /(?:setAnswer|updateAnswer)\(""\)/u);
  assert.match(reviewQueueRoute, /searchParams\.get\("afterQuestionId"\)/u);
});

test("answer submission keeps its text until the next Review state is ready", () => {
  const submitStart = reviewApp.indexOf(
    "async function submit(event: FormEvent) {",
  );
  const submitEnd = reviewApp.indexOf(
    "\n  async function nextQuestion()",
    submitStart,
  );
  const submit = reviewApp.slice(submitStart, submitEnd);
  const requestIndex = submit.indexOf("await jsonRequest(");
  const clearDraftIndex = submit.indexOf(
    'viewCache.writeReviewDraft(question.questionId, "");',
  );
  const loadQueueIndex = submit.indexOf("await loadQueue();");

  assert.equal(submitStart >= 0, true);
  assert.equal(submitEnd > submitStart, true);
  assert.equal(requestIndex >= 0, true);
  assert.equal(clearDraftIndex > requestIndex, true);
  assert.equal(loadQueueIndex > clearDraftIndex, true);
  assert.doesNotMatch(submit.slice(0, requestIndex), /updateAnswer\(""\)/u);
  assert.match(reviewApp, /disabled=\{isSubmitting \|\| isAdvancing\}/u);
  assert.match(
    reviewApp,
    /isSubmitting \? <LoaderCircle className="v2-spin" \/> : undefined/u,
  );
});

test("Review shows the shared Question Tags above the current Prompt", () => {
  const tagsIndex = reviewApp.indexOf(
    '<QuestionTags\n                  ariaLabel="Predicted Tags"',
  );
  const headingIndex = reviewApp.indexOf(
    '<div className="review-question-heading">',
  );
  assert.equal(tagsIndex >= 0, true);
  assert.equal(headingIndex > tagsIndex, true);
  assert.match(reviewApp, /className="review-question-tags"/u);
  assert.match(reviewApp, /tags=\{question\.relatedTags\}/u);
});
