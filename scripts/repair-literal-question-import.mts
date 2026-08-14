#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import { assessQuestionQuality } from "../app/lib/v2/questionQuality.ts";
import { extractJsonObject } from "../shared/json-object.mts";
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_OPENROUTER_CHAT_MODEL,
  OPENROUTER_CHAT_URL,
  OPENROUTER_EMBEDDINGS_URL,
  buildOpenRouterHeaders,
  resolveEmbeddingModel,
  resolveOpenRouterApiKey,
  resolveOpenRouterModel,
} from "../shared/openrouter-config.mts";

type AnswerMode = "semantic" | "rubric" | "exact";

type ImportedQuestion = {
  targetId: string;
  targetKey: string;
  targetType: string;
  statement: string;
  questionId: string;
  versionId: string;
  version: number;
  prompt: string;
  referenceAnswer: string;
  displayAnswer: string;
  answerMode: AnswerMode;
  targetText: string;
  quality: string;
  qualityReasons: string[];
  recallEvidenceId: string;
  sourceOffset: number;
  section: string;
  order: number;
};

type GeneratedAnswer = {
  id: string;
  answer: string;
  displayAnswer: string;
  answerMode: AnswerMode;
  confidence: number;
};

type CriticDecision = GeneratedAnswer & {
  status: "approved" | "revised" | "rejected";
  reasons: string[];
};

type Usage = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
};

type ParsedArgs = {
  sourceId: string;
  apply: boolean;
  expectedCount: number;
  mergeHeld: boolean;
};

const REPAIR_POLICY = "literal-question-answer-repair-v1";
const DEFAULT_EXPECTED_COUNT = 250;
const ANSWER_BATCH_SIZE = 18;
const MAX_RETRIES = 3;

function emptyUsage(): Usage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
}

function addUsage(total: Usage, next: Usage): Usage {
  return {
    calls: total.calls + next.calls,
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    totalTokens: total.totalTokens + next.totalTokens,
    cost: total.cost + next.cost,
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFrom(body: Record<string, unknown>): Usage {
  const usage = body.usage && typeof body.usage === "object"
    ? body.usage as Record<string, unknown>
    : {};
  const inputTokens = numberValue(usage.prompt_tokens) || numberValue(usage.input_tokens);
  const outputTokens = numberValue(usage.completion_tokens) || numberValue(usage.output_tokens);
  return {
    calls: 1,
    inputTokens,
    outputTokens,
    totalTokens: numberValue(usage.total_tokens) || inputTokens + outputTokens,
    cost: numberValue(usage.cost),
  };
}

function chatText(body: Record<string, unknown>): string {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const text = (part as Record<string, unknown>).text;
    return typeof text === "string" ? text : "";
  }).join("");
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The model response was not a JSON object.");
  }
  return value as Record<string, unknown>;
}

function asStrings(value: unknown, limit = 12): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, limit)
    : [];
}

function normalizeMode(value: unknown): AnswerMode {
  return value === "rubric" || value === "exact" ? value : "semantic";
}

function normalizeConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function requireText(value: unknown, name: string, limit: number): string {
  const result = typeof value === "string" ? value.trim().slice(0, limit) : "";
  if (!result) throw new Error(`Model response is missing ${name}.`);
  return result;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let sourceId = "";
  let apply = false;
  let expectedCount = DEFAULT_EXPECTED_COUNT;
  let mergeHeld = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--source-id") {
      sourceId = argv[index + 1] ?? "";
      index += 1;
    } else if (value === "--expected-count") {
      expectedCount = Number(argv[index + 1]);
      index += 1;
    } else if (value === "--apply") {
      apply = true;
    } else if (value === "--dry-run") {
      apply = false;
    } else if (value === "--merge-held") {
      mergeHeld = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(sourceId)) {
    throw new Error("--source-id must be a UUID.");
  }
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 1_000) {
    throw new Error("--expected-count must be an integer from 1 to 1000.");
  }
  return { sourceId, apply, expectedCount, mergeHeld };
}

