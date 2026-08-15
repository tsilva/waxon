import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewPlan, type PlanCandidate } from "../app/lib/v2/planner.ts";
import {
  assessQuestionQuality,
  normalizeExactAnswer,
  recallTargetKey,
} from "../app/lib/v2/questionQuality.ts";
import {
  applyFsrsGrade,
  memoryRetrievability,
} from "../app/lib/v2/scheduler.ts";
import {
  MINIMUM_SOLO_RETRY_DELAY_MS,
  retryEarliestAt,
} from "../app/lib/v2/retryPolicy.ts";
import { extractPdfText } from "../app/lib/v2/pdf.ts";
import { normalizeGeneratedAnswerMode } from "../app/lib/v2/generatedAnswerMode.ts";
import { alignEvidenceQuote } from "../app/lib/v2/evidenceQuote.ts";
import { inferSourceCapture } from "../app/lib/v2/sourceCapture.ts";
import { extractRemoteSourceText } from "../app/lib/v2/sourceText.ts";
import {
  normalizeLearningPath,
  removeSharedQuestionEdges,
} from "../app/lib/v2/learningPath.ts";

const now = new Date("2026-07-25T10:00:00.000Z");

function minimalTextPdf(text: string): Uint8Array {
  const escaped = text.replace(/[()\\]/gu, (value) => `\\${value}`);
  const stream = `BT /F1 18 Tf 50 100 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "ascii"));
}

function candidate(
  overrides: Partial<PlanCandidate> & Pick<PlanCandidate, "questionId">,
): PlanCandidate {
  return {
    questionVersionId: `${overrides.questionId}-version`,
    lifecycle: "review",
    answerMode: "semantic",
    dueAt: new Date(now.getTime() - 86_400_000),
    retrievability: 0.6,
    importance: 1,
    hasGap: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

test("v2 quality gates reject broad and non-retrieval prompts", () => {
  const broad = assessQuestionQuality({
    prompt: "Explain everything about transformers?",
    referenceAnswer: "A very broad answer.",
    target: "Transformers",
  });
  const atomic = assessQuestionQuality({
    prompt: "Why are attention logits divided by the square root of key dimension?",
    referenceAnswer:
      "It keeps their variance controlled so softmax does not saturate as key dimension grows.",
    target: "Purpose of scaled dot-product attention",
  });

  assert.equal(broad.passes, false);
  assert.match(broad.reasons.join(" "), /atomic/iu);
  assert.equal(atomic.passes, true);
});

test("v2 target and exact-answer normalization are stable", () => {
  assert.equal(
    recallTargetKey("Scaled dot-product attention."),
    recallTargetKey("  SCALED dot product_attention! "),
  );
  assert.equal(normalizeExactAnswer("  AdamW\n"), normalizeExactAnswer("adamw"));
});

test("v2 planner prioritizes fragile important memories and reserves retry time", () => {
  const plan = buildReviewPlan({
    now,
    timeBudgetMinutes: 4,
    desiredRetention: 0.9,
    newItemsPerDay: 5,
    candidates: [
      candidate({
        questionId: "healthy",
        retrievability: 0.88,
        importance: 1,
      }),
      candidate({
        questionId: "fragile",
        retrievability: 0.3,
        importance: 2,
      }),
      candidate({
        questionId: "new",
        lifecycle: "new",
        dueAt: null,
        retrievability: null,
      }),
    ],
  });

  assert.deepEqual(
    plan.map((item) => item.questionId),
    ["fragile", "healthy"],
  );
  assert.equal(
    plan.reduce((sum, item) => sum + item.estimatedSeconds * 2, 0) <= 240,
    true,
  );
});

test("v2 planner caps new admissions independently of bank size", () => {
  const plan = buildReviewPlan({
    now,
    timeBudgetMinutes: 30,
    desiredRetention: 0.9,
    newItemsPerDay: 2,
    candidates: Array.from({ length: 20 }, (_, index) =>
      candidate({
        questionId: `new-${index}`,
        lifecycle: "new",
        dueAt: null,
        retrievability: null,
      }),
    ),
  });

  assert.equal(plan.length, 2);
});

test("v2 planner keeps due work first and prefers the explicitly focused path", () => {
  const plan = buildReviewPlan({
    now,
    timeBudgetMinutes: 10,
    desiredRetention: 0.9,
    newItemsPerDay: 2,
    candidates: [
      candidate({ questionId: "due" }),
      candidate({
        questionId: "unrelated-new",
        lifecycle: "new",
        dueAt: null,
        retrievability: null,
        importance: 10,
      }),
      candidate({
        questionId: "focused-new",
        lifecycle: "new",
        dueAt: null,
        retrievability: null,
        path: {
          nodeIds: ["node-1"],
          sourceContext: {
            sourceId: "source-1",
            sourceTitle: "Policy optimization",
            moduleTitle: "Foundations",
            checkpoint: 1,
            checkpointTotal: 8,
          },
        },
      }),
    ],
  });
  assert.deepEqual(
    plan.map((item) => item.questionId),
    ["due", "focused-new", "unrelated-new"],
  );
});

test("learning-path validation lets prerequisites override source position", () => {
  const path = normalizeLearningPath({
    targets: [
      { key: "advanced", statement: "Advanced objective", sourcePosition: 10 },
      { key: "foundation", statement: "Foundation", sourcePosition: 20 },
    ],
    draft: {
      modules: [{ key: "core", title: "Core" }],
      nodes: [
        {
          targetKey: "advanced",
          moduleKey: "core",
          prerequisiteTargetKeys: ["foundation"],
          externalPrerequisiteKeys: [],
        },
        {
          targetKey: "foundation",
          moduleKey: "core",
          prerequisiteTargetKeys: [],
          externalPrerequisiteKeys: [],
        },
      ],
      externalPrerequisites: [],
    },
  });
  assert.equal(path.status, "ready");
  assert.deepEqual(path.nodes.map((node) => node.key), ["foundation", "advanced"]);
});

test("invalid learning-path cycles fall back to a strict source-order chain", () => {
  const path = normalizeLearningPath({
    targets: [
      { key: "first", statement: "First", sourcePosition: 1 },
      { key: "second", statement: "Second", sourcePosition: 2 },
    ],
    draft: {
      modules: [{ key: "core", title: "Core" }],
      nodes: [
        {
          targetKey: "first",
          moduleKey: "core",
          prerequisiteTargetKeys: ["second"],
          externalPrerequisiteKeys: [],
        },
        {
          targetKey: "second",
          moduleKey: "core",
          prerequisiteTargetKeys: ["first"],
          externalPrerequisiteKeys: [],
        },
      ],
      externalPrerequisites: [],
    },
  });
  assert.equal(path.status, "fallback_ready");
  assert.deepEqual(path.nodes.map((node) => node.key), ["first", "second"]);
  assert.deepEqual(path.edges, [
    { prerequisiteKey: "first", dependentKey: "second" },
  ]);
});

test("learning paths remove dependencies inside one reused bank question", () => {
  const edges = removeSharedQuestionEdges(
    [
      { prerequisiteKey: "foundation", dependentKey: "application" },
      { prerequisiteKey: "application", dependentKey: "diagnostic" },
    ],
    new Map([
      ["foundation", "shared-question"],
      ["application", "shared-question"],
      ["diagnostic", "different-question"],
    ]),
  );
  assert.deepEqual(edges, [
    { prerequisiteKey: "application", dependentKey: "diagnostic" },
  ]);
});

test("v2 planner protects every at-risk item when it fits", () => {
  const due = [
    candidate({ questionId: "a", answerMode: "exact" }),
    candidate({ questionId: "b", answerMode: "semantic" }),
    candidate({ questionId: "c", answerMode: "rubric" }),
  ];
  const plan = buildReviewPlan({
    now,
    timeBudgetMinutes: 10,
    desiredRetention: 0.9,
    newItemsPerDay: 0,
    candidates: due,
  });

  assert.deepEqual(
    new Set(plan.map((item) => item.questionId)),
    new Set(due.map((item) => item.questionId)),
  );
});

test("adding planner capacity cannot remove protected due work", () => {
  const candidates = Array.from({ length: 12 }, (_, index) =>
    candidate({
      questionId: `due-${index}`,
      answerMode: index % 3 === 0 ? "rubric" : "semantic",
      retrievability: 0.2 + index * 0.03,
    }),
  );
  const smaller = buildReviewPlan({
    now,
    timeBudgetMinutes: 5,
    desiredRetention: 0.9,
    newItemsPerDay: 0,
    candidates,
  });
  const larger = buildReviewPlan({
    now,
    timeBudgetMinutes: 10,
    desiredRetention: 0.9,
    newItemsPerDay: 0,
    candidates,
  });
  const largerIds = new Set(larger.map((item) => item.questionId));

  assert.equal(
    smaller.every((item) => largerIds.has(item.questionId)),
    true,
  );
});

test("exact mode normalizes Japanese width and case without translating", () => {
  assert.equal(normalizeExactAnswer(" ＡＤＡＭＷ "), "adamw");
  assert.equal(normalizeExactAnswer("勾配 降下"), "勾配 降下");
});

test("v2 retry policy is delayed unless a different question intervenes", () => {
  assert.equal(
    retryEarliestAt({
      hasDifferentQuestionAfter: false,
      now,
    }).getTime(),
    now.getTime() + MINIMUM_SOLO_RETRY_DELAY_MS,
  );
  assert.equal(
    retryEarliestAt({
      hasDifferentQuestionAfter: true,
      now,
    }).getTime(),
    now.getTime(),
  );
});

test("v2 FSRS lengthens successful recall and makes failure conservative", () => {
  const first = applyFsrsGrade({
    memory: null,
    grade: "good",
    desiredRetention: 0.9,
    now,
  });
  const secondAt = new Date(first.dueAt.getTime() + 1_000);
  const second = applyFsrsGrade({
    memory: first,
    grade: "good",
    desiredRetention: 0.9,
    now: secondAt,
  });
  const failed = applyFsrsGrade({
    memory: second,
    grade: "again",
    desiredRetention: 0.9,
    now: new Date(second.dueAt.getTime() + 1_000),
  });

  assert.equal(second.scheduledDays >= first.scheduledDays, true);
  assert.equal(failed.lapses > second.lapses, true);
  assert.equal(
    memoryRetrievability({
      memory: failed,
      desiredRetention: 0.9,
      at: failed.dueAt,
    }) <= 1,
    true,
  );
});

test("v2 PDF extraction installs Node canvas globals and reads text", async () => {
  const text = await extractPdfText(
    minimalTextPdf("Proximal Policy Optimization"),
  );

  assert.match(text, /Proximal Policy Optimization/u);
  assert.equal(typeof globalThis.DOMMatrix, "function");
  assert.equal(
    typeof (
      globalThis as typeof globalThis & {
        pdfjsWorker?: { WorkerMessageHandler?: unknown };
      }
    ).pdfjsWorker?.WorkerMessageHandler,
    "function",
  );
});

test("v2 PDF extraction rejects malformed documents", async () => {
  await assert.rejects(
    () => extractPdfText(new TextEncoder().encode("%PDF-1.4\nmalformed")),
    /Invalid PDF|InvalidPDFException|PDF structure/u,
  );
});

test("v2 remote source extraction recognizes PDF URLs by content type", async () => {
  const text = await extractRemoteSourceText({
    bytes: minimalTextPdf("Knowledge from a PDF URL"),
    contentType: "application/pdf; charset=binary",
  });

  assert.match(text, /Knowledge from a PDF URL/u);
});

test("v2 remote source extraction recognizes PDFs with generic content types", async () => {
  const text = await extractRemoteSourceText({
    bytes: minimalTextPdf("PDF signature fallback"),
    contentType: "application/octet-stream",
  });

  assert.match(text, /PDF signature fallback/u);
});

test("v2 remote source extraction preserves ordinary URL text", async () => {
  const text = await extractRemoteSourceText({
    bytes: new TextEncoder().encode("A normal article body"),
    contentType: "text/html; charset=utf-8",
  });

  assert.equal(text, "A normal article body");
});

test("v2 source generation accepts common semantic answer-mode aliases", () => {
  assert.equal(normalizeGeneratedAnswerMode("semantic"), "semantic");
  assert.equal(normalizeGeneratedAnswerMode("text"), "semantic");
  assert.equal(normalizeGeneratedAnswerMode("short"), "semantic");
  assert.equal(normalizeGeneratedAnswerMode("long"), "semantic");
  assert.equal(normalizeGeneratedAnswerMode("free_text"), "semantic");
  assert.equal(normalizeGeneratedAnswerMode("multi-point"), "rubric");
  assert.equal(normalizeGeneratedAnswerMode("unsupported-mode"), null);
});

test("v2 source capture infers a topic, URL, or pasted source", () => {
  assert.deepEqual(inferSourceCapture("Proximal Policy Optimization"), {
    kind: "topic",
    title: "Proximal Policy Optimization",
    text: "Proximal Policy Optimization",
  });
  assert.deepEqual(inferSourceCapture("https://example.com/ppo"), {
    kind: "url",
    title: "https://example.com/ppo",
    url: "https://example.com/ppo",
  });
  assert.deepEqual(inferSourceCapture("PPO notes\nThe clipped objective limits policy updates."), {
    kind: "paste",
    title: "PPO notes",
    text: "PPO notes\nThe clipped objective limits policy updates.",
  });
});

test("v2 evidence alignment maps PDF hyphenation back to an exact quote", () => {
  const source =
    "Methods which al- ternate between sampling data and optimizing a surrogate objective.";
  const aligned = alignEvidenceQuote(
    source,
    "which alternate between sampling data and optimizing a surrogate objective",
  );

  assert.deepEqual(aligned, {
    quote:
      "which al- ternate between sampling data and optimizing a surrogate objective",
    startOffset: 8,
    endOffset: 84,
  });
  assert.equal(
    alignEvidenceQuote(
      source,
      "PPO guarantees monotonic improvement for every optimization step.",
    ),
    null,
  );
});
