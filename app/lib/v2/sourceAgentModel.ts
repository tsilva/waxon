import {
  extractChatCompletionText,
  getOpenRouterApiKey,
  openRouterChatCompletion,
  type OpenRouterChatRequest,
} from "@/app/lib/openRouter";
import { extractJsonObject } from "@/shared/json-object.mts";
import {
  DEFAULT_OPENROUTER_CHAT_MODEL,
  resolveOpenRouterModel,
} from "@/shared/openrouter-config.mts";
import { normalizeGeneratedAnswerMode } from "./generatedAnswerMode";
import type { V2AnswerMode } from "./types";
import type { SequenceDraft } from "./learningPath";

export type GenerationUsage = {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  webSearches: number;
};

export const EMPTY_GENERATION_USAGE: GenerationUsage = {
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cost: 0,
  webSearches: 0,
};

function addUsage(...items: GenerationUsage[]): GenerationUsage {
  return items.reduce<GenerationUsage>(
    (total, item) => ({
      modelCalls: total.modelCalls + item.modelCalls,
      inputTokens: total.inputTokens + item.inputTokens,
      outputTokens: total.outputTokens + item.outputTokens,
      totalTokens: total.totalTokens + item.totalTokens,
      cost: total.cost + item.cost,
      webSearches: total.webSearches + item.webSearches,
    }),
    { ...EMPTY_GENERATION_USAGE },
  );
}

export type MasteryTargetDraft = {
  key: string;
  type: string;
  statement: string;
  requirement: "required" | "optional" | "excluded" | "unsupported";
  evidenceMaterialId: string;
  evidenceQuote: string;
  answerRubric: string | null;
  question: string | null;
  answer: string | null;
  displayAnswer: string | null;
  answerMode: V2AnswerMode | null;
  concepts: string[];
  confidence: number;
};

export type TopicBrief = {
  title: string;
  body: string;
  usedResearch: boolean;
  citations: Array<{ title: string; url: string; content: string }>;
  usage: GenerationUsage;
};

export type CoverageMatchDecision = {
  targetKey: string;
  questionId: string | null;
  decision: "equivalent" | "distinct" | "uncertain";
  reason: string;
};

export type LearningPathSequenceResult = {
  draft: SequenceDraft | null;
  usage: GenerationUsage;
};

function learningModel(): string {
  return (
    resolveOpenRouterModel({
      variable: "LLM_LEARN_MODEL",
      fallback: DEFAULT_OPENROUTER_CHAT_MODEL,
    }) ?? DEFAULT_OPENROUTER_CHAT_MODEL
  );
}

function criticModel(): string {
  return (
    resolveOpenRouterModel({
      variable: "LLM_LEARN_CRITIC_MODEL",
      fallback: learningModel(),
    }) ?? learningModel()
  );
}

export function resolveSourceAgentModels(): {
  model: string;
  criticModel: string;
} {
  return { model: learningModel(), criticModel: criticModel() };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFrom(response: {
  usage?: Record<string, unknown>;
}): GenerationUsage {
  const usage = response.usage ?? {};
  const serverTools =
    usage.server_tool_use && typeof usage.server_tool_use === "object"
      ? (usage.server_tool_use as Record<string, unknown>)
      : {};
  const inputTokens =
    numberValue(usage.prompt_tokens) || numberValue(usage.input_tokens);
  const outputTokens =
    numberValue(usage.completion_tokens) || numberValue(usage.output_tokens);

  return {
    modelCalls: 1,
    inputTokens,
    outputTokens,
    totalTokens:
      numberValue(usage.total_tokens) || inputTokens + outputTokens,
    cost: numberValue(usage.cost),
    webSearches: numberValue(serverTools.web_search_requests),
  };
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = extractJsonObject(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The source agent returned invalid structured output.");
  }
  return parsed as Record<string, unknown>;
}

function strings(value: unknown, limit = 16): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, limit)
    : [];
}

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function parseCitations(body: {
  choices?: Array<{ message?: { annotations?: unknown } }>;
}): Array<{ title: string; url: string; content: string }> {
  const annotations = body.choices?.[0]?.message?.annotations;
  if (!Array.isArray(annotations)) {
    return [];
  }

  const seen = new Set<string>();
  return annotations.flatMap((raw) => {
    if (!raw || typeof raw !== "object") {
      return [];
    }
    const record = raw as Record<string, unknown>;
    const citation =
      record.url_citation && typeof record.url_citation === "object"
        ? (record.url_citation as Record<string, unknown>)
        : record;
    const url = text(citation.url, 4_000);
    if (!url || seen.has(url)) {
      return [];
    }
    seen.add(url);
    return [
      {
        title: text(citation.title, 300) || url,
        url,
        content:
          text(citation.content, 16_000) || text(citation.snippet, 16_000),
      },
    ];
  });
}

