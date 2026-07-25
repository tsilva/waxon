import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { del, get } from "@vercel/blob";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lte,
  sql,
} from "drizzle-orm";
import { getV2Client, getV2Db } from "@/app/db/v2/client";
import {
  conceptAliases,
  concepts,
  coverageTargets,
  evidenceSpans,
  jobs,
  questionConcepts,
  questionEvidence,
  questions,
  questionVersions,
  sources,
  sourceVersions,
  targetEvidence,
  targetQuestions,
} from "@/app/db/v2/schema";
import { analyzeSourceMaterial } from "./model";
import { claimV2Job } from "./jobs";
import { alignEvidenceQuote } from "./evidenceQuote";
import {
  assessQuestionQuality,
  recallTargetKey,
} from "./questionQuality";
import { extractPdfText } from "./pdf";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_MODEL_TEXT_CHARS = 250_000;
const MAX_REDIRECTS = 5;

function checksum(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function conceptSlug(name: string): string {
  return name
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 120);
}

function readableText(value: string): string {
  if (!/<(?:html|body|main|article|p|div|h[1-6]|script|style)\b/iu.test(value)) {
    return value;
  }

  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<\/(?:p|div|article|section|li|h[1-6]|br)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'");
}

function isBlockedIp(address: string): boolean {
  const normalized = address.toLowerCase();

  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (isIP(normalized) === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8")
    );
  }

  return true;
}

async function fetchPinnedUrl(
  url: URL,
): Promise<{ status: number; location: string | null; body: Uint8Array }> {
  const resolved = await lookup(url.hostname, { all: true, verbatim: true });
  const allowed = resolved.find((item) => !isBlockedIp(item.address));

  if (!allowed || resolved.some((item) => isBlockedIp(item.address))) {
    throw new Error("The source URL resolves to a private or reserved address.");
  }

  return await new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          Accept: "text/html, text/plain, application/pdf;q=0.8",
          "User-Agent": "WaxonSourceReader/2.0",
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, allowed.address, allowed.family);
        },
        timeout: 20_000,
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        let received = 0;

        response.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > MAX_SOURCE_BYTES) {
            request.destroy(new Error("The source is larger than 20 MB."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            location:
              typeof response.headers.location === "string"
                ? response.headers.location
                : null,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("The source URL timed out."));
    });
    request.on("error", reject);
    request.end();
  });
}

async function safeFetchUrl(value: string): Promise<Uint8Array> {
  let current = new URL(value);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (
      !["http:", "https:"].includes(current.protocol) ||
      current.username ||
      current.password ||
      (current.port &&
        !["80", "443"].includes(current.port))
    ) {
      throw new Error("Only public HTTP(S) source URLs are allowed.");
    }

    const response = await fetchPinnedUrl(current);
    if (response.status >= 300 && response.status < 400 && response.location) {
      current = new URL(response.location, current);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`The source URL returned HTTP ${response.status}.`);
    }
    return response.body;
  }

  throw new Error("The source URL redirected too many times.");
}

export async function createSource(input: {
  userId: string;
  kind: "paste" | "url" | "pdf" | "text" | "topic";
  title: string;
  rawText?: string | null;
  originalUrl?: string | null;
  objectUrl?: string | null;
  mimeType?: string | null;
  byteSize?: number;
  contentChecksum?: string;
}): Promise<{ sourceId: string; jobId: string; reused: boolean }> {
  const title = input.title.trim().slice(0, 300) || "Untitled source";
  const rawText = input.rawText?.trim() || null;
  const identityChecksum =
    input.contentChecksum ??
    (rawText
      ? checksum(rawText)
      : input.originalUrl
        ? checksum(input.originalUrl.trim())
        : null);
  const db = getV2Db();
  if (identityChecksum) {
    const [existing] = await db
      .select({ sourceId: sources.id, jobId: jobs.id })
      .from(sources)
      .innerJoin(
        jobs,
        and(
          eq(jobs.userId, sources.userId),
          eq(jobs.type, "process_source"),
          sql`${jobs.payload} ->> 'sourceId' = ${sources.id}::text`,
        ),
      )
      .where(
        and(
          eq(sources.userId, input.userId),
          eq(sources.kind, input.kind),
          eq(sources.checksum, identityChecksum),
        ),
      )
      .limit(1);
    if (existing) {
      return { ...existing, reused: true };
    }
  }

  const capacity = await getV2Client().pool.query<{
    bytes: string;
    source_count: string;
    pending_jobs: string;
  }>(
    `SELECT
       COALESCE((SELECT sum(byte_size) FROM waxon_v2.sources
          WHERE user_id = $1), 0)::text AS bytes,
       (SELECT count(*) FROM waxon_v2.sources
          WHERE user_id = $1)::text AS source_count,
       (SELECT count(*) FROM waxon_v2.jobs
          WHERE user_id = $1 AND status IN ('pending','running'))::text AS pending_jobs`,
    [input.userId],
  );
  const usage = capacity.rows[0];
  if (Number(usage?.bytes ?? 0) + (input.byteSize ?? 0) > 2 * 1024 ** 3) {
    throw new Error(
      "Your 2 GB source-storage limit is full. Erase an unused source before uploading another.",
    );
  }
  if (Number(usage?.source_count ?? 0) >= 10_000) {
    throw new Error("Your source limit is full.");
  }
  if (Number(usage?.pending_jobs ?? 0) >= 200) {
    throw new Error(
      "Your processing queue is full. Let current source work finish before adding more.",
    );
  }

  return await db.transaction(async (tx) => {
    const [source] = await tx
      .insert(sources)
      .values({
        userId: input.userId,
        kind: input.kind,
        title,
        originalUrl: input.originalUrl,
        objectUrl: input.objectUrl,
        mimeType: input.mimeType,
        rawText,
        byteSize:
          input.byteSize ??
          (rawText ? Buffer.byteLength(rawText, "utf8") : 0),
        checksum: identityChecksum,
      })
      .returning({ id: sources.id });
    const [job] = await tx
      .insert(jobs)
      .values({
        userId: input.userId,
        type: "process_source",
        idempotencyKey: source.id,
        priority: 2,
        payload: { sourceId: source.id },
      })
      .returning({ id: jobs.id });

    return { sourceId: source.id, jobId: job.id, reused: false };
  });
}

