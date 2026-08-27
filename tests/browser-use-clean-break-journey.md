# Issue 20 clean-break learner journey

This is the source of truth for the final native-browser acceptance run for GitHub issue #20. Run every case with the project-level `run-browser-use-suite` skill and the native Codex Desktop in-app Browser (`iab`). Do not substitute standalone Playwright, another browser, Computer Use, or API-only evidence.

## Result policy

- Record every numbered case as `pass`, `fail`, or `skipped`. A skipped required case does not satisfy #20.
- Use visible UI interaction for learner behavior. Page-context requests are allowed only for the fixture seed, identity capture, and the MCP service calls that have no browser UI.
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
Original Answer Standard: The original Question keeps its Learning Evidence.
Replacement Answer Standard: Replacement creates a new Active Question with reset mastery while the original is Archived.
```

Validation-Flagged Question:

```text
Prompt: What does the content provided above mean?
Answer Standard: It describes the accepted clean-break learner journey.
```

Deterministic Review answer:

```text
Correct: browser-smoke-correct-token
Incorrect: This answer deliberately omits the required token.
```

MCP candidates:

```json
[
  {
    "prompt": "Issue 20 MCP journey: what proves canonical add semantics?",
    "referenceAnswer": "The same isolated Question application service."
  },
  {
    "prompt": "Which fact was mentioned above?",
    "referenceAnswer": "The fact belongs to a missing external context."
  }
]
```

The known second-Learner probe is:

```text
Issue 20 isolation probe: which Question belongs only to the other Learner?
```

## MCP Streamable HTTP helper

Keep the token and optional MCP session ID only in the Browser runner's in-memory variables. Do not write either to storage, a file, console output, screenshots, or the evidence report. Use same-origin page-context `fetch` with `POST /api/mcp`, `Authorization: Bearer …`, `Content-Type: application/json`, and `Accept: application/json, text/event-stream` on every request. Parse either a JSON response or server-sent `data:` lines.

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
  const response = await fetch("/api/mcp", {
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

Create one `mcpClient` with `await issue20McpInitialize(mcpToken)`. For successful tool calls require HTTP `200`, no JSON-RPC error, and use `envelope.result.structuredContent` for the assertions below. Use monotonically increasing request IDs. After revocation, reuse the same client state and require `401` before any MCP envelope or bank data is returned.

## Acceptance journey

### 1. Identity, private Question Bank, and initial legacy-control absence

1. Open the printed URL at `/library` in `iab` at a desktop viewport of at least 1280 × 800.
2. Require the visible isolated identity `Issue 20 browser learner` and `issue-20-browser@waxon.invalid`, the `Question Bank` tab, the `Review` tab, and the empty-bank state. If the bank is not empty on the freshly reset disposable database, stop and report the mismatch.
3. Inspect visible controls and accessible names. Require no control named or containing `Pause`, `Trash`, `capacity`, `retention`, `source`, `generation`, `concept`, `provenance`, `coverage`, or `document` (case-insensitive). Also require no daily-minutes, item-limit, importance, uncertainty, or answer-mode control.
4. Capture `/private/tmp/issue-20-clean-break-library-desktop.png`.

### 2. Add, search, immutable replace, Archive, and restore

1. Activate `Add question`, enter the exact Library Prompt and Original Answer Standard, and submit `Add to bank`.
2. Require the visible status `Active Question added to your bank.`, an `Active` lifecycle badge, and the exact Prompt. Search for `replacement immutable` and require exactly the suite Question.
3. Through same-origin `GET /api/v2/library?search=replacement%20immutable`, record the Active Question ID as `originalId`; do not treat this request as a replacement for the visible search assertion.
4. Activate `Replace question`. Require a modal named `Replace question` and the visible warning that replacement creates a new Active Question with reset mastery and archives the original with its Learning Evidence intact.
5. Keep the Prompt unchanged, replace only the Answer Standard with the exact Replacement Answer Standard, and submit `Replace question`.
6. Require the visible status `Active replacement added. The original Question was archived.`. Through the same-origin Library GET, require one Active and one Archived result with the same Prompt, different IDs, `originalId` on the Archived result, the original Answer Standard unchanged, and the replacement Answer Standard on the new Active result.
7. Select the `Archived` filter. Require only lifecycle badges `Archived`; expand both Answer Standards and visibly distinguish the immutable original from its replacement.
8. Select `Active`, scope the action to the replacement row, and activate `Archive question`. Require `Question archived.` and no Active result for the Prompt.
9. Select `Archived`, scope the row by the Replacement Answer Standard, activate `Restore question`, and require `Question restored.` with that same Question ID Active through the Library GET.
10. Archive the restored replacement once more so no suite-created Active Question remains before Review fixture seeding. The two immutable identities must remain Archived.

### 3. Validation Flagging and the Flagged attention inbox

1. Clear search and activate `Add question`. Add the exact Validation-Flagged Prompt and Answer Standard.
2. Require `Question saved to Flagged for attention.` and no Active lifecycle result for that Prompt.
3. Select the `Flagged` filter. Require the visible region `Flagged Question attention inbox`, `Attention inbox`, the exact Prompt, lifecycle `Flagged`, origin `Waxon validation`, and reason `Not self-contained`.
4. Require Archive, restore, and replace actions on the Flagged Question. Leave it Flagged.

### 4. Seed and prove the deterministic live Review Queue and Local Day

1. From the `/library` page, issue same-origin `POST /api/test-support/browser-smoke` with no body. Require HTTP `200`, `ok: true`, six Question results, six distinct IDs, every result `status: created`, `outcome: created_active`, and `lifecycle: active`. Retain `timezoneBoundaryPrompt`, the five-item `fixturePrompts`, and `isolationProbe` in Browser-runner memory.
2. Open `/review`. On its first settled load, require `timezoneBoundaryPrompt` visibly first and a queue count of six. This proves every new Active fixture entered immediately and equal unanswered Questions follow stable creation order.
3. Open `Local Day settings`. Read the IANA timezone and require it equals `Intl.DateTimeFormat().resolvedOptions().timeZone`, proving automatic detection was persisted.
4. Set the timezone to `Pacific/Kiritimati`, save, and reopen settings to require persistence. Through same-origin `GET /api/v2/review/queue`, retain the returned `localDay` as `eastDay`; require the boundary Prompt remains visibly current.
5. Answer the boundary Question with the stable Incorrect answer and wait for `Again`. Require queue count six and `fixturePrompts[0]` current, proving the boundary Question moved to the end of the same Local Day.
6. Set the timezone to `Pacific/Pago_Pago` and save. Through the queue GET retain `westDay`; require `westDay < eastDay`, the visible queue count drops to five, and `fixturePrompts[0]` remains current. The only membership change is the boundary Question whose `Again` due date is now a future Local Day.
7. Reload `/review`; require the queue remains five with no resume, recovery, rollover, daily-plan, or session prompt.
8. Set the timezone back to `Pacific/Kiritimati`. Require the visible queue count returns to six without a session action, proving the boundary Question re-enters from live Local Day derivation.
9. Set the timezone to `Pacific/Pago_Pago` once more. Require the visible queue returns to five and the setting persists after reopening. Leave this timezone selected so the boundary Question does not interfere with the five-Question grade and Flag journey.

### 5. Generic evaluation, Again ordering, all four Answer Grades, and correction

1. On `fixturePrompts[0]`, enter the stable Incorrect answer and submit with `ControlOrMeta+Enter`.
2. Wait for evaluation completion. Require visible grade `Again`, `Answer Standard`, `Demonstrated Gap`, expected answer `browser-smoke-correct-token`, missing point `Required token`, and gap `Required token was missing.`.
3. Require `fixturePrompts[1]` is now current. The failed first Question must have moved behind all remaining Questions rather than creating a delay or retry state.
4. Answer `fixturePrompts[1]` with the stable Correct token. Require grade `Good`, visible expected Answer Standard and Demonstrated Gap, a future `Scheduled` Local Day, and `fixturePrompts[2]` current.
5. Answer `fixturePrompts[2]` with the Correct token. In that answer's expanded feedback row, record the ISO scheduled date for `Good`.
6. Under `Correct Answer Grade`, activate `Hard (2)`. Require `Hard` is pressed/effective and record its ISO scheduled date. Then activate `Good (3)` and record the restored Good date. Then activate `Easy (4)` and record its ISO scheduled date.
7. Require `hardDate < goodDate < easyDate`. Require the original Learner Answer and evaluator feedback remain visible while only the effective Answer Grade and schedule change.
8. Reload `/review`; require the corrected Question remains out of today's queue, its final effective grade is `Easy`, and its future schedule reconstructs unchanged.

### 6. Review Flag modal: detailed and empty keyboard submissions

1. Require `fixturePrompts[3]` is current and Review exposes exactly one Question Bank management action: `Flag current Question`.
2. Focus the Flag action and press `Enter`. Require a modal dialog named `Flag Question`, `aria-modal=true`, initial focus on the first reason badge, multiple clickable reason badges, an optional detail field, and an enabled submit action with all fields empty.
3. Press `Escape`; require the modal closes and focus returns to `Flag current Question`. Reopen it by keyboard.
4. Select `Prompt is unclear` and `Answer standard is incorrect` using keyboard input, enter `The stored explanation conflicts with the Prompt.`, and submit by keyboard.
5. Require the modal closes, `fixturePrompts[3]` is removed immediately, `fixturePrompts[4]` becomes current, the queue count decreases, and focus moves to `Your answer`.
6. Change to a 390 × 844 viewport, reload, wait for `fixturePrompts[4]`, and open its Flag modal. Require the full dialog fits within the viewport, can scroll if necessary, and reason badges form one column.
7. Without selecting a badge or entering detail, use `Tab`/`Shift+Tab` to prove focus remains trapped in the modal, reach `Flag Question`, and submit with `Enter`.
8. Require the empty submission succeeds, the modal closes, `fixturePrompts[4]` is immediately absent, `fixturePrompts[0]` returns immediately as the only remaining queued Question, and focus moves to `Your answer`.
9. Submit the Correct token for `fixturePrompts[0]`. Require `Good`, a future Local Day, and the visible resting state `Your queue is clear.`.
10. In Question Bank's `Flagged` inbox, require both learner-origin Flag records: one with the two selected reasons and exact detail, and one with no reason badges/detail. The earlier Waxon-validation Flag must remain distinct.
11. Capture `/private/tmp/issue-20-clean-break-review-flag-narrow.png` before returning to desktop size.

### 7. Authorized MCP Client credential and canonical semantics

1. At desktop size, open `/library`, activate `Agent access`, and require the endpoint `<tested-origin>/api/mcp` and explanation that the token can search this bank and add validated Questions.
2. Activate `Create token`. Require the one-time copy warning and a visible token beginning `waxon_mcp_`. Capture it only into the Browser runner's in-memory `mcpToken` variable, then close the dialog.
3. Initialize one Streamable HTTP `mcpClient` with the helper, then call `check_questions` with the two exact MCP candidates and `limitPerItem: 5`. Require both candidates are `no_close_match` or advisory-only non-exact results before add; no match may have `exactPrompt: true`.
4. Call `add_questions` with idempotency key `issue-20-native-mcp-add-v1` and the two candidates. Require:
   - candidate 1: `status: created`, `outcome: created_active`, `lifecycle: active`, no Flags;
   - candidate 2: `status: created`, `outcome: created_flagged`, `lifecycle: flagged`, a `waxon_validation` Flag containing `not_self_contained`.
5. Repeat the identical call with the identical idempotency key. Require the same two Question IDs, `status: existing`, and `outcome: idempotent_replay` for both.
6. Call the identical candidates with idempotency key `issue-20-native-mcp-duplicate-v1`. Require the same IDs, `status: existing`, `outcome: exact_duplicate`, and `answerStandardConflict: false` for both.
7. Call `check_questions` again. Require `advisory: exact_duplicate` for both and exact bank matches containing the full stored Answer Standard and lifecycle (`active` and `flagged`).
8. Call `search_questions` for each exact MCP Prompt. Require the matching stored Question ID, full Answer Standard, and lifecycle. Search visibly in Question Bank as well and require the Active and validation-Flagged results appear under their correct filters.
9. Call `search_questions` with no query and limit 50, then with the exact `isolationProbe`. Require neither response contains the known second-Learner Prompt or Question. This is the Authorized MCP Client isolation assertion.
10. Open `Agent access`, require the active-token state, activate `Revoke token`, and require the create-token state returns.
11. Repeat one harmless `search_questions` call with the revoked in-memory token. Require HTTP `401` and no bank data.

### 8. Desktop/narrow responsive and obsolete-control sweep

1. At desktop size, inspect Question Bank and Review accessible controls. At 390 × 844, reload and inspect both routes again after visible content settles.
2. Require navigation, search, lifecycle filters, Question actions, Local Day settings, answer composer, feedback, and Flag dialogs remain contained without horizontal clipping or overlapping actionable controls.
3. On both routes and both viewports, require no visible control/accessibility name containing `Pause`, `Trash`, `capacity`, `retention`, `source`, `generation`, `concept`, `provenance`, `coverage`, or `document` (case-insensitive). Also require no daily-minutes, item-limit, importance, uncertainty, answer-mode, skip, session, retry, or Question Bank action other than Flag in Review.
4. Capture `/private/tmp/issue-20-clean-break-library-narrow.png`, `/private/tmp/issue-20-clean-break-review-desktop.png`, and `/private/tmp/issue-20-clean-break-review-narrow.png`.

### 9. Console and final report

1. Read console messages accumulated across the full journey. Expected framework/development warnings may be reported as non-blocking only when their source and harmlessness are explicit. Any application exception, hydration error, failed request other than the deliberate revoked-token `401`, accessibility error, or unexpected warning fails the relevant case.
2. Update `docs/issue-20-clean-break-evidence.md` with the exact URL; native `iab` confirmation; pass/fail/skipped result for cases 1–9; visible assertions; console findings; commands; screenshot paths; failures; and remaining risks. Never include the MCP token.