async function structuredRequest(input: {
  userId: string;
  operation: string;
  model: string;
  system: string;
  payload: unknown;
  maxTokens: number;
  tools?: OpenRouterChatRequest["tools"];
  maxToolCalls?: number;
}): Promise<{
  parsed: Record<string, unknown>;
  body: Awaited<ReturnType<typeof openRouterChatCompletion>>["body"];
  usage: GenerationUsage;
}> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error("Model work is unavailable because no API key is configured.");
  }
  const { response, body } = await openRouterChatCompletion({
    apiKey,
    stream: false,
    signal: AbortSignal.timeout(90_000),
    trace: {
      operation: input.operation,
      userId: input.userId,
    },
    body: {
      model: input.model,
      temperature: 0,
      max_tokens: input.maxTokens,
      response_format: { type: "json_object" },
      user: input.userId,
      tools: input.tools,
      max_tool_calls: input.maxToolCalls,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: JSON.stringify(input.payload) },
      ],
    },
  });
  if (!response.ok) {
    throw new Error(
      `Source agent request failed (${response.status}): ${extractChatCompletionText(body).slice(0, 300)}`,
    );
  }

  return {
    parsed: parseObject(extractChatCompletionText(body)),
    body,
    usage: usageFrom(body as { usage?: Record<string, unknown> }),
  };
}

export async function generateTopicBrief(input: {
  userId: string;
  topic: string;
}): Promise<TopicBrief> {
  const result = await structuredRequest({
    userId: input.userId,
    operation: "v2.source.topic-brief",
    model: learningModel(),
    maxTokens: 6_000,
    maxToolCalls: 3,
    tools: [
      {
        type: "openrouter:web_search",
        parameters: {
          engine: "auto",
          max_results: 4,
          max_total_results: 12,
          max_uses: 3,
          max_characters: 4_000,
        },
      },
    ],
    system:
      "Create a self-contained mastery brief for the requested topic, not a summary. Return JSON only: {title,body,usedResearch}. The body must provide enough evidence to build a rigorous free-recall mastery test. Cover every applicable dimension: prerequisites and motivation; definitions and notation; components and their roles; mechanisms and end-to-end process; mathematical objectives and the meaning of each term; derivations or causal intuition; assumptions; variants and comparisons; practical use or implementation; hyperparameters and diagnostics; limitations, edge cases, and failure modes. For a medium technical topic, state roughly 16-30 independently testable, materially important claims under clear headings. Omit a dimension only when it genuinely does not apply. Minimum later means nonredundant coverage, not a small number of questions. Use web search only when the request is explicitly current/recent, requests citations, or you are materially uncertain; stable established topics should normally use your existing knowledge without searching. Do not pretend that model synthesis is an external source. If you search, ground current claims in the search results and set usedResearch=true.",
    payload: { topic: input.topic, currentDate: new Date().toISOString() },
  });
  let title = text(result.parsed.title, 300) || input.topic;
  let body = text(result.parsed.body, 250_000);
  let usage = result.usage;
  if (body.length < 2_500) {
    const expansion = await structuredRequest({
      userId: input.userId,
      operation: "v2.source.topic-brief-expand",
      model: learningModel(),
      maxTokens: 6_000,
      system:
        "Expand the supplied draft into a self-contained mastery brief. Return JSON only: {title,body}. Preserve correct material and add missing independently testable knowledge. Use headings and cover every applicable dimension: prerequisites and motivation; definitions and notation; components; mechanisms and complete algorithm or process; equations and every term; derivations or causal intuition; assumptions; implementation and diagnostics; hyperparameters; variants and comparisons; limitations, edge cases, and failure modes. For a medium technical topic include roughly 16-30 materially important claims. Do not pad with history, anecdotes, or repeated prose. Do not use outside web research in this expansion.",
      payload: {
        topic: input.topic,
        draftTitle: title,
        draftBody: body,
      },
    });
    title = text(expansion.parsed.title, 300) || title;
    body = text(expansion.parsed.body, 250_000) || body;
    usage = addUsage(usage, expansion.usage);
  }
  if (body.length < 200) {
    throw new Error("The topic agent did not produce enough learning material.");
  }
  const citations = parseCitations(result.body);

  return {
    title,
    body,
    usedResearch: result.parsed.usedResearch === true || citations.length > 0,
    citations,
    usage,
  };
}

