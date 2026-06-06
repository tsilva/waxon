import { NextResponse } from "next/server";

type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; response: NextResponse };

type RateLimitRule = {
  name: string;
  max: number;
  windowMs: number;
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const globalForApiLimits = globalThis as typeof globalThis & {
  waxonApiRateLimits?: Map<string, RateLimitBucket>;
};

const rateLimitBuckets =
  globalForApiLimits.waxonApiRateLimits ?? new Map<string, RateLimitBucket>();

globalForApiLimits.waxonApiRateLimits = rateLimitBuckets;

function jsonError(error: string, status: number, headers?: HeadersInit): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers });
}

export async function readJsonBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<JsonBodyResult> {
  const contentLength = request.headers.get("content-length");
  const declaredBytes = contentLength ? Number.parseInt(contentLength, 10) : null;

  if (
    declaredBytes !== null &&
    Number.isFinite(declaredBytes) &&
    declaredBytes > maxBytes
  ) {
    return {
      ok: false,
      response: jsonError("Request body is too large.", 413),
    };
  }

  const reader = request.body?.getReader();

  if (!reader) {
    return { ok: true, value: null };
  }

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    receivedBytes += value.byteLength;

    if (receivedBytes > maxBytes) {
      await reader.cancel();

      return {
        ok: false,
        response: jsonError("Request body is too large.", 413),
      };
    }

    chunks.push(value);
  }

  const buffer = new Uint8Array(receivedBytes);
  let offset = 0;

  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder().decode(buffer);

  if (!text.trim()) {
    return { ok: true, value: null };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      response: jsonError("Request body must be valid JSON.", 400),
    };
  }
}

export function consumeUserRateLimit(input: {
  userId: string;
  route: string;
  rules: RateLimitRule[];
  now?: number;
}): NextResponse | null {
  const now = input.now ?? Date.now();

  for (const rule of input.rules) {
    const key = `${input.route}:${rule.name}:${input.userId}`;
    const existing = rateLimitBuckets.get(key);

    if (!existing || existing.resetAt <= now) {
      rateLimitBuckets.set(key, {
        count: 1,
        resetAt: now + rule.windowMs,
      });
      continue;
    }

    if (existing.count >= rule.max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((existing.resetAt - now) / 1000),
      );

      return jsonError("Rate limit exceeded. Try again later.", 429, {
        "Retry-After": String(retryAfterSeconds),
      });
    }

    existing.count += 1;
  }

  return null;
}

export function normalizeBoundedText(
  value: unknown,
  input: {
    field: string;
    maxLength: number;
    required?: boolean;
  },
): { ok: true; value: string } | { ok: false; response: NextResponse } {
  if (typeof value !== "string") {
    if (input.required) {
      return {
        ok: false,
        response: jsonError(`${input.field} is required.`, 400),
      };
    }

    return { ok: true, value: "" };
  }

  const normalized = value.trim();

  if (input.required && !normalized) {
    return {
      ok: false,
      response: jsonError(`${input.field} is required.`, 400),
    };
  }

  if (normalized.length > input.maxLength) {
    return {
      ok: false,
      response: jsonError(
        `${input.field} must be ${input.maxLength} characters or fewer.`,
        400,
      ),
    };
  }

  return { ok: true, value: normalized };
}