export async function createGroundedTopicSource(input: {
  userId: string;
  query: string;
}): Promise<{ sourceId: string; jobId: string; reused: boolean }> {
  const query = input.query.trim().slice(0, 300);
  if (query.length < 3) {
    throw new Error("Describe the topic you want to cover.");
  }
  const result = await getV2Client().pool.query<{
    title: string;
    quote: string;
  }>(
    `SELECT s.title, es.quote
       FROM waxon_v2.evidence_spans es
       JOIN waxon_v2.source_versions sv
         ON sv.user_id = es.user_id AND sv.id = es.source_version_id
       JOIN waxon_v2.sources s
         ON s.user_id = sv.user_id AND s.id = sv.source_id
      WHERE es.user_id = $1
        AND s.status = 'ready'
        AND (
          to_tsvector('simple', es.quote) @@ websearch_to_tsquery('simple', $2)
          OR es.quote ILIKE '%' || $2 || '%'
          OR s.title ILIKE '%' || $2 || '%'
        )
      ORDER BY
        ts_rank(
          to_tsvector('simple', es.quote),
          websearch_to_tsquery('simple', $2)
        ) DESC,
        es.created_at DESC
      LIMIT 30`,
    [input.userId, query],
  );
  if (result.rows.length === 0) {
    const candidates = await getV2Client().pool.query<{
      title: string;
      status: typeof sources.$inferSelect.status;
      error: string | null;
      body_text: string | null;
    }>(
      `SELECT
         s.title,
         s.status,
         s.error,
         left(COALESCE(sv.body_text, s.raw_text), 120000) AS body_text
       FROM waxon_v2.sources s
       LEFT JOIN LATERAL (
         SELECT source_version.body_text
           FROM waxon_v2.source_versions source_version
          WHERE source_version.user_id = s.user_id
            AND source_version.source_id = s.id
          ORDER BY source_version.version DESC
          LIMIT 1
       ) sv ON true
      WHERE s.user_id = $1
        AND s.kind <> 'topic'
        AND s.status NOT IN ('erasing', 'erased')
        AND (
          s.title ILIKE '%' || $2 || '%'
          OR COALESCE(sv.body_text, s.raw_text, '') ILIKE '%' || $2 || '%'
          OR (
            COALESCE(sv.body_text, s.raw_text) IS NOT NULL
            AND to_tsvector(
              'simple',
              COALESCE(sv.body_text, s.raw_text)
            ) @@ websearch_to_tsquery('simple', $2)
          )
        )
      ORDER BY
        CASE s.status
          WHEN 'ready' THEN 0
          WHEN 'processing' THEN 1
          WHEN 'captured' THEN 2
          WHEN 'failed' THEN 3
          ELSE 4
        END,
        s.updated_at DESC
      LIMIT 5`,
      [input.userId, query],
    );
    const ready = candidates.rows.filter(
      (candidate) => candidate.status === "ready" && candidate.body_text,
    );
    if (ready.length > 0) {
      const text = ready
        .map(
          (candidate) =>
            `[Source: ${candidate.title}]\n${candidate.body_text}`,
        )
        .join("\n\n")
        .slice(0, MAX_MODEL_TEXT_CHARS);
      return await createSource({
        userId: input.userId,
        kind: "topic",
        title: `Topic: ${query}`,
        rawText: text,
        contentChecksum: checksum(`topic:${query}:${text}`),
      });
    }
    const processing = candidates.rows.find((candidate) =>
      ["captured", "processing"].includes(candidate.status),
    );
    if (processing) {
      throw new Error(
        `“${processing.title}” is still processing. Wait for it to reach Ready, then expand this topic.`,
      );
    }
    const failed = candidates.rows.find(
      (candidate) => candidate.status === "failed",
    );
    if (failed) {
      throw new Error(
        `“${failed.title}” exists, but its processing failed. Open Sources and choose Retry processing.`,
      );
    }
    const disabled = candidates.rows.find(
      (candidate) => candidate.status === "disabled",
    );
    if (disabled) {
      throw new Error(
        `“${disabled.title}” is disabled. Enable it in Sources before expanding this topic.`,
      );
    }
    throw new Error(
      "Waxon could not find a saved source matching that topic. Add a source first.",
    );
  }
  const text = result.rows
    .map((row) => `[Source: ${row.title}]\n${row.quote}`)
    .join("\n\n");

  return await createSource({
    userId: input.userId,
    kind: "topic",
    title: `Topic: ${query}`,
    rawText: text,
    contentChecksum: checksum(`topic:${query}:${text}`),
  });
}