function parseTarget(raw: unknown): MasteryTargetDraft | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const statement = text(item.statement, 4_000);
  const evidenceMaterialId = text(item.evidenceMaterialId, 80);
  const evidenceQuote = text(item.evidenceQuote, 16_000);
  const requirement = item.requirement;
  if (!statement || !evidenceMaterialId) {
    return null;
  }
  const normalizedRequirement =
    requirement === "optional" ||
    requirement === "excluded" ||
    requirement === "unsupported"
      ? requirement
      : "required";
  const question = text(item.question, 16_384) || null;
  const answer = text(item.answer, 65_536) || null;

  return {
    key: text(item.key, 160),
    type: text(item.type, 80) || "concept",
    statement,
    requirement: normalizedRequirement,
    evidenceMaterialId,
    evidenceQuote,
    answerRubric: text(item.answerRubric, 16_000) || null,
    question,
    answer,
    displayAnswer: text(item.displayAnswer, 8_000) || answer?.slice(0, 8_000) || null,
    answerMode: normalizeGeneratedAnswerMode(item.answerMode),
    concepts: strings(item.concepts, 8),
    confidence:
      typeof item.confidence === "number" && Number.isFinite(item.confidence)
        ? Math.max(0, Math.min(1, item.confidence))
        : 0,
  };
}

