# Issue 20 clean-break learner journey

This is the source of truth for the final native-browser acceptance run for GitHub issue #20 and the Library Flagging extension in issue #32. Run every case with the project-level `run-browser-use-suite` skill and the native Codex Desktop in-app Browser (`iab`). Do not substitute standalone Playwright, another browser, Computer Use, or API-only evidence.

## Result policy

- Record every numbered case as `pass`, `fail`, or `skipped`. A skipped required case does not satisfy #20.
- Use visible UI interaction for every Learner mutation, including Library actions, Learner settings, and MCP credential creation/revocation. The IAB page-evaluation runtime has no `fetch`, so the runner may use Node-side `fetch` only through the guarded helper below and only to these absolute tested-origin diagnostics: read-only `GET <tested-origin>/api/v2/library`, read-only `GET <tested-origin>/api/v2/review/queue`, read-only `GET <tested-origin>/api/test-support/browser-smoke`, fixture-seeding `POST <tested-origin>/api/test-support/browser-smoke`, and Streamable HTTP `POST <tested-origin>/api/mcp`. No other method/endpoint pair is allowed. Diagnostic requests supplement rather than replace visible assertions.
- Take a fresh DOM snapshot before changing locator strategy. Wait for named visible content, not `networkidle`.
- Capture desktop and narrow screenshots under `/private/tmp` with `issue-20-clean-break` in each filename. Capture every failure or ambiguous state.
- Record the exact printed dev URL, visible assertions, console warnings/errors, commands, screenshot paths, failures, and remaining risks in `docs/issue-20-clean-break-evidence.md`.

## Safety and preconditions

1. Use a disposable fresh pgvector/Postgres database. Never use or reset production data or secrets.
2. The browser must use the dedicated acceptance identity: `Issue 20 browser learner`, `issue-20-browser@waxon.invalid`. If Tiago's personal identity appears, stop without creating/revoking an MCP credential or changing any Question.
3. The fixture endpoint is enabled only in development with local test auth and the dedicated acceptance-identity flag. It mutates only the named Local Day boundary Question, five local Review fixtures, and one known synthetic second-Learner fixture. It refuses to seed while an unrelated Active Question remains.
4. The safety grant covers only the exact Library, validation, Review, MCP, and isolation fixtures named in this file plus the dedicated acceptance Learner's MCP credential. Archive and restore only the named suite Questions. Do not alter any other Learner or data.
5. Reuse a suitable existing server. Do not kill or restart any existing server. If none exists, start exactly one server with `--port auto` and retain its printed URL:

```bash
DATABASE_URL="$ISSUE20_DATABASE_URL" \
DATABASE_URL_UNPOOLED="$ISSUE20_DATABASE_URL" \
WAXON_ENABLE_BROWSER_SMOKE_SUPPORT=1 \
WAXON_BROWSER_SMOKE_EVALUATOR=1 \
WAXON_QUESTION_SEARCH_MODE=lexical \
NEXT_PUBLIC_WAXON_BROWSER_ACCEPTANCE_USER=1 \
pnpm dev --port auto
```

6. Before starting the server, install the clean baseline in the disposable database:

```bash
DATABASE_URL="$ISSUE20_DATABASE_URL" \
DATABASE_URL_UNPOOLED="$ISSUE20_DATABASE_URL" \
pnpm db:reset -- --confirm-clean-break
```

7. If `POST /api/test-support/browser-smoke` returns `404`, the required development guard is absent; stop rather than weakening it. If it returns `409`, archive only suite-created Active Questions or reset the disposable database, then retry.

## Stable values

Use these exact values so the visible and API assertions remain deterministic.

Library Question:

```text
Prompt: Issue 20 Library journey: what makes a Question replacement immutable?
Original Answer Standard: The original Question keeps its Learning Evidence. Acceptance token: browser-smoke-correct-token.
Replacement Answer Standard: Replacement creates a new Active Question with reset mastery while the original is Archived.
```

Validation-Flagged Question:

```text
Prompt: What does the content provided above mean?
Answer Standard: It describes the accepted clean-break learner journey.
```

Library learner-Flag Questions:

```text
Detailed Prompt: Issue 32 Library Flagging: which Active Question gets detailed attention?
Detailed Answer Standard: The non-current Active Question receives Learner reasons and detail.
Empty Prompt: Issue 32 Library Flagging: which Active Question allows an empty Flag?
Empty Answer Standard: Any retained Active Question may be Flagged without reasons or detail.
Detailed Flag detail: This retained Question needs attention outside Review.
```