export async function mutateSourceProcessing(input: {
  userId: string;
  sourceId: string;
  action: "retry" | "cancel";
}): Promise<void> {
  const db = getV2Db();
  await db.transaction(async (tx) => {
    const [source] = await tx
      .select({ status: sources.status })
      .from(sources)
      .where(
        and(eq(sources.userId, input.userId), eq(sources.id, input.sourceId)),
      )
      .limit(1);
    if (!source) {
      throw new Error("Source not found.");
    }
    const [job] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.userId, input.userId),
          eq(jobs.type, "process_source"),
          sql`${jobs.payload} ->> 'sourceId' = ${input.sourceId}`,
        ),
      )
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    if (!job) {
      throw new Error("Source processing job not found.");
    }
    if (input.action === "cancel") {
      if (!["pending", "running"].includes(job.status)) {
        throw new Error("This source is not currently processing.");
      }
      await tx
        .update(jobs)
        .set({
          status: "cancelled",
          lockedUntil: null,
          error: "Cancelled by learner.",
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, job.id));
      await tx
        .update(sources)
        .set({
          status: "failed",
          error: "Processing cancelled. Retry whenever you are ready.",
          updatedAt: new Date(),
        })
        .where(eq(sources.id, input.sourceId));
      return;
    }
    if (!["failed", "cancelled"].includes(job.status)) {
      throw new Error("This source does not need a retry.");
    }
    await tx
      .update(jobs)
      .set({
        status: "pending",
        attempts: 0,
        runAfter: new Date(),
        lockedUntil: null,
        progress: 0,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
    await tx
      .update(sources)
      .set({
        status: "captured",
        processingProgress: 0,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(sources.id, input.sourceId));
  });
}

