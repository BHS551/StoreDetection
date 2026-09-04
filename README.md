# StoreDetection

The AWS Lambda that records a detection event for
[SkyEye](https://www.skyeyeprotection.com/).

When a detection worker confirms something worth alerting on, it calls this
endpoint. The function verifies the caller's Firebase token, stamps the event
with an owner and an expiry, and writes it to DynamoDB. It is deliberately one
job: the write path for detections.

## The problem it solves

A write endpoint that sits between untrusted callers and a shared table has to
answer three questions, and it is easier to get them wrong than right:

1. **Who is asking?** Detection events are private security footage metadata.
   An unauthenticated write endpoint is an open door into other people's feeds.
2. **How does anything ever get deleted?** A camera that alerts a few times an
   hour writes tens of thousands of rows a year. Without a retention rule the
   table grows forever and someone pays for it forever.
3. **What ends up in the logs?** The obvious debugging line —
   `console.log(event)` — writes the caller's `Authorization` header into
   CloudWatch, where it outlives the token.

## How it works

```
Worker / console
   │  POST  Authorization: Bearer <Firebase ID token>
   │        { detection payload }
   ▼
CORS check ──► origin echoed only if allow-listed
   │
   ▼
verifyIdToken()  (firebase-admin; service account from Secrets Manager)
   │  401 on failure
   ▼
build item: type=event · id=<ISO timestamp>-<random>
            created_at · owner_uid · raw · expireAt (now + 30d)
   │
   ▼
DynamoDB PutItem → `detections`
   │
   ▼
200 { ok: true, id }
```

The table is shared with camera records, discriminated by a `type` attribute
(`event` here, `device` in
[StoreDevice](https://github.com/BHS551/StoreDevice)). Reads go through
[ListDetections](https://github.com/BHS551/ListDetections), which queries an
`owner-index` GSI so a user's events are isolated by the key itself rather than
by a filter applied after the fact.

## Key technical decisions

**Only events expire.** `expireAt` is a Unix timestamp 30 days out, and DynamoDB
TTL deletes the row when it passes. Device records in the same table carry no
`expireAt`, so they never expire despite sharing the table — the retention rule
is attached to the row, not the table. Frames in S3 expire on a shorter,
separate schedule, so the metadata outlives the image.

**Sortable ids, no extra round trip.** The id is an ISO-8601 timestamp with a
short random suffix, generated in the function. It sorts chronologically as a
string and collides only within the same millisecond, so there is no sequence
table and no read before the write.

**The raw payload is stored verbatim.** The original request body is kept in a
`raw` attribute alongside the extracted fields. Detection payloads change shape
as the workers evolve; keeping the original means an old event can still be
re-read correctly after the schema moves on.

**The event is never logged.** There is no `console.log(event)` anywhere in the
handler, and the comment in the source says why: the event carries the
`Authorization` header and the body carries user data. Errors log
`err.message` only.

**Auth failures are distinguished from everything else.** Only errors whose
`code` starts with `auth/` — that is, from firebase-admin — return 401. An AWS
SDK credentials error is a 500, because it is the service that is broken, not
the caller's session.

**A malformed body does not fail the write.** JSON parse errors are logged and
the raw text is stored anyway. A detection is a security event; recording it
imperfectly beats dropping it because a field was wrong.

**CORS is an allow-list, not `*`.** The request origin is echoed only if it
matches `ALLOWED_ORIGINS`, a Vercel preview domain, or localhost.

## API

```http
POST /
Authorization: Bearer <Firebase ID token>
Content-Type: application/json

{ "camera": "entrance", "label": "caidas", "score": 0.31, "detection_id": "…" }
```

```
200 { "ok": true, "id": "2026-08-05T12:31:44.201Z-a91f3d" }
401 { "message": "Unauthorized: missing token" }
500 { "message": "Error saving detection", "error": "…" }
```

`OPTIONS` returns 200 with the CORS headers.

## Deploying

Node.js 18+ on AWS Lambda, behind API Gateway, handler `index.mjs`.

```bash
npm install firebase-admin @aws-sdk/client-dynamodb @aws-sdk/client-secrets-manager
zip -r function.zip . && aws lambda update-function-code \
  --function-name storeDetection --zip-file fileb://function.zip
```

Requires a DynamoDB table `detections` with TTL enabled on `expireAt` and an
`owner-index` GSI on `owner_uid`, plus a Firebase service account in Secrets
Manager. The execution role needs `dynamodb:PutItem` on the table and
`secretsmanager:GetSecretValue` on the secret.

| Variable | Default | Meaning |
|---|---|---|
| `FIREBASE_SECRET_ID` | `heimdall/firebase` | Service account secret id |
| `ALLOWED_ORIGINS` | — | Comma-separated CORS allow-list |
| `AWS_REGION` | `us-east-1` | Region for Secrets Manager |

Environment variables `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and
`FIREBASE_PRIVATE_KEY` are read only if the secret cannot be fetched, so a
rollback to the previous configuration is possible without a code change.