export function sourceSections(rawText: string): Array<{ title: string; offset: number }> {
  const sections: Array<{ title: string; offset: number }> = [];
  for (const match of rawText.matchAll(/^##\s+(.+)$/gmu)) {
    const title = match[1]?.trim() ?? "";
    if (/^[IVXLCDM]+\.\s+/u.test(title)) {
      sections.push({ title, offset: match.index ?? 0 });
    }
  }
  return sections;
}

export function sectionForOffset(
  sections: Array<{ title: string; offset: number }>,
  offset: number,
): string {
  let current = "Imported questions";
  for (const section of sections) {
    if (section.offset > offset) break;
    current = section.title;
  }
  return current;
}

export function buildSynthesisDocument(
  questions: Array<{ prompt: string; answer: string; section: string; order: number }>,
): { body: string; spans: Array<{ startOffset: number; endOffset: number; quote: string }> } {
  let body = `# Model-synthesized reference answers\n\n` +
    `These answers were generated and independently checked to repair a question-only import. ` +
    `They are model synthesis, not quotations from an external source.\n`;
  const spans: Array<{ startOffset: number; endOffset: number; quote: string }> = [];
  let priorSection = "";
  for (const question of questions.sort((left, right) => left.order - right.order)) {
    if (question.section !== priorSection) {
      body += `\n## ${question.section}\n`;
      priorSection = question.section;
    }
    body += `\n### ${question.order + 1}. ${question.prompt}\n\n`;
    const startOffset = body.length;
    body += question.answer;
    spans.push({ startOffset, endOffset: body.length, quote: question.answer });
    body += "\n";
  }
  return { body, spans };
}

function chunkBySection(questions: ImportedQuestion[]): ImportedQuestion[][] {
  const chunks: ImportedQuestion[][] = [];
  let current: ImportedQuestion[] = [];
  for (const question of questions) {
    if (
      current.length > 0 &&
      (current.length >= ANSWER_BATCH_SIZE || current[0]?.section !== question.section)
    ) {
      chunks.push(current);
      current = [];
    }
    current.push(question);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function requestJson(input: {
  apiKey: string;
  model: string;
  userId: string;
  operation: string;
  system: string;
  payload: unknown;
  maxTokens: number;
}): Promise<{ parsed: Record<string, unknown>; usage: Usage }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers: buildOpenRouterHeaders(input.apiKey),
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: input.model,
          temperature: 0,
          max_tokens: input.maxTokens,
          response_format: { type: "json_object" },
          user: input.userId,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: JSON.stringify(input.payload) },
          ],
        }),
      });
      const body = asObject(await response.json());
      if (!response.ok) {
        const error = body.error && typeof body.error === "object"
          ? body.error as Record<string, unknown>
          : {};
        const detail = chatText(body) || (typeof error.message === "string" ? error.message : "Provider rejected the request.");
        throw new Error(`${input.operation} failed (${response.status}): ${detail.slice(0, 300)}`);
      }
      const parsed = extractJsonObject(chatText(body));
      return { parsed: asObject(parsed), usage: usageFrom(body) };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${input.operation} failed.`);
}

function parseGeneratedAnswers(
  parsed: Record<string, unknown>,
  expectedIds: Set<string>,
): GeneratedAnswer[] {
  const rawAnswers = Array.isArray(parsed.answers) ? parsed.answers : [];
  const seen = new Set<string>();
  const answers = rawAnswers.map((raw) => {
    const item = asObject(raw);
    const id = requireText(item.id, "answer id", 80);
    if (!expectedIds.has(id) || seen.has(id)) {
      throw new Error(`Model returned an unexpected or repeated answer id: ${id}`);
    }
    seen.add(id);
    const answer = requireText(item.answer, `answer for ${id}`, 65_536);
    return {
      id,
      answer,
      displayAnswer:
        (typeof item.displayAnswer === "string" && item.displayAnswer.trim()
          ? item.displayAnswer.trim()
          : answer).slice(0, 8_000),
      answerMode: normalizeMode(item.answerMode),
      confidence: normalizeConfidence(item.confidence),
    };
  });
  if (seen.size !== expectedIds.size) {
    const missing = [...expectedIds].filter((id) => !seen.has(id));
    throw new Error(`Model omitted ${missing.length} answer(s): ${missing.slice(0, 3).join(", ")}`);
  }
  return answers;
}

function parseCriticDecisions(
  parsed: Record<string, unknown>,
  generated: Map<string, GeneratedAnswer>,
): CriticDecision[] {
  const rawDecisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const seen = new Set<string>();
  const decisions = rawDecisions.map((raw) => {
    const item = asObject(raw);
    const id = requireText(item.id, "critic id", 80);
    const original = generated.get(id);
    if (!original || seen.has(id)) {
      throw new Error(`Critic returned an unexpected or repeated id: ${id}`);
    }
    seen.add(id);
    const rawStatus = item.status;
    const status: CriticDecision["status"] = rawStatus === "approved" || rawStatus === "revised"
      ? rawStatus
      : "rejected";
    const answer = status === "revised"
      ? requireText(item.answer, `revised answer for ${id}`, 65_536)
      : original.answer;
    return {
      id,
      status,
      answer,
      displayAnswer:
        (status === "revised" && typeof item.displayAnswer === "string" && item.displayAnswer.trim()
          ? item.displayAnswer.trim()
          : status === "revised"
            ? answer
            : original.displayAnswer).slice(0, 8_000),
      answerMode: status === "revised" ? normalizeMode(item.answerMode) : original.answerMode,
      confidence: normalizeConfidence(item.confidence),
      reasons: asStrings(item.reasons),
    };
  });
  if (seen.size !== generated.size) {
    throw new Error(`Critic omitted ${generated.size - seen.size} decision(s).`);
  }
  return decisions;
}

async function generateAnswers(input: {
  apiKey: string;
  model: string;
  criticModel: string;
  userId: string;
  questions: ImportedQuestion[];
}): Promise<{ decisions: CriticDecision[]; usage: Usage }> {
  let usage = emptyUsage();
  const decisions: CriticDecision[] = [];
  const batches = chunkBySection(input.questions);
  for (const [batchIndex, batch] of batches.entries()) {
    const aliases = new Map(batch.map((question, index) => [question.questionId, `Q${index + 1}`]));
    const expectedIds = new Set(aliases.values());
    const generatedResult = await requestJson({
      apiKey: input.apiKey,
      model: input.model,
      userId: input.userId,
      operation: "literal-question-reference-answer",
      maxTokens: 9_000,
      system:
        "Write a rigorous reference answer for every supplied closed-book AI/ML question. Return JSON only: {answers:[{id,answer,displayAnswer,answerMode,confidence}]}. Echo every opaque id exactly once and preserve input order. Answers must be correct, self-contained, concise but complete enough to grade free recall, and must state assumptions when the answer depends on them. Use Markdown $...$ for math and backticks for code or APIs. Use exact mode only when literal notation or wording must match, rubric for multiple independently required points, and semantic otherwise. Do not mention this task, the model, confidence, or the source in an answer. Never invent experiment results, repository facts, citations, or current facts. Set confidence from 0 to 1 based on factual certainty.",
      payload: {
        section: batch[0]?.section,
        questions: batch.map((question) => ({ id: aliases.get(question.questionId), prompt: question.prompt })),
      },
    });
    usage = addUsage(usage, generatedResult.usage);
    const generated = parseGeneratedAnswers(generatedResult.parsed, expectedIds);
    const generatedById = new Map(generated.map((answer) => [answer.id, answer]));
    const criticResult = await requestJson({
      apiKey: input.apiKey,
      model: input.criticModel,
      userId: input.userId,
      operation: "literal-question-reference-answer-critic",
      maxTokens: 9_000,
      system:
        "Independently audit each proposed AI/ML reference answer for factual and mathematical correctness, completeness for the exact prompt, atomic scope, notation, and gradability. Return JSON only: {decisions:[{id,status,answer,displayAnswer,answerMode,confidence,reasons}]}. Echo every id exactly once. status is approved, revised, or rejected. Revise any fixable answer and provide the complete replacement answer; reject only when the prompt is materially ambiguous or a dependable answer cannot be supplied. Check calculations and equations explicitly. Do not approve fluent but unsupported claims. Confidence is 0 to 1.",
      payload: {
        section: batch[0]?.section,
        items: batch.map((question) => {
          const id = aliases.get(question.questionId) as string;
          return { id, prompt: question.prompt, ...generatedById.get(id) };
        }),
      },
    });
    usage = addUsage(usage, criticResult.usage);
    const batchDecisions = parseCriticDecisions(criticResult.parsed, generatedById);
    const questionIdByAlias = new Map([...aliases.entries()].map(([questionId, alias]) => [alias, questionId]));
    decisions.push(...batchDecisions.map((decision) => ({
      ...decision,
      id: questionIdByAlias.get(decision.id) as string,
    })));
    console.log(`Answered and checked batch ${batchIndex + 1}/${batches.length} (${batch.length} questions).`);
  }
  return { decisions, usage };
}

async function detectSemanticDuplicates(input: {
  apiKey: string;
  model: string;
  userId: string;
  questions: ImportedQuestion[];
  decisions: CriticDecision[];
  existing: Array<{ id: string; prompt: string; referenceAnswer: string; lifecycle: string }>;
}): Promise<{
  nonDistinct: Map<string, { decision: "duplicate" | "uncertain"; duplicateOf: string | null; rationale: string }>;
  usage: Usage;
}> {
  const answerById = new Map(input.decisions.map((decision) => [decision.id, decision]));
  const candidateAliases = new Map(input.questions.map((question, index) => [question.questionId, `C${String(index + 1).padStart(3, "0")}`]));
  const existingAliases = new Map(input.existing.map((question, index) => [question.id, `E${String(index + 1).padStart(3, "0")}`]));
  const result = await requestJson({
    apiKey: input.apiKey,
    model: input.model,
    userId: input.userId,
    operation: "literal-question-semantic-dedupe",
    maxTokens: 7_000,
    system:
      "Audit a question bank for semantic duplicates before activation. Return JSON only: {nonDistinct:[{id,decision,duplicateOf,rationale}]}. Report only duplicate or genuinely uncertain candidates; omit distinct candidates. A duplicate tests the same recall target and expects essentially the same answer. Questions about related concepts, different terms in one equation, prerequisites, consequences, comparisons, mechanisms, or failure modes are distinct. Prefer an existing bank question as canonical; otherwise prefer the earlier candidate id. decision is duplicate or uncertain. duplicateOf is required for duplicate and null for uncertain. Never treat topical similarity alone as duplication.",
    payload: {
      candidates: input.questions.map((question) => ({
        id: candidateAliases.get(question.questionId),
        prompt: question.prompt,
        answer: answerById.get(question.questionId)?.answer.slice(0, 2_000),
      })),
      existingBank: input.existing.map((question) => ({
        id: existingAliases.get(question.id),
        prompt: question.prompt,
        answer: question.referenceAnswer.slice(0, 2_000),
        lifecycle: question.lifecycle,
      })),
    },
  });
  const rawItems = Array.isArray(result.parsed.nonDistinct) ? result.parsed.nonDistinct : [];
  const candidateIdByAlias = new Map([...candidateAliases.entries()].map(([id, alias]) => [alias, id]));
  const canonicalIdByAlias = new Map([
    ...[...candidateAliases.entries()].map(([id, alias]) => [alias, id] as const),
    ...[...existingAliases.entries()].map(([id, alias]) => [alias, id] as const),
  ]);
  const nonDistinct = new Map<string, { decision: "duplicate" | "uncertain"; duplicateOf: string | null; rationale: string }>();
  for (const raw of rawItems) {
    const item = asObject(raw);
    const alias = requireText(item.id, "dedupe id", 20);
    const questionId = candidateIdByAlias.get(alias);
    if (!questionId || nonDistinct.has(questionId)) {
      throw new Error(`Dedupe judge returned an unexpected candidate id: ${alias}`);
    }
    const decision = item.decision === "duplicate" ? "duplicate" : "uncertain";
    const duplicateAlias = typeof item.duplicateOf === "string" ? item.duplicateOf : "";
    const duplicateOf = decision === "duplicate" ? canonicalIdByAlias.get(duplicateAlias) ?? null : null;
    if (decision === "duplicate" && !duplicateOf) {
      throw new Error(`Dedupe judge returned an invalid canonical id: ${duplicateAlias}`);
    }
    nonDistinct.set(questionId, {
      decision,
      duplicateOf,
      rationale: typeof item.rationale === "string" ? item.rationale.trim().slice(0, 2_000) : "Semantic overlap requires attention.",
    });
  }
  return { nonDistinct, usage: result.usage };
}

async function requestEmbeddings(input: {
  apiKey: string;
  model: string;
  userId: string;
  texts: string[];
}): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let offset = 0; offset < input.texts.length; offset += 64) {
    const chunk = input.texts.slice(offset, offset + 64);
    const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
      method: "POST",
      headers: buildOpenRouterHeaders(input.apiKey),
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: input.model,
        input: chunk,
        encoding_format: "float",
        user: input.userId,
      }),
    });
    const body = asObject(await response.json());
    if (!response.ok) throw new Error(`Embedding request failed (${response.status}).`);
    const data = Array.isArray(body.data) ? body.data : [];
    const vectors = data.map((item) => {
      const embedding = asObject(item).embedding;
      if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new Error("Embedding response has an invalid vector.");
      }
      return embedding as number[];
    });
    if (vectors.length !== chunk.length) throw new Error("Embedding response count does not match input count.");
    embeddings.push(...vectors);
    console.log(`Embedded ${Math.min(offset + chunk.length, input.texts.length)}/${input.texts.length} repaired questions.`);
  }
  return embeddings;
}

async function loadRepairContext(pool: Pool, sourceId: string, expectedCount: number) {
  const sourceResult = await pool.query<{
    id: string;
    user_id: string;
    title: string;
    kind: string;
    status: string;
    raw_text: string;
    active_revision_id: string;
    active_run_id: string;
    run_status: string;
    run_model: string;
    run_critic_model: string;
    path_id: string;
    path_status: string;
    material_metadata: Record<string, unknown>;
  }>(`
    SELECT s.id, s.user_id, s.title, s.kind, s.status, s.raw_text,
           s.active_revision_id, s.active_run_id,
           gr.status AS run_status, gr.model AS run_model, gr.critic_model AS run_critic_model,
           slp.id AS path_id, slp.status AS path_status,
           sm.metadata AS material_metadata
      FROM waxon_v2.sources s
      JOIN waxon_v2.generation_runs gr
        ON gr.user_id=s.user_id AND gr.id=s.active_run_id
      JOIN waxon_v2.source_learning_paths slp
        ON slp.user_id=s.user_id AND slp.generation_run_id=gr.id
      JOIN waxon_v2.source_materials sm
        ON sm.user_id=s.user_id AND sm.source_revision_id=s.active_revision_id AND sm.kind='input'
     WHERE s.id=$1
     ORDER BY sm.created_at
     LIMIT 1
  `, [sourceId]);
  const source = sourceResult.rows[0];
  if (!source) throw new Error("Literal question source not found.");
  if (source.material_metadata?.importMode !== "literal-questions") {
    throw new Error("Source is not a literal question import.");
  }
  const questionsResult = await pool.query<Omit<ImportedQuestion, "section" | "order">>(`
    SELECT ct.id AS "targetId", ct.target_key AS "targetKey", ct.target_type AS "targetType",
           ct.statement,
           q.id AS "questionId", qv.id AS "versionId", qv.version,
           qv.prompt, qv.reference_answer AS "referenceAnswer",
           qv.display_answer AS "displayAnswer", qv.answer_mode AS "answerMode",
           qv.target_text AS "targetText", qv.quality_decision AS quality,
           qv.quality_reasons AS "qualityReasons",
           source_evidence.id AS "recallEvidenceId",
           source_evidence.start_offset AS "sourceOffset"
      FROM waxon_v2.coverage_targets ct
      JOIN waxon_v2.target_questions tq
        ON tq.user_id=ct.user_id AND tq.target_id=ct.id
      JOIN waxon_v2.questions q
        ON q.user_id=tq.user_id AND q.id=tq.question_id
      JOIN waxon_v2.question_versions qv
        ON qv.user_id=q.user_id AND qv.question_id=q.id AND qv.is_current=true
      JOIN LATERAL (
        SELECT es.id, es.start_offset
          FROM waxon_v2.question_evidence qe
          JOIN waxon_v2.evidence_spans es
            ON es.user_id=qe.user_id AND es.id=qe.evidence_span_id
          JOIN waxon_v2.source_versions sv
            ON sv.user_id=es.user_id AND sv.id=es.source_version_id
         WHERE qe.user_id=qv.user_id
           AND qe.question_version_id=qv.id
           AND sv.source_id=ct.source_id
         ORDER BY CASE WHEN qe.requirement='recall-target' THEN 0 ELSE 1 END, es.start_offset
         LIMIT 1
      ) source_evidence ON true
     WHERE ct.user_id=$2 AND ct.source_id=$1
     ORDER BY source_evidence.start_offset, ct.id
  `, [sourceId, source.user_id]);
  if (questionsResult.rowCount !== expectedCount) {
    throw new Error(`Expected ${expectedCount} imported questions, found ${questionsResult.rowCount}.`);
  }
  const sections = sourceSections(source.raw_text);
  const questions: ImportedQuestion[] = questionsResult.rows.map((question, order) => ({
    ...question,
    section: sectionForOffset(sections, question.sourceOffset),
    order,
  }));
  const prompts = new Set<string>();
  for (const question of questions) {
    if (
      question.referenceAnswer.trim() ||
      question.quality !== "rejected" ||
      question.qualityReasons.length !== 1 ||
      question.qualityReasons[0] !== "Reference answer is missing from the imported question-only source."
    ) {
      throw new Error(`Question ${question.questionId} is no longer in the expected unrepaired state.`);
    }
    const normalized = question.prompt.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
    if (prompts.has(normalized)) throw new Error(`Exact duplicate prompt in import: ${question.prompt}`);
    prompts.add(normalized);
  }
  const questionIds = questions.map((question) => question.questionId);
  const existing = await pool.query<{ id: string; prompt: string; referenceAnswer: string; lifecycle: string }>(`
    SELECT q.id, q.lifecycle, qv.prompt, qv.reference_answer AS "referenceAnswer"
      FROM waxon_v2.questions q
      JOIN waxon_v2.question_versions qv
        ON qv.user_id=q.user_id AND qv.question_id=q.id AND qv.is_current=true
     WHERE q.user_id=$1
       AND q.id <> ALL($2::uuid[])
       AND q.lifecycle NOT IN ('trash','superseded')
     ORDER BY q.created_at, q.id
  `, [source.user_id, questionIds]);
  return { source, questions, existing: existing.rows };
}

async function applyRepair(input: {
  pool: Pool;
  source: Awaited<ReturnType<typeof loadRepairContext>>["source"];
  questions: ImportedQuestion[];
  decisions: CriticDecision[];
  nonDistinct: Map<string, { decision: "duplicate" | "uncertain"; duplicateOf: string | null; rationale: string }>;
  embeddings: number[][];
  embeddingModel: string;
  model: string;
  criticModel: string;
  usage: Usage;
}) {
  const decisionById = new Map(input.decisions.map((decision) => [decision.id, decision]));
  const accepted = input.questions.filter((question) => {
    const decision = decisionById.get(question.questionId);
    return decision && decision.status !== "rejected" && decision.confidence >= 0.75 && !input.nonDistinct.has(question.questionId);
  });
  const acceptedIds = new Set(accepted.map((question) => question.questionId));
  const acceptedAnswers = accepted.map((question) => {
    const decision = decisionById.get(question.questionId) as CriticDecision;
    return { prompt: question.prompt, answer: decision.answer, section: question.section, order: question.order };
  });
  const synthesis = buildSynthesisDocument(acceptedAnswers);
  const synthesisMaterialId = randomUUID();
  const pathId = input.source.path_id;
  const versionIdByQuestion = new Map(input.questions.map((question) => [question.questionId, randomUUID()]));
  const answerEvidenceIdByQuestion = new Map(accepted.map((question) => [question.questionId, randomUUID()]));
  const spanByQuestion = new Map(accepted.map((question, index) => [question.questionId, synthesis.spans[index] as { startOffset: number; endOffset: number; quote: string }]));
  const modulePositions = new Map<string, number>();
  for (const question of accepted) {
    if (!modulePositions.has(question.section)) modulePositions.set(question.section, modulePositions.size);
  }
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`literal-repair:${input.source.user_id}:${input.source.id}`]);
    const state = await client.query(`
      SELECT count(*)::int AS count
        FROM waxon_v2.question_versions qv
       WHERE qv.user_id=$1 AND qv.id = ANY($2::uuid[])
         AND qv.is_current=true AND qv.quality_decision='rejected' AND qv.reference_answer=''
    `, [input.source.user_id, input.questions.map((question) => question.versionId)]);
    if (Number(state.rows[0]?.count ?? 0) !== input.questions.length) {
      throw new Error("Repair precondition changed while model work was running; no changes were applied.");
    }
    await client.query(`
      INSERT INTO waxon_v2.source_materials
        (id,user_id,source_revision_id,kind,title,body_text,model,checksum,metadata,created_at)
      VALUES ($1,$2,$3,'model_synthesis',$4,$5,$6,$7,$8::jsonb,now())
    `, [
      synthesisMaterialId,
      input.source.user_id,
      input.source.active_revision_id,
      "Validated reference answers for literal question import",
      synthesis.body,
      input.model,
      createHash("sha256").update(synthesis.body).digest("hex"),
      JSON.stringify({
        policyVersion: REPAIR_POLICY,
        synthesizedFromQuestionOnlySource: true,
        questionCount: accepted.length,
        criticModel: input.criticModel,
      }),
    ]);
    await client.query(`UPDATE waxon_v2.question_versions SET is_current=false WHERE user_id=$1 AND id=ANY($2::uuid[])`, [
      input.source.user_id,
      input.questions.map((question) => question.versionId),
    ]);
    for (const question of input.questions) {
      const decision = decisionById.get(question.questionId) as CriticDecision;
      const overlap = input.nonDistinct.get(question.questionId);
      const quality = overlap?.decision ?? (acceptedIds.has(question.questionId) ? "distinct" : "rejected");
      const qualityReasons = overlap
        ? [overlap.rationale]
        : acceptedIds.has(question.questionId)
          ? []
          : decision.reasons.length > 0
            ? decision.reasons
            : [decision.confidence < 0.75 ? "Reference-answer confidence is below the activation threshold." : "Reference answer did not pass independent review."];
      const answer = decision.answer;
      const versionId = versionIdByQuestion.get(question.questionId) as string;
      await client.query(`
        INSERT INTO waxon_v2.question_versions
          (id,user_id,question_id,version,is_current,prompt,reference_answer,display_answer,answer_mode,target_text,
           quality_decision,quality_reasons,duplicate_of_question_id,learner_attested,created_at)
        VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8::waxon_v2.answer_mode,$9,
                $10::waxon_v2.quality_decision,$11::jsonb,$12,false,now())
      `, [
        versionId,
        input.source.user_id,
        question.questionId,
        question.version + 1,
        question.prompt,
        answer,
        decision.displayAnswer,
        decision.answerMode,
        question.targetText,
        quality,
        JSON.stringify(qualityReasons),
        overlap?.duplicateOf ?? null,
      ]);
      await client.query(`
        INSERT INTO waxon_v2.question_evidence (user_id,question_version_id,evidence_span_id,requirement)
        VALUES ($1,$2,$3,'recall-target')
      `, [input.source.user_id, versionId, question.recallEvidenceId]);
      if (acceptedIds.has(question.questionId)) {
        const span = spanByQuestion.get(question.questionId) as { startOffset: number; endOffset: number; quote: string };
        const answerEvidenceId = answerEvidenceIdByQuestion.get(question.questionId) as string;
        await client.query(`
          INSERT INTO waxon_v2.evidence_spans
            (id,user_id,source_version_id,source_material_id,section,start_offset,end_offset,quote,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
        `, [
          answerEvidenceId,
          input.source.user_id,
          input.source.active_revision_id,
          synthesisMaterialId,
          question.section,
          span.startOffset,
          span.endOffset,
          span.quote,
        ]);
        await client.query(`
          INSERT INTO waxon_v2.question_evidence (user_id,question_version_id,evidence_span_id,requirement)
          VALUES ($1,$2,$3,'reference-answer')
        `, [input.source.user_id, versionId, answerEvidenceId]);
      }
      await client.query(`
        UPDATE waxon_v2.questions
           SET lifecycle=$3::waxon_v2.question_lifecycle,
               prior_lifecycle=NULL,
               suspension_reason=NULL,
               updated_at=now()
         WHERE user_id=$1 AND id=$2
      `, [input.source.user_id, question.questionId, acceptedIds.has(question.questionId) ? "new" : "draft"]);
    }
    await client.query(`
      UPDATE waxon_v2.coverage_targets
         SET status=CASE WHEN id=ANY($2::uuid[]) THEN 'covered'::waxon_v2.coverage_status ELSE 'weak'::waxon_v2.coverage_status END,
             updated_at=now()
       WHERE user_id=$1 AND source_id=$3
    `, [input.source.user_id, accepted.map((question) => question.targetId), input.source.id]);
    await client.query(`DELETE FROM waxon_v2.source_learning_edges WHERE user_id=$1 AND path_id=$2`, [input.source.user_id, pathId]);
    await client.query(`DELETE FROM waxon_v2.source_learning_nodes WHERE user_id=$1 AND path_id=$2`, [input.source.user_id, pathId]);
    for (const question of accepted) {
      await client.query(`
        INSERT INTO waxon_v2.source_learning_nodes
          (id,user_id,path_id,kind,target_id,question_id,module_title,module_position,source_position,
           pedagogical_position,statement,reason,created_at,updated_at)
        VALUES ($1,$2,$3,'target',$4,$5,$6,$7,$8,$8,$9,$10,now(),now())
      `, [
        randomUUID(),
        input.source.user_id,
        pathId,
        question.targetId,
        question.questionId,
        question.section,
        modulePositions.get(question.section) ?? 0,
        question.order,
        question.statement,
        "The authored examination states that its questions are independent; preserve source order.",
      ]);
    }
    const ready = accepted.length === input.questions.length;
    await client.query(`
      UPDATE waxon_v2.source_learning_paths
         SET status=$3::waxon_v2.learning_path_status,
             diagnostics=$4::jsonb,
             policy_version=$5,
             updated_at=now()
       WHERE user_id=$1 AND id=$2
    `, [
      input.source.user_id,
      pathId,
      ready ? "fallback_ready" : "needs_attention",
      JSON.stringify([
        "The authored examination declares every question independent; the repaired path preserves its section and question order.",
        ...(ready ? [] : [`${input.questions.length - accepted.length} question(s) remain inactive after answer or duplicate review.`]),
      ]),
      REPAIR_POLICY,
    ]);
    await client.query(`
      UPDATE waxon_v2.sources
         SET status=$3::waxon_v2.source_status, processing_progress=100, error=NULL, updated_at=now()
       WHERE user_id=$1 AND id=$2
    `, [input.source.user_id, input.source.id, ready ? "ready" : "needs_attention"]);
    await client.query(`
      UPDATE waxon_v2.generation_runs
         SET status=$3::waxon_v2.generation_run_status,
             stage='Literal import repaired', progress=100,
             policy_version=$4, model=$5, critic_model=$6,
             usage=COALESCE(usage,'{}'::jsonb) || $7::jsonb,
             result=COALESCE(result,'{}'::jsonb) || $8::jsonb,
             residuals=$9::jsonb, error=NULL, finished_at=now(), updated_at=now()
       WHERE user_id=$1 AND id=$2
    `, [
      input.source.user_id,
      input.source.active_run_id,
      ready ? "ready" : "needs_attention",
      REPAIR_POLICY,
      input.model,
      input.criticModel,
      JSON.stringify({ repairModelCalls: input.usage.calls, repairInputTokens: input.usage.inputTokens, repairOutputTokens: input.usage.outputTokens, repairCost: input.usage.cost }),
      JSON.stringify({ repaired: accepted.length, total: input.questions.length, answerMaterialId: synthesisMaterialId, pathId }),
      JSON.stringify(ready ? [] : [`${input.questions.length - accepted.length} literal-import question(s) remain inactive.`]),
    ]);
    for (const [index, question] of input.questions.entries()) {
      const versionId = versionIdByQuestion.get(question.questionId) as string;
      const vector = input.embeddings[index];
      if (!vector) throw new Error(`Missing embedding for ${question.questionId}.`);
      await client.query(`
        INSERT INTO waxon_v2.question_embeddings (user_id,question_version_id,model,embedding,created_at)
        VALUES ($1,$2,$3,$4::vector,now())
      `, [input.source.user_id, versionId, input.embeddingModel, `[${vector.join(",")}]`]);
    }
    await client.query(`
      INSERT INTO waxon_v2.generation_run_artifacts
        (id,user_id,generation_run_id,kind,artifact_key,payload,usage,created_at)
      VALUES ($1,$2,$3,'literal_question_repair',$4,$5::jsonb,$6::jsonb,now())
    `, [
      randomUUID(),
      input.source.user_id,
      input.source.active_run_id,
      REPAIR_POLICY,
      JSON.stringify({ repaired: accepted.length, total: input.questions.length, model: input.model, criticModel: input.criticModel, embeddingModel: input.embeddingModel }),
      JSON.stringify(input.usage),
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { repaired: accepted.length, remaining: input.questions.length - accepted.length };
}

async function mergeHeldDuplicates(pool: Pool, sourceId: string, expectedCount: number) {
  const sourceResult = await pool.query<{
    id: string;
    user_id: string;
    title: string;
    raw_text: string;
    active_revision_id: string;
    active_run_id: string;
    path_id: string;
  }>(`
    SELECT s.id,s.user_id,s.title,s.raw_text,s.active_revision_id,s.active_run_id,slp.id AS path_id
      FROM waxon_v2.sources s
      JOIN waxon_v2.source_learning_paths slp
        ON slp.user_id=s.user_id AND slp.generation_run_id=s.active_run_id
     WHERE s.id=$1
  `, [sourceId]);
  const source = sourceResult.rows[0];
  if (!source) throw new Error("Repaired literal question source not found.");
  const orderedResult = await pool.query<{
    targetId: string;
    questionId: string;
    sourceOffset: number;
  }>(`
    SELECT ct.id AS "targetId",q.id AS "questionId",source_evidence.start_offset AS "sourceOffset"
      FROM waxon_v2.coverage_targets ct
      JOIN waxon_v2.target_questions tq ON tq.user_id=ct.user_id AND tq.target_id=ct.id
      JOIN waxon_v2.questions q ON q.user_id=tq.user_id AND q.id=tq.question_id
      JOIN waxon_v2.question_versions qv ON qv.user_id=q.user_id AND qv.question_id=q.id AND qv.is_current=true
      JOIN LATERAL (
        SELECT es.start_offset
          FROM waxon_v2.question_evidence qe
          JOIN waxon_v2.evidence_spans es ON es.user_id=qe.user_id AND es.id=qe.evidence_span_id
          JOIN waxon_v2.source_versions sv ON sv.user_id=es.user_id AND sv.id=es.source_version_id
         WHERE qe.user_id=qv.user_id AND qe.question_version_id=qv.id AND sv.source_id=ct.source_id
         ORDER BY CASE WHEN qe.requirement='recall-target' THEN 0 ELSE 1 END,es.start_offset
         LIMIT 1
      ) source_evidence ON true
     WHERE ct.user_id=$2 AND ct.source_id=$1
     ORDER BY source_evidence.start_offset,ct.id
  `, [sourceId, source.user_id]);
  if (orderedResult.rowCount !== expectedCount) {
    throw new Error(`Expected ${expectedCount} source targets, found ${orderedResult.rowCount}.`);
  }
  const orderByTarget = new Map(orderedResult.rows.map((row, order) => [row.targetId, order]));
  const sections = sourceSections(source.raw_text);
  const heldResult = await pool.query<{
    targetId: string;
    duplicateId: string;
    duplicateVersionId: string;
    prompt: string;
    referenceAnswer: string;
    displayAnswer: string;
    answerMode: AnswerMode;
    targetText: string;
    recallEvidenceId: string;
    sourceOffset: number;
    canonicalId: string;
    canonicalLifecycle: string;
    canonicalPriorLifecycle: string | null;
    canonicalVersionId: string;
    canonicalVersion: number;
  }>(`
    SELECT ct.id AS "targetId",duplicate.id AS "duplicateId",dqv.id AS "duplicateVersionId",
           dqv.prompt,dqv.reference_answer AS "referenceAnswer",dqv.display_answer AS "displayAnswer",
           dqv.answer_mode AS "answerMode",dqv.target_text AS "targetText",
           source_evidence.id AS "recallEvidenceId",source_evidence.start_offset AS "sourceOffset",
           canonical.id AS "canonicalId",canonical.lifecycle AS "canonicalLifecycle",
           canonical.prior_lifecycle AS "canonicalPriorLifecycle",
           cqv.id AS "canonicalVersionId",cqv.version AS "canonicalVersion"
      FROM waxon_v2.coverage_targets ct
      JOIN waxon_v2.target_questions tq ON tq.user_id=ct.user_id AND tq.target_id=ct.id
      JOIN waxon_v2.questions duplicate ON duplicate.user_id=tq.user_id AND duplicate.id=tq.question_id
      JOIN waxon_v2.question_versions dqv ON dqv.user_id=duplicate.user_id AND dqv.question_id=duplicate.id AND dqv.is_current=true
      JOIN waxon_v2.questions canonical ON canonical.user_id=dqv.user_id AND canonical.id=dqv.duplicate_of_question_id
      JOIN waxon_v2.question_versions cqv ON cqv.user_id=canonical.user_id AND cqv.question_id=canonical.id AND cqv.is_current=true
      JOIN LATERAL (
        SELECT es.id,es.start_offset
          FROM waxon_v2.question_evidence qe
          JOIN waxon_v2.evidence_spans es ON es.user_id=qe.user_id AND es.id=qe.evidence_span_id
          JOIN waxon_v2.source_versions sv ON sv.user_id=es.user_id AND sv.id=es.source_version_id
         WHERE qe.user_id=dqv.user_id AND qe.question_version_id=dqv.id AND sv.source_id=ct.source_id
         ORDER BY CASE WHEN qe.requirement='recall-target' THEN 0 ELSE 1 END,es.start_offset
         LIMIT 1
      ) source_evidence ON true
     WHERE ct.user_id=$2 AND ct.source_id=$1 AND dqv.quality_decision='duplicate'
     ORDER BY source_evidence.start_offset
  `, [sourceId, source.user_id]);
  if (heldResult.rowCount === 0) {
    console.log("No held duplicate questions remain to merge.");
    return { merged: 0 };
  }
  const held = heldResult.rows.map((row) => {
    const order = orderByTarget.get(row.targetId);
    if (order === undefined) throw new Error(`Held target ${row.targetId} has no source order.`);
    return {
      ...row,
      order,
      section: sectionForOffset(sections, row.sourceOffset),
    };
  });
  const uniqueCanonicalIds = new Set(held.map((row) => row.canonicalId));
  if (uniqueCanonicalIds.size !== held.length) {
    throw new Error("Multiple held targets resolve to one canonical question; manual merge is required.");
  }
  const synthesis = buildSynthesisDocument(held.map((row) => ({
    prompt: row.prompt,
    answer: row.referenceAnswer,
    section: row.section,
    order: row.order,
  })));
  const materialId = randomUUID();
  const modulePositions = new Map(sections.map((section, index) => [section.title, index]));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`literal-merge:${source.user_id}:${source.id}`]);
    const precondition = await client.query(`
      SELECT count(*)::int AS count
        FROM waxon_v2.question_versions
       WHERE user_id=$1 AND id=ANY($2::uuid[]) AND is_current=true AND quality_decision='duplicate'
    `, [source.user_id, held.map((row) => row.duplicateVersionId)]);
    if (Number(precondition.rows[0]?.count ?? 0) !== held.length) {
      throw new Error("Held duplicate state changed before merge; no changes were applied.");
    }
    await client.query(`
      INSERT INTO waxon_v2.source_materials
        (id,user_id,source_revision_id,kind,title,body_text,model,checksum,metadata,created_at)
      VALUES ($1,$2,$3,'model_synthesis',$4,$5,$6,$7,$8::jsonb,now())
    `, [
      materialId,
      source.user_id,
      source.active_revision_id,
      "Merged reference-answer addendum",
      synthesis.body,
      REPAIR_POLICY,
      createHash("sha256").update(synthesis.body).digest("hex"),
      JSON.stringify({ policyVersion: REPAIR_POLICY, duplicateMergeAddendum: true, questionCount: held.length }),
    ]);
    for (const [heldIndex, row] of held.entries()) {
      const newCanonicalVersionId = randomUUID();
      const answerEvidenceId = randomUUID();
      const span = synthesis.spans[heldIndex] as { startOffset: number; endOffset: number; quote: string };
      const canonicalEvidence = await client.query<{ evidence_span_id: string; requirement: string }>(`
        SELECT evidence_span_id,requirement
          FROM waxon_v2.question_evidence
         WHERE user_id=$1 AND question_version_id=$2
      `, [source.user_id, row.canonicalVersionId]);
      const candidateEmbedding = await client.query<{ model: string; embedding: string }>(`
        SELECT model,embedding::text AS embedding
          FROM waxon_v2.question_embeddings
         WHERE user_id=$1 AND question_version_id=$2
         ORDER BY created_at DESC LIMIT 1
      `, [source.user_id, row.duplicateVersionId]);
      if (!candidateEmbedding.rows[0]) throw new Error(`Held question ${row.duplicateId} has no embedding.`);
      await client.query(`UPDATE waxon_v2.question_versions SET is_current=false WHERE user_id=$1 AND id=$2`, [source.user_id, row.canonicalVersionId]);
      await client.query(`
        INSERT INTO waxon_v2.question_versions
          (id,user_id,question_id,version,is_current,prompt,reference_answer,display_answer,answer_mode,target_text,
           quality_decision,quality_reasons,duplicate_of_question_id,learner_attested,created_at)
        VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8::waxon_v2.answer_mode,$9,'distinct','[]'::jsonb,NULL,false,now())
      `, [
        newCanonicalVersionId,
        source.user_id,
        row.canonicalId,
        row.canonicalVersion + 1,
        row.prompt,
        row.referenceAnswer,
        row.displayAnswer,
        row.answerMode,
        row.targetText,
      ]);
      for (const evidence of canonicalEvidence.rows) {
        await client.query(`
          INSERT INTO waxon_v2.question_evidence (user_id,question_version_id,evidence_span_id,requirement)
          VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING
        `, [source.user_id, newCanonicalVersionId, evidence.evidence_span_id, evidence.requirement]);
      }
      await client.query(`
        INSERT INTO waxon_v2.evidence_spans
          (id,user_id,source_version_id,source_material_id,section,start_offset,end_offset,quote,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
      `, [answerEvidenceId, source.user_id, source.active_revision_id, materialId, row.section, span.startOffset, span.endOffset, span.quote]);
      await client.query(`
        INSERT INTO waxon_v2.question_evidence (user_id,question_version_id,evidence_span_id,requirement)
        VALUES ($1,$2,$3,'recall-target'),($1,$2,$4,'reference-answer') ON CONFLICT DO NOTHING
      `, [source.user_id, newCanonicalVersionId, row.recallEvidenceId, answerEvidenceId]);
      await client.query(`
        INSERT INTO waxon_v2.question_embeddings (user_id,question_version_id,model,embedding,created_at)
        VALUES ($1,$2,$3,$4::vector,now())
      `, [source.user_id, newCanonicalVersionId, candidateEmbedding.rows[0].model, candidateEmbedding.rows[0].embedding]);
      const restoredLifecycle = row.canonicalLifecycle === "suspended" &&
        (row.canonicalPriorLifecycle === "new" || row.canonicalPriorLifecycle === "learning" || row.canonicalPriorLifecycle === "review")
        ? row.canonicalPriorLifecycle
        : "new";
      await client.query(`
        UPDATE waxon_v2.questions
           SET lifecycle=$3::waxon_v2.question_lifecycle,prior_lifecycle=NULL,suspension_reason=NULL,updated_at=now()
         WHERE user_id=$1 AND id=$2
      `, [source.user_id, row.canonicalId, restoredLifecycle]);
      await client.query(`
        UPDATE waxon_v2.questions
           SET lifecycle='superseded',prior_lifecycle=NULL,suspension_reason=NULL,updated_at=now()
         WHERE user_id=$1 AND id=$2
      `, [source.user_id, row.duplicateId]);
      await client.query(`
        INSERT INTO waxon_v2.target_questions (user_id,target_id,question_id,relation,created_at)
        VALUES ($1,$2,$3,'merge',now()) ON CONFLICT DO NOTHING
      `, [source.user_id, row.targetId, row.canonicalId]);
      await client.query(`UPDATE waxon_v2.coverage_targets SET status='covered',updated_at=now() WHERE user_id=$1 AND id=$2`, [source.user_id, row.targetId]);
      await client.query(`
        INSERT INTO waxon_v2.source_learning_nodes
          (id,user_id,path_id,kind,target_id,question_id,module_title,module_position,source_position,
           pedagogical_position,statement,reason,created_at,updated_at)
        VALUES ($1,$2,$3,'target',$4,$5,$6,$7,$8,$8,$9,$10,now(),now())
      `, [
        randomUUID(),
        source.user_id,
        source.path_id,
        row.targetId,
        row.canonicalId,
        row.section,
        modulePositions.get(row.section) ?? 0,
        row.order,
        row.prompt,
        "Merged with the canonical bank question while preserving the authored examination order.",
      ]);
      if (restoredLifecycle === "review" || restoredLifecycle === "learning") {
        await client.query(`UPDATE waxon_v2.memory_states SET due_at=LEAST(due_at,now()),updated_at=now() WHERE user_id=$1 AND question_id=$2`, [source.user_id, row.canonicalId]);
      }
    }
    await client.query(`
      UPDATE waxon_v2.source_learning_paths
         SET status='fallback_ready',diagnostics=$3::jsonb,policy_version=$4,updated_at=now()
       WHERE user_id=$1 AND id=$2
    `, [
      source.user_id,
      source.path_id,
      JSON.stringify(["The authored examination declares every question independent; the repaired path preserves its section and question order."]),
      REPAIR_POLICY,
    ]);
    await client.query(`UPDATE waxon_v2.sources SET status='ready',processing_progress=100,error=NULL,updated_at=now() WHERE user_id=$1 AND id=$2`, [source.user_id, source.id]);
    await client.query(`
      UPDATE waxon_v2.generation_runs
         SET status='ready',stage='Literal import repaired',progress=100,residuals='[]'::jsonb,
             result=COALESCE(result,'{}'::jsonb) || $3::jsonb,error=NULL,finished_at=now(),updated_at=now()
       WHERE user_id=$1 AND id=$2
    `, [source.user_id, source.active_run_id, JSON.stringify({ repaired: expectedCount, mergedDuplicates: held.length, pathId: source.path_id })]);
    await client.query(`
      INSERT INTO waxon_v2.generation_run_artifacts
        (id,user_id,generation_run_id,kind,artifact_key,payload,usage,created_at)
      VALUES ($1,$2,$3,'literal_question_repair',$4,$5::jsonb,'{}'::jsonb,now())
    `, [randomUUID(), source.user_id, source.active_run_id, `${REPAIR_POLICY}:merge-held`, JSON.stringify({ mergedDuplicates: held.length })]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  console.log(`Merged ${held.length} held duplicate target(s) into canonical bank questions.`);
  return { merged: held.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL or DATABASE_URL_UNPOOLED is required.");
  const pool = new Pool({ connectionString });
  try {
    if (args.mergeHeld) {
      if (!args.apply) throw new Error("--merge-held requires --apply.");
      await mergeHeldDuplicates(pool, args.sourceId, args.expectedCount);
      return;
    }
    const apiKey = resolveOpenRouterApiKey();
    if (!apiKey) throw new Error("OPENROUTER_API_KEY or LLM_API_KEY is required.");
    const context = await loadRepairContext(pool, args.sourceId, args.expectedCount);
    const priorModel = context.source.run_model && context.source.run_model !== "none"
      ? context.source.run_model
      : DEFAULT_OPENROUTER_CHAT_MODEL;
    const priorCriticModel = context.source.run_critic_model && context.source.run_critic_model !== "none"
      ? context.source.run_critic_model
      : priorModel;
    const model = resolveOpenRouterModel({ variable: "LLM_LEARN_MODEL", fallback: priorModel }) as string;
    const criticModel = resolveOpenRouterModel({ variable: "LLM_LEARN_CRITIC_MODEL", fallback: priorCriticModel }) as string;
    const embeddingModel = resolveEmbeddingModel() || DEFAULT_EMBEDDING_MODEL;
    console.log(`Validated unrepaired source: ${context.source.title}`);
    console.log(`Questions: ${context.questions.length}; other bank questions checked for overlap: ${context.existing.length}.`);
    const generated = await generateAnswers({
      apiKey,
      model,
      criticModel,
      userId: context.source.user_id,
      questions: context.questions,
    });
    let usage = generated.usage;
    for (const question of context.questions) {
      const decision = generated.decisions.find((item) => item.id === question.questionId);
      if (!decision) throw new Error(`No critic decision for ${question.questionId}.`);
      const quality = assessQuestionQuality({
        prompt: question.prompt,
        referenceAnswer: decision.answer,
        target: question.targetText,
      });
      if (!quality.passes) {
        decision.status = "rejected";
        decision.reasons = [...new Set([...decision.reasons, ...quality.reasons])];
      }
    }
    const dedupe = await detectSemanticDuplicates({
      apiKey,
      model: criticModel,
      userId: context.source.user_id,
      questions: context.questions,
      decisions: generated.decisions,
      existing: context.existing,
    });
    usage = addUsage(usage, dedupe.usage);
    const embeddings = await requestEmbeddings({
      apiKey,
      model: embeddingModel,
      userId: context.source.user_id,
      texts: context.questions.map((question) => {
        const answer = generated.decisions.find((item) => item.id === question.questionId) as CriticDecision;
        return `${question.prompt}\n${answer.answer}`;
      }),
    });
    const rejected = generated.decisions.filter((decision) => decision.status === "rejected" || decision.confidence < 0.75);
    console.log(`Independent answer review rejected or held ${rejected.length} question(s).`);
    console.log(`Semantic duplicate review held ${dedupe.nonDistinct.size} question(s).`);
    console.log(`Model calls: ${usage.calls}; tokens: ${usage.totalTokens}; reported cost: $${usage.cost.toFixed(4)}.`);
    if (!args.apply) {
      console.log("Dry run complete. Re-run with --apply to persist the validated repair.");
      return;
    }
    const result = await applyRepair({
      pool,
      source: context.source,
      questions: context.questions,
      decisions: generated.decisions,
      nonDistinct: dedupe.nonDistinct,
      embeddings,
      embeddingModel,
      model,
      criticModel,
      usage,
    });
    console.log(`Repair committed: ${result.repaired} active, ${result.remaining} still needing attention.`);
  } finally {
    await pool.end();
  }
}

const isEntrypoint = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isEntrypoint) {
  await main();
}