export async function mapMasteryChunk(input: {
  userId: string;
  sourceTitle: string;
  materialId: string;
  materialTitle: string;
  chunkIndex: number;
  chunkCount: number;
  text: string;
  maxTargets: number;
}): Promise<{
  targets: MasteryTargetDraft[];
  unresolved: string[];
  usage: GenerationUsage;
}> {
  const requestPayload = {
    sourceTitle: input.sourceTitle,
    materialId: input.materialId,
    materialTitle: input.materialTitle,
    chunkIndex: input.chunkIndex,
    chunkCount: input.chunkCount,
    maxTargets: input.maxTargets,
    source: input.text,
  };
  const result = await structuredRequest({
    userId: input.userId,
    operation: "v2.source.map-mastery",
    model: learningModel(),
    maxTokens: 9_000,
    system:
      "Map the supplied material into the minimum nonredundant set of mastery targets needed to demonstrate free-recall understanding. Coverage completeness is mandatory: minimum means no duplicate or low-value targets, not few questions. First audit every heading, independently meaningful formula or term, mechanism, process step, assumption, comparison, practical decision, diagnostic, limitation, and failure mode in the material. Retain each materially distinct competency as an atomic target. A medium technical brief should normally yield 16-30 required targets; do not return fewer than 16 when the source contains that many independent claims. Never combine a list of unrelated hyperparameters, failure modes, or definitions into one target merely to reduce count. Return JSON only: {targets:[{key,type,statement,requirement,evidenceMaterialId,evidenceQuote,answerRubric,question,answer,displayAnswer,answerMode,concepts,confidence}],unresolved:[string]}. requirement is required, optional, excluded, or unsupported. evidenceQuote must be one non-empty, verbatim, contiguous substring copied from the supplied chunk. Never insert ellipses, concatenate separate passages, paraphrase evidence, or invent a quote. evidenceMaterialId must exactly repeat the supplied ID. Questions must be concise, atomic, self-contained, recall-oriented, precise, and contain no answer hints. Preserve mathematical notation with Markdown $...$. Use rubric only for one coherent explanation or procedure with independently required points. Do not use outside knowledge. Exclude anecdotes, repetition, navigation, citations, and details that do not contribute to source-defined mastery. Set question/answer fields null when support is insufficient and list any material competency you could not turn into a supported question in unresolved.",
    payload: requestPayload,
  });

  const parseMapped = (parsed: Record<string, unknown>) => {
    const parsedTargets = Array.isArray(parsed.targets)
      ? parsed.targets
          .map(parseTarget)
          .filter((target): target is MasteryTargetDraft => Boolean(target))
          .slice(0, input.maxTargets)
      : [];
    const valid = parsedTargets.filter(
      (target) =>
        target.evidenceMaterialId === input.materialId &&
        Boolean(target.evidenceQuote) &&
        input.text.includes(target.evidenceQuote),
    );
    return {
      valid,
      invalid: parsedTargets.filter((target) => !valid.includes(target)),
      unresolved: strings(parsed.unresolved, 40),
    };
  };
  const expectedRequired = Math.min(
    input.maxTargets,
    input.text.length >= 2_500 ? 16 : input.text.length >= 1_200 ? 8 : 4,
  );
  let mapped = parseMapped(result.parsed);
  let usage = result.usage;
  const requiredCount = mapped.valid.filter(
    (target) => target.requirement === "required",
  ).length;
  if (requiredCount < expectedRequired || mapped.invalid.length > 0) {
    const repair = await structuredRequest({
      userId: input.userId,
      operation: "v2.source.map-mastery-repair",
      model: learningModel(),
      maxTokens: 9_000,
      system:
        "Replace the supplied mastery map with a complete, corrected map. Return the full JSON object {targets:[{key,type,statement,requirement,evidenceMaterialId,evidenceQuote,answerRubric,question,answer,displayAnswer,answerMode,concepts,confidence}],unresolved:[string]}. Preserve good atomic targets, split composite lists, and restore every materially distinct competency from the source. Meet minimumRequiredTargets when the source supports it. Every evidenceQuote must be one non-empty, verbatim, contiguous substring copied from source—never use ellipses, stitched passages, or paraphrases. evidenceMaterialId must exactly repeat materialId. Keep questions atomic, self-contained, recall-oriented, and answerable solely from their exact evidence. Do not use outside knowledge.",
      payload: {
        ...requestPayload,
        minimumRequiredTargets: expectedRequired,
        initialTargets: mapped.valid,
        rejectedTargets: mapped.invalid.map((target) => ({
          statement: target.statement,
          evidenceQuote: target.evidenceQuote,
        })),
      },
    });
    const repaired = parseMapped(repair.parsed);
    const repairedRequired = repaired.valid.filter(
      (target) => target.requirement === "required",
    ).length;
    if (repairedRequired >= requiredCount) {
      mapped = repaired;
    }
    usage = addUsage(usage, repair.usage);
  }

  const finalRequired = mapped.valid.filter(
    (target) => target.requirement === "required",
  ).length;
  const unresolved = [...mapped.unresolved];
  if (mapped.invalid.length > 0) {
    unresolved.push(
      ...mapped.invalid.map(
        (target) => `No contiguous evidence was returned for: ${target.statement}`,
      ),
    );
  }
  if (finalRequired < expectedRequired) {
    unresolved.push(
      `Coverage audit produced ${finalRequired} required targets; the source supports at least ${expectedRequired}.`,
    );
  }

  return {
    targets: mapped.valid,
    unresolved: [...new Set(unresolved)].slice(0, 40),
    usage,
  };
}