Deterministic Review answer:

```text
Correct: browser-smoke-correct-token
Incorrect: This answer deliberately omits the required token.
```

MCP check candidates and add payload:

```js
const mcpCheckItems = [
  {
    candidateId: "issue-20-mcp-active",
    "prompt": "Issue 20 MCP journey: what proves canonical add semantics?",
    "referenceAnswer": "The same isolated Question application service."
  },
  {
    candidateId: "issue-20-mcp-flagged",
    "prompt": "Which fact was mentioned above?",
    "referenceAnswer": "The fact belongs to a missing external context."
  }
];
const mcpAddItems = mcpCheckItems.map(
  ({ candidateId: _candidateId, ...item }) => item,
);
```

Use `mcpCheckItems` only with `check_questions`. Use `mcpAddItems`, which deliberately strips `candidateId`, with every `add_questions` creation, replay, and duplicate call.

The known second-Learner probe is:

```text
Issue 20 isolation probe: which Question belongs only to the other Learner?
```

## Guarded runner-side diagnostic transport and MCP helper

Set `testedOrigin` to the exact printed local dev origin, including its automatic port. The guard below rejects non-loopback origins, cross-origin resolution, unlisted paths, and unlisted methods. Use it for every suite diagnostic because IAB evaluation cannot fetch. Learner-facing Library mutations, settings changes, and credential creation/revocation still happen visibly in IAB.

Keep the MCP token and optional session ID only in runner-side process memory. Transfer the one-time token directly from the visible IAB result into the in-memory `mcpToken` variable; never include it in a command line, log call, console output, storage, file, screenshot, or evidence report. Every MCP request uses the absolute tested-origin `/api/mcp` URL with `Authorization: Bearer …`, `Content-Type: application/json`, and `Accept: application/json, text/event-stream`. Parse either a JSON response or server-sent `data:` lines.

```js
// Set this once from the exact printed dev URL; do not infer a port.
const testedOrigin = "http://localhost:<auto-port>";
const issue20Origin = new URL(testedOrigin);
if (
  issue20Origin.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(issue20Origin.hostname)
) {
  throw new Error("Issue 20 diagnostics require the printed loopback origin.");
}

const issue20DiagnosticPolicy = new Map([
  ["/api/v2/library", new Set(["GET"])],
  ["/api/v2/review/queue", new Set(["GET"])],
  ["/api/test-support/browser-smoke", new Set(["GET", "POST"])],
  ["/api/mcp", new Set(["POST"])],
]);

const issue20DiagnosticEndpoints = Object.freeze({
  questionBank: new URL("/api/v2/library", issue20Origin).href,
  reviewQueue: new URL("/api/v2/review/queue", issue20Origin).href,
  fixture: new URL("/api/test-support/browser-smoke", issue20Origin).href,
  mcp: new URL("/api/mcp", issue20Origin).href,
});

async function issue20DiagnosticRequest(absoluteUrl, init = {}) {
  const url = new URL(absoluteUrl);
  const method = String(init.method ?? "GET").toUpperCase();
  if (url.origin !== issue20Origin.origin) {
    throw new Error(`Cross-origin diagnostic rejected: ${url.origin}`);
  }
  if (!issue20DiagnosticPolicy.get(url.pathname)?.has(method)) {
    throw new Error(`Diagnostic request rejected: ${method} ${url.pathname}`);
  }
  return fetch(url.href, { ...init, method });
}
```

Initialize before calling tools. Capture the optional `mcp-session-id` response header and send it on every later request when present. Then send the initialized notification. The current service may operate statelessly and omit the session header; that is valid, but the initialize and notification exchange is still required by this suite.