export async function continueSourceAnalysis(input: {
  userId: string;
  sourceId: string;
}): Promise<{ jobId: string; reused: boolean }> {
  const db = getV2Db();
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM waxon_v2.sources
           WHERE user_id = ${input.userId} AND id = ${input.sourceId}
           FOR UPDATE`,
    );
    const [source] = await tx
      .select({
        status: sources.status,
        rawText: sources.rawText,
      })
      .from(sources)
      .where(
        and(eq(sources.userId, input.userId), eq(sources.id, input.sourceId)),
      )
      .limit(1);
    if (!source) {
      throw new Error("Source not found.");
    }
    if (source.status !== "ready" || !source.rawText) {
      throw new Error("Finish the current source processing before continuing.");
    }
    const completedJobs = await tx
      .select({ result: jobs.result })
      .from(jobs)
      .where(
        and(
          eq(jobs.userId, input.userId),
          eq(jobs.type, "process_source"),
          eq(jobs.status, "succeeded"),
          sql`${jobs.payload} ->> 'sourceId' = ${input.sourceId}`,
        ),
      )
      .orderBy(desc(jobs.createdAt));
    const analyzedThrough = Math.max(
      0,
      ...completedJobs.map((row) => {
        const value = row.result?.analyzedThrough;
        return typeof value === "number" && Number.isFinite(value)
          ? value
          : Math.min(source.rawText?.length ?? 0, MAX_MODEL_TEXT_CHARS);
      }),
    );
    if (analyzedThrough >= source.rawText.length) {
      throw new Error("This source has already been analyzed to the end.");
    }
    const idempotencyKey = `${input.sourceId}:continue:${analyzedThrough}`;
    const [existing] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.userId, input.userId),
          eq(jobs.type, "process_source"),
          eq(jobs.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      return { jobId: existing.id, reused: true };
    }
    const [job] = await tx
      .insert(jobs)
      .values({
        userId: input.userId,
        type: "process_source",
        idempotencyKey,
        priority: 2,
        payload: {
          sourceId: input.sourceId,
          offset: analyzedThrough,
        },
      })
      .returning({ id: jobs.id });
    await tx
      .update(sources)
      .set({
        status: "captured",
        processingProgress: Math.min(
          95,
          Math.floor((analyzedThrough / source.rawText.length) * 100),
        ),
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(sources.id, input.sourceId));
    return { jobId: job.id, reused: false };
  });
}

async function loadSourceText(source: typeof sources.$inferSelect): Promise<string> {
  if (source.rawText) {
    return source.rawText;
  }
  if (source.kind === "url" && source.originalUrl) {
    const bytes = await safeFetchUrl(source.originalUrl);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
  if (!source.objectUrl) {
    throw new Error("The source has no readable content.");
  }

  const blob = await get(source.objectUrl, { access: "private" });
  if (!blob?.stream) {
    throw new Error("The uploaded source could not be read.");
  }
  const bytes = new Uint8Array(await new Response(blob.stream).arrayBuffer());
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new Error("The source is larger than 20 MB.");
  }
  return source.kind === "pdf"
    ? await extractPdfText(bytes)
    : new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export async function runSourceJob(jobId: string): Promise<void> {
  const db = getV2Db();
  const job = await claimV2Job(jobId, "process_source");
  if (!job) {
    return;
  }
  const sourceId =
    typeof job.payload.sourceId === "string" ? job.payload.sourceId : "";
  const requestedOffset =
    typeof job.payload.offset === "number" &&
    Number.isFinite(job.payload.offset) &&
    job.payload.offset > 0
      ? Math.floor(job.payload.offset)
      : 0;
  const [source] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.userId, job.userId), eq(sources.id, sourceId)))
    .limit(1);
  if (!source || ["disabled", "erased", "erasing"].includes(source.status)) {
    await db
      .update(jobs)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(jobs.id, job.id));
    return;
  }

  await db
    .update(sources)
    .set({
      status: "processing",
      processingProgress: 10,
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(sources.id, source.id));

  try {
    const fullText = readableText(await loadSourceText(source))
      .replace(/\u0000/gu, "")
      .trim();
    const analysisOffset = Math.min(requestedOffset, fullText.length);
    const analysisText = fullText.slice(
      analysisOffset,
      analysisOffset + MAX_MODEL_TEXT_CHARS,
    );
    if (analysisText.length < 40) {
      throw new Error("The source did not contain enough readable text.");
    }
    await db
      .update(sources)
      .set({
        rawText: fullText,
        checksum: source.checksum ?? checksum(fullText),
        processingProgress: 30,
        updatedAt: new Date(),
      })
      .where(eq(sources.id, source.id));
    const analysis = await analyzeSourceMaterial({
      userId: source.userId,
      title: source.title,
      text: analysisText,
    });
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM waxon_v2.jobs WHERE id = ${job.id} FOR UPDATE`,
      );
      const [currentJob] = await tx
        .select({ status: jobs.status })
        .from(jobs)
        .where(eq(jobs.id, job.id))
        .limit(1);
      if (currentJob?.status !== "running") {
        return;
      }
      const [version] =
        analysisOffset === 0
          ? await tx
              .insert(sourceVersions)
              .values({
                userId: source.userId,
                sourceId: source.id,
                version: 1,
                bodyText: fullText,
                checksum: checksum(fullText),
              })
              .returning({ id: sourceVersions.id })
          : await tx
              .select({ id: sourceVersions.id })
              .from(sourceVersions)
              .where(
                and(
                  eq(sourceVersions.userId, source.userId),
                  eq(sourceVersions.sourceId, source.id),
                ),
              )
              .orderBy(desc(sourceVersions.version))
              .limit(1);
      if (!version) {
        throw new Error("The source version required for continuation is missing.");
      }
      if (analysisOffset > 0) {
        await tx
          .delete(coverageTargets)
          .where(
            and(
              eq(coverageTargets.userId, source.userId),
              eq(coverageTargets.sourceId, source.id),
              eq(coverageTargets.targetType, "analysis-pending"),
            ),
          );
      }

      for (const target of analysis.targets) {
        const evidenceMatch = alignEvidenceQuote(
          analysisText,
          target.evidenceQuote,
        );
        const evidenceQuote =
          evidenceMatch?.quote ?? target.evidenceQuote.slice(0, 16_000);
        const startOffset = evidenceMatch
          ? analysisOffset + evidenceMatch.startOffset
          : 0;
        const endOffset = evidenceMatch
          ? analysisOffset + evidenceMatch.endOffset
          : evidenceQuote.length;
        const [evidence] = await tx
          .insert(evidenceSpans)
          .values({
            userId: source.userId,
            sourceVersionId: version.id,
            section: target.type,
            startOffset,
            endOffset,
            quote: evidenceQuote,
          })
          .returning({ id: evidenceSpans.id });
        const canDraft = Boolean(
          target.question &&
          target.answer &&
          target.answerMode &&
          evidenceMatch,
        );
        const [coverage] = await tx
          .insert(coverageTargets)
          .values({
            userId: source.userId,
            sourceId: source.id,
            targetType: target.type,
            statement: target.statement,
            status: canDraft ? "weak" : "unresolved",
          })
          .returning({ id: coverageTargets.id });
        await tx.insert(targetEvidence).values({
          userId: source.userId,
          targetId: coverage.id,
          evidenceSpanId: evidence.id,
        });

        if (!canDraft || !target.question || !target.answer || !target.answerMode) {
          continue;
        }
        const quality = assessQuestionQuality({
          prompt: target.question,
          referenceAnswer: target.answer,
          target: target.statement,
        });
        const targetKey = recallTargetKey(target.statement);
        const [duplicate] = await tx
          .select({ id: questions.id })
          .from(questions)
          .where(
            and(
              eq(questions.userId, source.userId),
              eq(questions.targetKey, targetKey),
              inArray(questions.lifecycle, ["new", "learning", "review"]),
            ),
          )
          .limit(1);
        const [question] = await tx
          .insert(questions)
          .values({
            userId: source.userId,
            lifecycle: "draft",
            targetKey,
          })
          .returning({ id: questions.id });
        const [questionVersion] = await tx
          .insert(questionVersions)
          .values({
            userId: source.userId,
            questionId: question.id,
            version: 1,
            prompt: target.question,
            referenceAnswer: target.answer,
            displayAnswer: target.displayAnswer || target.answer.slice(0, 8_000),
            mode: target.answerMode,
            targetText: target.statement,
            quality: duplicate
              ? "duplicate"
              : quality.passes
                ? "pending"
                : "rejected",
            qualityReasons: duplicate
              ? ["An active question already covers this recall target."]
              : quality.reasons,
            duplicateOfQuestionId: duplicate?.id,
          })
          .returning({ id: questionVersions.id });
        await tx.insert(questionEvidence).values([
          {
            userId: source.userId,
            questionVersionId: questionVersion.id,
            evidenceSpanId: evidence.id,
            requirement: "recall-target",
          },
          {
            userId: source.userId,
            questionVersionId: questionVersion.id,
            evidenceSpanId: evidence.id,
            requirement: "reference-answer",
          },
        ]);
        await tx.insert(targetQuestions).values({
          userId: source.userId,
          targetId: coverage.id,
          questionId: question.id,
        });

        for (const rawConcept of target.concepts) {
          const name = rawConcept.trim().slice(0, 120);
          const slug = conceptSlug(name);
          if (!name || !slug) {
            continue;
          }
          const [concept] = await tx
            .insert(concepts)
            .values({ userId: source.userId, name, slug })
            .onConflictDoUpdate({
              target: [concepts.userId, concepts.slug],
              set: { name, updatedAt: new Date() },
            })
            .returning({ id: concepts.id });
          await tx
            .insert(questionConcepts)
            .values({
              userId: source.userId,
              questionId: question.id,
              conceptId: concept.id,
            })
            .onConflictDoNothing();
          await tx
            .insert(conceptAliases)
            .values({
              userId: source.userId,
              conceptId: concept.id,
              alias: name.toLocaleLowerCase("und"),
            })
            .onConflictDoNothing();
        }
        if (!duplicate && quality.passes) {
          await tx.insert(jobs).values({
            userId: source.userId,
            type: "activate_question",
            idempotencyKey: questionVersion.id,
            priority: 1,
            payload: {
              questionId: question.id,
              questionVersionId: questionVersion.id,
            },
          });
        }
      }

      for (const unresolved of analysis.unresolved) {
        await tx.insert(coverageTargets).values({
          userId: source.userId,
          sourceId: source.id,
          targetType: "unresolved-residual",
          statement: unresolved,
          status: "unresolved",
        });
      }
      const analyzedThrough = analysisOffset + analysisText.length;
      if (fullText.length > analyzedThrough) {
        await tx.insert(coverageTargets).values({
          userId: source.userId,
          sourceId: source.id,
          targetType: "analysis-pending",
          statement: `Analysis has not yet mapped the remaining ${(
            fullText.length - analyzedThrough
          ).toLocaleString("en-US")} characters of this source.`,
          status: "unresolved",
        });
      }
      await tx
        .update(sources)
        .set({
          status: "ready",
          processingProgress: 100,
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(sources.id, source.id));
      await tx
        .update(jobs)
        .set({
          status: "succeeded",
          progress: 100,
          lockedUntil: null,
          result: {
            sourceId: source.id,
            targetCount: analysis.targets.length,
            unresolvedCount: analysis.unresolved.length,
            analyzedThrough,
            remainingCharacters: Math.max(0, fullText.length - analyzedThrough),
          },
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, job.id));
    });
  } catch (error) {
    const attempts = job.attempts;
    const message =
      error instanceof Error ? error.message.slice(0, 2_000) : "Unknown error";
    const failedJobs = await db
      .update(jobs)
      .set({
        status: attempts >= 3 ? "failed" : "pending",
        runAfter: new Date(Date.now() + attempts * 30_000),
        lockedUntil: null,
        error: message,
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")))
      .returning({ id: jobs.id });
    if (failedJobs.length > 0) {
      await db
        .update(sources)
        .set({
          status: attempts >= 3 ? "failed" : "captured",
          error: message,
          updatedAt: new Date(),
        })
        .where(eq(sources.id, source.id));
    }
    throw error;
  }
}

export async function runPendingSourceJobs(input: {
  userId?: string;
  limit?: number;
}): Promise<number> {
  const db = getV2Db();
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        input.userId ? eq(jobs.userId, input.userId) : undefined,
        eq(jobs.type, "process_source"),
        eq(jobs.status, "pending"),
        lte(jobs.runAfter, new Date()),
      ),
    )
    .orderBy(asc(jobs.createdAt))
    .limit(Math.max(1, Math.min(5, input.limit ?? 1)));
  let processed = 0;
  for (const row of rows) {
    try {
      await runSourceJob(row.id);
      processed += 1;
    } catch {
      // Source and job rows expose retry state and failure details.
    }
  }
  return processed;
}