export async function critiqueMasteryManifest(input: {
  userId: string;
  sourceTitle: string;
  targets: MasteryTargetDraft[];
  unresolved: string[];
  maxTargets: number;
  minimumRequiredTargets: number;
}): Promise<{
  targets: MasteryTargetDraft[];
  unresolved: string[];
  usage: GenerationUsage;
}> {
  const result = await structuredRequest({
    userId: input.userId,
    operation: "v2.source.critic",
    model: criticModel(),
    maxTokens: 10_000,
    system:
      "Act as a strict mastery-test editor and coverage auditor. Return JSON only: {targets:[...],unresolved:[string]}. Consolidate only semantically equivalent targets, split non-atomic targets, remove trivia and repetition, and preserve every materially required supported competency. Retain at least minimumRequiredTargets required targets unless you explicitly report why the source cannot support that floor. The smallest set means the smallest set that still proves mastery; never optimize for a low question count. Audit definitions, notation, formulas and term meanings, mechanisms, complete process or algorithm flow, assumptions, comparisons, practical decisions and diagnostics, limitations, edge cases, and failure modes when present in the input. Never merge unrelated recall targets merely to reduce question count. Do not discard a target merely because another target shares its topic. Preserve evidenceMaterialId and the exact, contiguous evidenceQuote without rewriting it or inserting ellipses; if evidence cannot support a target mark it unsupported and clear its question fields. Ensure every retained question is self-contained and its answer directly proves only that target. Put any material competency that remains uncovered in unresolved. Keep original fields and schema exactly.",
    payload: {
      sourceTitle: input.sourceTitle,
      maxTargets: input.maxTargets,
      minimumRequiredTargets: input.minimumRequiredTargets,
      targets: input.targets,
      unresolved: input.unresolved,
    },
  });
  const proposedTargets = Array.isArray(result.parsed.targets)
    ? result.parsed.targets
        .map(parseTarget)
        .filter((target): target is MasteryTargetDraft => Boolean(target))
        .slice(0, input.maxTargets)
    : input.targets.slice(0, input.maxTargets);
  const proposedRequired = proposedTargets.filter(
    (target) => target.requirement === "required",
  ).length;
  const targets =
    proposedRequired >= input.minimumRequiredTargets
      ? proposedTargets
      : input.targets.slice(0, input.maxTargets);

  return {
    targets,
    unresolved: [
      ...strings(result.parsed.unresolved, 120),
      ...(proposedRequired < input.minimumRequiredTargets
        ? [
            `The critic attempted to reduce coverage below ${input.minimumRequiredTargets} required targets; the pre-critic map was preserved.`,
          ]
        : []),
    ],
    usage: result.usage,
  };
}

function parseSequenceDraft(value: Record<string, unknown>): SequenceDraft | null {
  const modules = Array.isArray(value.modules)
    ? value.modules.flatMap((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const item = raw as Record<string, unknown>;
        const key = text(item.key, 120);
        const title = text(item.title, 200);
        return key && title ? [{ key, title }] : [];
      })
    : [];
  const nodes = Array.isArray(value.nodes)
    ? value.nodes.flatMap((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const item = raw as Record<string, unknown>;
        const targetKey = text(item.targetKey, 160);
        const moduleKey = text(item.moduleKey, 120);
        return targetKey && moduleKey
          ? [{
              targetKey,
              moduleKey,
              prerequisiteTargetKeys: strings(item.prerequisiteTargetKeys, 8),
              externalPrerequisiteKeys: strings(item.externalPrerequisiteKeys, 8),
            }]
          : [];
      })
    : [];
  const externalPrerequisites = Array.isArray(value.externalPrerequisites)
    ? value.externalPrerequisites.flatMap((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const item = raw as Record<string, unknown>;
        const key = text(item.key, 120);
        const statement = text(item.statement, 1_000);
        const blocksTargetKeys = strings(item.blocksTargetKeys, 16);
        return key && statement && blocksTargetKeys.length > 0
          ? [{
              key,
              statement,
              reason: text(item.reason, 1_000),
              blocksTargetKeys,
            }]
          : [];
      })
    : [];
  return modules.length > 0 && nodes.length > 0
    ? { modules, nodes, externalPrerequisites }
    : null;
}