```js
function issue20McpHeaders(token, sessionId) {
  return {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };
}

async function issue20McpRequest(token, sessionId, payload) {
  const response = await issue20DiagnosticRequest(issue20DiagnosticEndpoints.mcp, {
    method: "POST",
    headers: issue20McpHeaders(token, sessionId),
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const events = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()));
  let envelope = events.at(-1) ?? null;
  if (!envelope && text.trim().startsWith("{")) {
    envelope = JSON.parse(text);
  }
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
    envelope,
    text: envelope ? null : text,
  };
}

async function issue20McpInitialize(token) {
  const initialized = await issue20McpRequest(token, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "waxon-issue-20-native-browser", version: "1.0.0" },
    },
  });
  if (initialized.status !== 200 || initialized.envelope?.error) {
    throw new Error(`MCP initialize failed (${initialized.status}).`);
  }
  const notified = await issue20McpRequest(
    token,
    initialized.sessionId,
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  );
  if (notified.status !== 200 && notified.status !== 202) {
    throw new Error(`MCP initialized notification failed (${notified.status}).`);
  }
  return { token, sessionId: notified.sessionId };
}

async function issue20McpCall(client, id, name, args) {
  const response = await issue20McpRequest(client.token, client.sessionId, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  client.sessionId = response.sessionId;
  return response;
}
```

Create one `mcpClient` with `await issue20McpInitialize(mcpToken)`. For successful tool calls require HTTP `200`, no JSON-RPC error, and use `envelope.result.structuredContent` for the assertions below. Use monotonically increasing request IDs. After revocation, reuse the same client state and require `401` before any MCP envelope or Library data is returned.

## Acceptance journey

### 1. Identity, private Library, and initial legacy-control absence

1. Open the printed URL at `/library` in `iab` at a desktop viewport of at least 1280 × 800.
2. Require the visible isolated identity `Issue 20 browser learner` and `issue-20-browser@waxon.invalid`, the `Library` tab, the `Review` tab, and the empty-Library state. If the Library is not empty on the freshly reset disposable database, stop and report the mismatch.
3. Inspect visible controls and accessible names. Require no control named or containing `Pause`, `Trash`, `capacity`, `retention`, `source`, `generation`, `concept`, `provenance`, `coverage`, or `document` (case-insensitive). Also require no daily-minutes, item-limit, importance, uncertainty, or answer-mode control.
4. Capture `/private/tmp/issue-20-clean-break-library-desktop.png`.

### 2. Add, search, immutable replace, Archive, and restore

1. Activate `Add question`, enter the exact Library Prompt and Original Answer Standard, and submit `Add to Library`.
2. Require the visible status `Active Question added to your Library.`, an `Active` lifecycle badge, and the exact Prompt. Search for `replacement immutable` and require exactly the suite Question.
3. Through runner-side `issue20DiagnosticRequest(issue20DiagnosticEndpoints.questionBank + "?search=replacement%20immutable")`, record the Active Question ID as `originalId`; do not treat this request as a replacement for the visible search assertion.
4. Open `/review` for the first time and require the exact Library Prompt is current. Open `Local Day settings`, require the IANA timezone equals `Intl.DateTimeFormat().resolvedOptions().timeZone`, and close settings; this is the automatic-detection assertion. Answer with the stable Correct token and wait for evaluation. Require the visible result is `Correct`, a visible Answer Standard, and a future scheduled Local Day.
5. Return to `/library`, search for `replacement immutable`, and require the original remains Active with a visible future due date. Through `issue20DiagnosticRequest(issue20DiagnosticEndpoints.fixture)`, record the original's exact `dueAt` as `originalDueAt` and require its evidence is `{ learnerAnswers: 1, evaluations: 1, gradeEvents: 1, dueAt: originalDueAt }`.
6. Activate `Replace question`. Require a modal named `Replace question` and the visible warning that replacement creates a new Question with reset mastery, archives the original with its Learning Evidence intact, and uses quality assessment to determine whether the replacement is Active or Flagged.
7. Keep the Prompt unchanged, replace only the Answer Standard with the exact Replacement Answer Standard, and submit `Replace question`.
8. Require the visible status `Active replacement added. The original Question was archived.`. Through the Library GET diagnostic, record `replacementId` and require exactly one Active replacement and one Archived original with the same Prompt, different IDs, `originalId` on the Archived result, the two unchanged Answer Standards on their respective identities, `dueAt: null` on the replacement, and `dueAt: originalDueAt` on the original.
9. Through `issue20DiagnosticRequest(issue20DiagnosticEndpoints.fixture)`, require `originalId` remains Archived with evidence `{ learnerAnswers: 1, evaluations: 1, gradeEvents: 1, dueAt: originalDueAt }`, while `replacementId` is Active with reset evidence `{ learnerAnswers: 0, evaluations: 0, gradeEvents: 0, dueAt: null }`.
10. Open `/review`. Require `replacementId`'s exact Prompt is immediately current even though the reviewed original was scheduled in the future; this visibly proves the new immutable identity reset mastery and entered the live queue.
11. Return to `/library`, search for `replacement immutable`, select `Active`, scope the action to `replacementId`, and activate `Archive question`. Require `Question archived.` and no Active result for the Prompt.
12. Select `Archived`. Now—and only now—require exactly two Archived identities with the same Prompt; expand both Answer Standards and visibly distinguish the preserved original from its replacement.
13. Scope the row by `replacementId` and the Replacement Answer Standard, activate `Restore question`, and require `Question restored.`. Through the Library GET diagnostic require that same identity is Active with reset evidence still intact through the test-support GET, then open `/review` and require it is immediately current.
14. Return to `/library` and archive `replacementId` once more so no suite-created Active Question remains before Review fixture seeding. Require both immutable identities are Archived and `originalId` still reports the same Learning Evidence and `originalDueAt`.