export async function setSourceDisabled(input: {
  userId: string;
  sourceId: string;
  disabled: boolean;
}): Promise<void> {
  const db = getV2Db();
  await db.transaction(async (tx) => {
    const [source] = await tx
      .select({ status: sources.status })
      .from(sources)
      .where(
        and(eq(sources.userId, input.userId), eq(sources.id, input.sourceId)),
      )
      .limit(1);
    if (!source) {
      throw new Error("Source not found.");
    }
    await tx
      .update(sources)
      .set({
        status: input.disabled ? "disabled" : "ready",
        disabledAt: input.disabled ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(sources.id, input.sourceId));
    if (input.disabled) {
      await tx.execute(sql`
        UPDATE waxon_v2.questions q
           SET lifecycle = 'suspended',
               prior_lifecycle = q.lifecycle,
               suspension_reason = 'All supporting sources are disabled.',
               updated_at = now()
         WHERE q.user_id = ${input.userId}
           AND q.lifecycle IN ('new', 'learning', 'review')
           AND EXISTS (
             SELECT 1
               FROM waxon_v2.question_versions qv
               JOIN waxon_v2.question_evidence qe
                 ON qe.user_id = qv.user_id
                AND qe.question_version_id = qv.id
               JOIN waxon_v2.evidence_spans es
                 ON es.user_id = qe.user_id
                AND es.id = qe.evidence_span_id
               JOIN waxon_v2.source_versions sv
                 ON sv.user_id = es.user_id
                AND sv.id = es.source_version_id
              WHERE qv.user_id = q.user_id
                AND qv.question_id = q.id
                AND qv.is_current = true
                AND sv.source_id = ${input.sourceId}
           )
           AND NOT EXISTS (
             SELECT 1
               FROM waxon_v2.question_versions qv
               JOIN waxon_v2.question_evidence qe
                 ON qe.user_id = qv.user_id
                AND qe.question_version_id = qv.id
               JOIN waxon_v2.evidence_spans es
                 ON es.user_id = qe.user_id
                AND es.id = qe.evidence_span_id
               JOIN waxon_v2.source_versions sv
                 ON sv.user_id = es.user_id
                AND sv.id = es.source_version_id
               JOIN waxon_v2.sources other_source
                 ON other_source.user_id = sv.user_id
                AND other_source.id = sv.source_id
              WHERE qv.user_id = q.user_id
                AND qv.question_id = q.id
                AND qv.is_current = true
                AND other_source.status = 'ready'
           )
      `);
      await tx.execute(sql`
        UPDATE waxon_v2.retry_obligations ro
           SET status = 'waived',
               reason = 'Required source support is disabled.',
               updated_at = now()
          FROM waxon_v2.questions q
         WHERE ro.user_id = ${input.userId}
           AND q.user_id = ro.user_id
           AND q.id = ro.question_id
           AND q.lifecycle = 'suspended'
           AND q.suspension_reason = 'All supporting sources are disabled.'
           AND ro.status IN ('queued', 'deferred')
      `);
      await tx.execute(sql`
        UPDATE waxon_v2.review_session_items rsi
           SET state = 'invalidated'
          FROM waxon_v2.questions q
         WHERE rsi.user_id = ${input.userId}
           AND q.user_id = rsi.user_id
           AND q.id = rsi.question_id
           AND q.lifecycle = 'suspended'
           AND q.suspension_reason = 'All supporting sources are disabled.'
           AND rsi.state = 'queued'
      `);
    } else {
      await tx.execute(sql`
        UPDATE waxon_v2.questions q
           SET lifecycle = CASE
                 WHEN q.prior_lifecycle IN ('new', 'learning', 'review')
                   THEN q.prior_lifecycle
                 ELSE 'new'
               END,
               prior_lifecycle = NULL,
               suspension_reason = NULL,
               updated_at = now()
         WHERE q.user_id = ${input.userId}
           AND q.lifecycle = 'suspended'
           AND q.suspension_reason = 'All supporting sources are disabled.'
           AND EXISTS (
             SELECT 1
               FROM waxon_v2.question_versions qv
               JOIN waxon_v2.question_evidence qe
                 ON qe.user_id = qv.user_id
                AND qe.question_version_id = qv.id
               JOIN waxon_v2.evidence_spans es
                 ON es.user_id = qe.user_id
                AND es.id = qe.evidence_span_id
               JOIN waxon_v2.source_versions sv
                 ON sv.user_id = es.user_id
                AND sv.id = es.source_version_id
              WHERE qv.user_id = q.user_id
                AND qv.question_id = q.id
                AND qv.is_current = true
                AND sv.source_id = ${input.sourceId}
           )
      `);
      await tx.execute(sql`
        UPDATE waxon_v2.memory_states ms
           SET due_at = LEAST(ms.due_at, now()),
               updated_at = now()
          FROM waxon_v2.retry_obligations ro
         WHERE ms.user_id = ${input.userId}
           AND ro.user_id = ms.user_id
           AND ro.question_id = ms.question_id
           AND ro.status = 'waived'
           AND ro.reason = 'Required source support is disabled.'
           AND EXISTS (
             SELECT 1
               FROM waxon_v2.question_versions qv
               JOIN waxon_v2.question_evidence qe
                 ON qe.user_id = qv.user_id
                AND qe.question_version_id = qv.id
               JOIN waxon_v2.evidence_spans es
                 ON es.user_id = qe.user_id
                AND es.id = qe.evidence_span_id
               JOIN waxon_v2.source_versions sv
                 ON sv.user_id = es.user_id
                AND sv.id = es.source_version_id
              WHERE qv.user_id = ms.user_id
                AND qv.question_id = ms.question_id
                AND qv.is_current = true
                AND sv.source_id = ${input.sourceId}
           )
      `);
    }
  });
}

export async function sourceErasePreview(
  userId: string,
  sourceId: string,
): Promise<{
  sourceTitle: string;
  evidenceLinks: number;
  questionsLosingLastSource: number;
}> {
  const db = getV2Db();
  const [source] = await db
    .select({ title: sources.title })
    .from(sources)
    .where(and(eq(sources.userId, userId), eq(sources.id, sourceId)))
    .limit(1);
  if (!source) {
    throw new Error("Source not found.");
  }
  const result = await db.execute(sql`
    SELECT
      count(DISTINCT qe.question_version_id)::int AS evidence_links,
      count(DISTINCT q.id) FILTER (
        WHERE NOT EXISTS (
          SELECT 1
            FROM waxon_v2.question_versions qv2
            JOIN waxon_v2.question_evidence qe2
              ON qe2.user_id = qv2.user_id
             AND qe2.question_version_id = qv2.id
            JOIN waxon_v2.evidence_spans es2
              ON es2.user_id = qe2.user_id
             AND es2.id = qe2.evidence_span_id
            JOIN waxon_v2.source_versions sv2
              ON sv2.user_id = es2.user_id
             AND sv2.id = es2.source_version_id
           WHERE qv2.user_id = q.user_id
             AND qv2.question_id = q.id
             AND qv2.is_current = true
             AND sv2.source_id <> ${sourceId}
        )
      )::int AS questions_losing_last_source
      FROM waxon_v2.source_versions sv
      JOIN waxon_v2.evidence_spans es
        ON es.user_id = sv.user_id AND es.source_version_id = sv.id
      LEFT JOIN waxon_v2.question_evidence qe
        ON qe.user_id = es.user_id AND qe.evidence_span_id = es.id
      LEFT JOIN waxon_v2.question_versions qv
        ON qv.user_id = qe.user_id AND qv.id = qe.question_version_id
      LEFT JOIN waxon_v2.questions q
        ON q.user_id = qv.user_id AND q.id = qv.question_id
     WHERE sv.user_id = ${userId} AND sv.source_id = ${sourceId}
  `);
  const row = result.rows[0] as
    | { evidence_links?: number; questions_losing_last_source?: number }
    | undefined;

  return {
    sourceTitle: source.title,
    evidenceLinks: Number(row?.evidence_links ?? 0),
    questionsLosingLastSource: Number(
      row?.questions_losing_last_source ?? 0,
    ),
  };
}

export async function getSourceManifest(userId: string, sourceId: string) {
  const db = getV2Db();
  const [source] = await db
    .select({
      id: sources.id,
      title: sources.title,
      status: sources.status,
      originalUrl: sources.originalUrl,
    })
    .from(sources)
    .where(and(eq(sources.userId, userId), eq(sources.id, sourceId)))
    .limit(1);
  if (!source) {
    throw new Error("Source not found.");
  }
  const targets = await db
    .select({
      id: coverageTargets.id,
      type: coverageTargets.targetType,
      statement: coverageTargets.statement,
      status: coverageTargets.status,
      ignoreReason: coverageTargets.ignoreReason,
      evidenceQuote: evidenceSpans.quote,
    })
    .from(coverageTargets)
    .leftJoin(
      targetEvidence,
      and(
        eq(targetEvidence.userId, coverageTargets.userId),
        eq(targetEvidence.targetId, coverageTargets.id),
      ),
    )
    .leftJoin(
      evidenceSpans,
      and(
        eq(evidenceSpans.userId, targetEvidence.userId),
        eq(evidenceSpans.id, targetEvidence.evidenceSpanId),
      ),
    )
    .where(
      and(
        eq(coverageTargets.userId, userId),
        eq(coverageTargets.sourceId, sourceId),
      ),
    )
    .orderBy(asc(coverageTargets.createdAt))
    .limit(250);

  return { source, targets };
}

export async function eraseSource(input: {
  userId: string;
  sourceId: string;
}): Promise<void> {
  const db = getV2Db();
  const [source] = await db
    .select()
    .from(sources)
    .where(
      and(eq(sources.userId, input.userId), eq(sources.id, input.sourceId)),
    )
    .limit(1);
  if (!source) {
    throw new Error("Source not found.");
  }
  await db
    .update(sources)
    .set({ status: "erasing", updatedAt: new Date() })
    .where(eq(sources.id, source.id));
  if (source.objectUrl) {
    await del(source.objectUrl);
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM waxon_v2.question_evidence qe
       USING waxon_v2.evidence_spans es, waxon_v2.source_versions sv
       WHERE qe.user_id = ${input.userId}
         AND es.user_id = qe.user_id
         AND es.id = qe.evidence_span_id
         AND sv.user_id = es.user_id
         AND sv.id = es.source_version_id
         AND sv.source_id = ${input.sourceId}
    `);
    await tx
      .delete(sources)
      .where(
        and(
          eq(sources.userId, input.userId),
          eq(sources.id, input.sourceId),
        ),
      );
    await tx.execute(sql`
      UPDATE waxon_v2.questions q
         SET lifecycle = 'suspended',
             prior_lifecycle = q.lifecycle,
             suspension_reason = 'Supporting provenance was erased.',
             updated_at = now()
       WHERE q.user_id = ${input.userId}
         AND q.lifecycle IN ('new', 'learning', 'review')
         AND NOT EXISTS (
           SELECT 1
             FROM waxon_v2.question_versions qv
             JOIN waxon_v2.question_evidence qe
               ON qe.user_id = qv.user_id
              AND qe.question_version_id = qv.id
            WHERE qv.user_id = q.user_id
              AND qv.question_id = q.id
              AND qv.is_current = true
         )
    `);
    await tx.execute(sql`
      UPDATE waxon_v2.retry_obligations ro
         SET status = 'waived',
             reason = 'Required source provenance was erased.',
             updated_at = now()
        FROM waxon_v2.questions q
       WHERE ro.user_id = ${input.userId}
         AND q.user_id = ro.user_id
         AND q.id = ro.question_id
         AND q.lifecycle = 'suspended'
         AND q.suspension_reason = 'Supporting provenance was erased.'
         AND ro.status IN ('queued', 'deferred')
    `);
    await tx.execute(sql`
      UPDATE waxon_v2.review_session_items rsi
         SET state = 'invalidated'
        FROM waxon_v2.questions q
       WHERE rsi.user_id = ${input.userId}
         AND q.user_id = rsi.user_id
         AND q.id = rsi.question_id
         AND q.lifecycle = 'suspended'
         AND q.suspension_reason = 'Supporting provenance was erased.'
         AND rsi.state = 'queued'
    `);
  });
}