export async function sequenceLearningPath(input: {
  userId: string;
  sourceTitle: string;
  targets: Array<{
    key: string;
    statement: string;
    type: string;
    answerRubric: string | null;
    concepts: string[];
    sourcePosition: number;
    matchedQuestion: {
      id: string;
      prompt: string;
      lifecycle: string;
      latestGrade: string | null;
    } | null;
  }>;
  initialDraft?: SequenceDraft | null;
  validationErrors?: string[];
}): Promise<LearningPathSequenceResult> {
  if (input.targets.length === 0) {
    return { draft: null, usage: EMPTY_GENERATION_USAGE };
  }
  const repair = Boolean(input.initialDraft && input.validationErrors?.length);
  const result = await structuredRequest({
    userId: input.userId,
    operation: repair ? "v2.source.sequence-repair" : "v2.source.sequence",
    model: criticModel(),
    maxTokens: 6_000,
    system:
      "Design the smallest defensible prerequisite path through the supplied atomic mastery targets. Return JSON only: {modules:[{key,title}],nodes:[{targetKey,moduleKey,prerequisiteTargetKeys,externalPrerequisiteKeys}],externalPrerequisites:[{key,statement,reason,blocksTargetKeys}]}. Place every supplied target exactly once. Add only immediate prerequisite edges; never encode mere topical similarity or preferred chronology as a prerequisite. Prefer conceptual dependencies over source order, using sourcePosition only when either order is pedagogically valid. Targets mapped to the same matchedQuestion are recalled together, so never make one of those targets a prerequisite of another. External prerequisites must be genuinely necessary to answer a supplied target and absent from the supplied targets; do not create questions or pretend they came from the source. Keep modules concise and ordered from foundations through application. The learner's prior performance may satisfy a node initially but must not change the objective dependency graph. Avoid cycles, self-dependencies, duplicate keys, and more than six prerequisites per target.",
    payload: {
      sourceTitle: input.sourceTitle,
      targets: input.targets,
      initialDraft: input.initialDraft ?? undefined,
      validationErrors: input.validationErrors ?? undefined,
      instruction: repair
        ? "Replace the initial draft with a complete corrected path that resolves every validation error."
        : "Create the complete path.",
    },
  });
  return { draft: parseSequenceDraft(result.parsed), usage: result.usage };
}

export async function judgeExistingCoverage(input: {
  userId: string;
  targets: Array<{
    key: string;
    statement: string;
    candidateQuestionIds: string[];
  }>;
  questions: Array<{
    id: string;
    prompt: string;
    target: string;
    referenceAnswer: string;
    lifecycle: string;
  }>;
}): Promise<{
  decisions: CoverageMatchDecision[];
  usage: GenerationUsage;
}> {
  if (input.targets.length === 0 || input.questions.length === 0) {
    return { decisions: [], usage: EMPTY_GENERATION_USAGE };
  }
  const result = await structuredRequest({
    userId: input.userId,
    operation: "v2.source.bank-match",
    model: criticModel(),
    maxTokens: 2_500,
    system:
      "Decide whether an existing recall question proves the same knowledge as each mastery target. Return JSON only: {matches:[{targetKey,questionId,decision,reason}]}. decision is equivalent, distinct, or uncertain. Equivalent requires the same answer semantics, scope, constraints, and expected detail; topical similarity is not enough. Prefer distinct over a false duplicate, and uncertain whenever equivalence cannot be defended. Return at most one best candidate per target. Use only candidate IDs supplied for that target.",
    payload: input,
  });
  const decisions = Array.isArray(result.parsed.matches)
    ? result.parsed.matches.slice(0, input.targets.length).flatMap((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          return [];
        }
        const item = raw as Record<string, unknown>;
        const targetKey = text(item.targetKey, 160);
        const questionId = text(item.questionId, 80) || null;
        const decision = item.decision;
        if (
          !targetKey ||
          (decision !== "equivalent" &&
            decision !== "distinct" &&
            decision !== "uncertain")
        ) {
          return [];
        }
        return [
          {
            targetKey,
            questionId,
            decision,
            reason: text(item.reason, 500),
          } satisfies CoverageMatchDecision,
        ];
      })
    : [];

  return { decisions, usage: result.usage };
}
