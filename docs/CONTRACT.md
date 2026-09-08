# API & SSE Contract

Version: 1 (initial). Public API and SSE event changes require a version
bump here plus a compatibility decision (additive vs. breaking), per
CLAUDE.md non-negotiable #11.

## `GET /health`

Always `200 { "status": "ok" }` while the Fastify process is up.

## `GET /ready`

`200 { "ready": true, "db": true, "engine": true }` when SQLite is
reachable and the local engine reports ready.
`503` with the same shape (`ready: false`) otherwise.

## `POST /generate`

Headers: `Idempotency-Key: <string>` (required).
Body:

```json
{ "prompt": "string, 1..MAX_PROMPT_LENGTH chars", "model": "string, optional", "maxTokens": "int, optional, <= MAX_TOKENS_LIMIT" }
```

Response: `text/event-stream`. Frames are standard SSE (`event: <name>\ndata: <json>\n\n`).

| event          | data shape                                                       |
|----------------|-------------------------------------------------------------------|
| `run.created`  | full run object, `status: "queued"`                              |
| `run.status`   | full run object, `status: "running"`                              |
| `token`        | `{ "runId": string, "token": string, "index": number }`           |
| `run.completed`| full run object, `status: "completed"`                            |
| `run.cancelled`| full run object, `status: "cancelled"`                             |
| `run.failed`   | full run object, `status: "failed"`, `errorMessage` set            |

A retried request with a previously-used `Idempotency-Key` on this route
does not start a second generation. It replays `run.created` followed by
the run's current stored status as a single snapshot, then closes the
stream — it does not re-attach live token-by-token output to a second
connection.

Run object shape:

```json
{
  "id": "uuid",
  "status": "queued|running|completed|cancelled|failed",
  "model": "string",
  "prompt": "string",
  "maxTokens": "number",
  "output": "string",
  "tokenCount": "number",
  "errorMessage": "string|null",
  "version": "number",
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601",
  "startedAt": "ISO 8601|null",
  "finishedAt": "ISO 8601|null",
  "durationMs": "number|null"
}
```

Disconnecting the HTTP connection before a terminal event aborts the
upstream engine call and the run transitions to `cancelled` (or `failed`
if the abort raced a genuine engine error) — it is never left `running`
with no one watching it.

## `GET /runs`

Query: `limit` (1-200, default 50), `offset` (>=0, default 0).
Response: `{ "runs": [Run], "limit": number, "offset": number }`.

## `GET /runs/:id`

`200` with a Run object, or `404 { "error": "RUN_NOT_FOUND" }`.

## `POST /runs/:id/cancel`

Headers: `Idempotency-Key: <string>` (required for contract consistency
with every other mutation route; cancellation itself is idempotent by
construction, so no dedupe store backs this one — see
`src/routes/runs.ts`).

Response: `200 { "runId": string, "cancelRequested": boolean, "status": string }`.
`cancelRequested` is `false` when the run was already terminal or not
found in the in-process generation registry (e.g. the process restarted).

## Error shape

Every non-2xx JSON response is `{ "error": "<CODE>", "message": "<string>" }`.
Validation failures are always `400 VALIDATION_FAILED`.