### 3. Validation Flagging and the Flagged workflow

1. Clear search and activate `Add question`. Add the exact Validation-Flagged Prompt and Answer Standard.
2. Require `Question saved to Flagged for attention.` and no Active lifecycle result for that Prompt.
3. Select the `Flagged` filter. Require the exact Prompt, lifecycle `Flagged`, origin `Waxon validation`, and reason `Not self-contained`.
4. Require Archive, restore, and replace actions on the Flagged Question. Leave it Flagged.

### 3A. Library learner Flagging at desktop and 390 px

1. At a desktop viewport of at least 1280 × 800, clear search and select `Active`. Add the exact Detailed Prompt and Answer Standard, then add the exact Empty Prompt and Answer Standard through the visible `Add question` flow. Require both rows have lifecycle `Active` and each exposes `Flag question`, `Replace question`, and `Archive question`.
2. Open `/review` and retain the exact current Prompt. Return to `/library`, select `Active`, and scope the other row by its exact Prompt. This row is not the current Review Question; activate its `Flag question` control.
3. Require a modal named `Flag this Question` with kicker `Library attention`, multiple optional reason badges, the optional detail field, and enabled `Flag Question` submission. Select `Question is unclear` and `Answer standard is wrong`, enter the exact Detailed Flag detail, and submit visibly.
4. Require status `Question moved to Flagged for attention.`, the same Question identity is absent from `Active`, and the other issue #32 Question remains Active. Select `Flagged`; require the newly Flagged row shows origin `Learner flag`, both selected reason badges, and the exact detail. Through the read-only Library diagnostic, require the same ID changed from Active to Flagged rather than creating another identity.
5. Change to a 390 × 844 viewport. Require the Flagged inbox, detailed learner Flag, action controls, and exact detail remain contained with no horizontal clipping or overlap. Capture `/private/tmp/issue-20-clean-break-question-bank-flag-narrow.png`.
6. Select `Active`, scope the remaining issue #32 row by its exact Prompt, and activate `Flag question`. Require the full modal fits the narrow viewport, can scroll if necessary, and its reason badges form one column. Submit `Flag Question` without selecting any reason or entering detail.
7. Require the empty submission succeeds with status `Question moved to Flagged for attention.`, no issue #32 row remains Active, and the Flagged inbox shows the same second identity with origin `Learner flag` and no reason badge or detail. Open `/review` and require neither issue #32 Prompt is present and no due work from these two Questions remains.
8. Return to `/library`, restore the desktop viewport, select `Flagged`, and require both issue #32 learner Flags remain visible with their distinct empty/detailed evidence. Capture `/private/tmp/issue-20-clean-break-question-bank-flag-desktop.png`. Leave both Questions Flagged so fixture seeding has no unrelated Active Question.

### 4. Seed and prove the deterministic live Review Queue and Local Day

1. While `/library` remains visible, call runner-side `issue20DiagnosticRequest(issue20DiagnosticEndpoints.fixture, { method: "POST" })` with no body. Require HTTP `200`, `ok: true`, six Question results, six distinct IDs, every result `status: created`, `outcome: created_active`, and `lifecycle: active`. Retain `timezoneBoundaryPrompt`, the five-item `fixturePrompts`, and `isolationProbe` in runner memory.
2. Open `/review`. On its settled fixture load, require `timezoneBoundaryPrompt` visibly first and a queue count of six. This proves every new Active fixture entered immediately and equal unanswered Questions follow stable creation order.
3. Activate `Next question`. Require `fixturePrompts[0]` becomes current, the answer field is empty, the queue count remains six, and no Previous answer was created. Reload `/review` and require `timezoneBoundaryPrompt` is first again, proving Next did not record learning evidence or change the canonical queue order.
4. Open `Local Day settings`. Read the IANA timezone and require it still equals the automatically detected `Intl.DateTimeFormat().resolvedOptions().timeZone` from case 2, proving persistence.
5. Set the timezone to `Pacific/Kiritimati`, save, and reopen settings to require persistence. Through runner-side `issue20DiagnosticRequest(issue20DiagnosticEndpoints.reviewQueue)`, retain the returned `localDay` as `eastDay`; require the boundary Prompt remains visibly current.
6. Answer the boundary Question with the stable Incorrect answer and wait for the visible result `Incorrect`. Require queue count six and `fixturePrompts[0]` current, proving the derived Again moved the boundary Question to the end of the same Local Day.
7. Set the timezone to `Pacific/Pago_Pago` and save. Through `issue20DiagnosticRequest(issue20DiagnosticEndpoints.reviewQueue)` retain `westDay`; require `westDay < eastDay`, the visible queue count drops to five, and `fixturePrompts[0]` remains current. The only membership change is the boundary Question whose `Again` due date is now a future Local Day.
8. Reload `/review`; require the queue remains five with no resume, recovery, rollover, daily-plan, or session prompt.
9. Set the timezone back to `Pacific/Kiritimati`. Require the visible queue count returns to six without a session action, proving the boundary Question re-enters from live Local Day derivation.
10. Set the timezone to `Pacific/Pago_Pago` once more. Require the visible queue returns to five and the setting persists after reopening. Leave this timezone selected so the boundary Question does not interfere with the five-Question grade and Flag journey.

### 5. Generic evaluation, same-day failure, and result correction

1. On `fixturePrompts[0]`, enter the stable Incorrect answer and submit with `ControlOrMeta+Enter`.
2. Wait for evaluation completion. Require the visible result is `Incorrect`, `Answer Standard`, expected answer `browser-smoke-correct-token`, and improvement `Required token was missing`.
3. Require `fixturePrompts[1]` is now current. The failed first Question must have moved behind all remaining Questions rather than creating a delay or retry state.
4. Answer `fixturePrompts[1]` with the stable Correct token. Require the visible result is `Correct`, a visible Answer Standard, a future scheduled Local Day, and `fixturePrompts[2]` current.
5. Answer `fixturePrompts[2]` with the Correct token. In that answer's expanded feedback row, record its future ISO scheduled date.
6. Under `Change evaluation`, choose `Partial`, and require the visible result becomes `Partial` with a same-Local-Day schedule. Choose `Correct`, and require the future schedule returns.
7. Require the original Learner Answer and automated feedback remain visible while the effective result and derived schedule change. Require no Recall Target, Recall Result, Again, Hard, Good, Easy, or numeric score labels appear in the feedback row.
8. Reload `/review`; require the corrected Question remains out of today's queue, its final visible result is `Correct`, and its future schedule reconstructs unchanged.

### 6. Review Flag modal: detailed and empty keyboard submissions

1. Require `fixturePrompts[3]` is current and Review exposes exactly one Library management action: `Flag current Question`.
2. Focus the Flag action and press `Enter`. Require a modal dialog named `Flag this Question`, `aria-modal=true`, initial focus on the first reason badge, multiple clickable reason badges, an optional detail field, and an enabled submit action named `Flag Question` with all fields empty.
3. Press `Escape`; require the modal closes and focus returns to `Flag current Question`. Reopen it by keyboard.
4. Select `Question is unclear` and `Answer standard is wrong` using keyboard input, enter `The stored explanation conflicts with the Prompt.`, and submit by keyboard.
5. Require the modal closes, `fixturePrompts[3]` is removed immediately, `fixturePrompts[4]` becomes current, the queue count decreases, and focus moves to `Your answer`.
6. Change to a 390 × 844 viewport, reload, wait for `fixturePrompts[4]`, and open its Flag modal. Require the full dialog fits within the viewport, can scroll if necessary, and reason badges form one column.
7. Without selecting a badge or entering detail, use `Tab`/`Shift+Tab` to prove focus remains trapped in the modal, reach `Flag Question`, and submit with `Enter`.
8. Require the empty submission succeeds, the modal closes, `fixturePrompts[4]` is immediately absent, `fixturePrompts[0]` returns immediately as the only remaining queued Question, and focus moves to `Your answer`.
9. Submit the Correct token for `fixturePrompts[0]`. Require `Correct`, a future Local Day, and the visible resting state `Your queue is clear.`.
10. In Library's `Flagged` inbox, require both learner-origin Flag records: one with the two selected reasons and exact detail, and one with no reason badges/detail. The earlier Waxon-validation Flag must remain distinct.
11. Capture `/private/tmp/issue-20-clean-break-review-flag-narrow.png` before returning to desktop size.

### 7. Authorized MCP Client credential and canonical semantics

1. At desktop size, open `/library`, activate `Agent access`, and require the endpoint `<tested-origin>/api/mcp` and explanation that the token can search this Library and add validated Questions.
2. Activate `Create token`. Require the one-time copy warning and a visible token beginning `waxon_mcp_`. Capture it only into the Browser runner's in-memory `mcpToken` variable, then close the dialog.
3. Initialize one Streamable HTTP `mcpClient` with the helper, then call `check_questions` with `items: mcpCheckItems` and `limitPerItem: 5`. Require each result echoes its stable `candidateId`; both candidates are `no_close_match` or advisory-only non-exact results before add, and no match may have `exactPrompt: true`.
4. Call `add_questions` with idempotency key `issue-20-native-mcp-add-v1` and `items: mcpAddItems`; require the transmitted add items contain no `candidateId` property. Require:
   - candidate 1: `status: created`, `outcome: created_active`, `lifecycle: active`, no Flags;
   - candidate 2: `status: created`, `outcome: created_flagged`, `lifecycle: flagged`, a `waxon_validation` Flag containing `not_self_contained`.
5. Repeat the identical `mcpAddItems` call with the identical idempotency key. Require the same two Question IDs, `status: existing`, and `outcome: idempotent_replay` for both.
6. Call `add_questions` with the same `mcpAddItems` and idempotency key `issue-20-native-mcp-duplicate-v1`. Require the same IDs, `status: existing`, `outcome: exact_duplicate`, and `answerStandardConflict: false` for both.
7. Call `check_questions` again with `items: mcpCheckItems`. Require both stable `candidateId` values are echoed, `advisory: exact_duplicate` for both, and exact Library matches containing the full stored Answer Standard and lifecycle (`active` and `flagged`).
8. Call `search_questions` for each exact MCP Prompt. Require the matching stored Question ID, full Answer Standard, and lifecycle. Search visibly in Library as well and require the Active and validation-Flagged results appear under their correct filters.
9. Call `search_questions` with no query and limit 50, then with the exact `isolationProbe`. Require neither response contains the known second-Learner Prompt or Question. This is the Authorized MCP Client isolation assertion.
10. Open `Agent access`, require the active-token state, activate `Revoke token`, and require the create-token state returns.
11. Repeat one harmless `search_questions` call with the revoked in-memory token. Require HTTP `401` and no Library data.

### 8. Desktop/narrow responsive and obsolete-control sweep

1. At desktop size, inspect Library and Review accessible controls. At 390 × 844, reload and inspect both routes again after visible content settles.
2. Require navigation, search, lifecycle filters, Question actions, Local Day settings, answer composer, feedback, and Flag dialogs remain contained without horizontal clipping or overlapping actionable controls.
3. On both routes and both viewports, require no visible control/accessibility name containing `Pause`, `Trash`, `capacity`, `retention`, `source`, `generation`, `concept`, `provenance`, `coverage`, or `document` (case-insensitive). Also require no daily-minutes, item-limit, importance, uncertainty, answer-mode, session, retry, or Library action other than Flag in Review.
4. Capture `/private/tmp/issue-20-clean-break-library-narrow.png`, `/private/tmp/issue-20-clean-break-review-desktop.png`, and `/private/tmp/issue-20-clean-break-review-narrow.png`.

### 9. Console and final report

1. Read console messages accumulated across the full journey. Expected framework/development warnings may be reported as non-blocking only when their source and harmlessness are explicit. Any application exception, hydration error, failed request other than the deliberate revoked-token `401`, accessibility error, or unexpected warning fails the relevant case.
2. Update `docs/issue-20-clean-break-evidence.md` with the exact URL; native `iab` confirmation; pass/fail/skipped result for cases 1–9; visible assertions; console findings; commands; screenshot paths; failures; and remaining risks. Never include the MCP token.
