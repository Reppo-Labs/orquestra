// collector/src/ingest.ts — Lambda entry point for POST /v1/reports.
//
// A shell, deliberately. Every decision (what is valid, what is rate limited, what TTL to
// stamp) lives in src/collector/ where the node's own test suite covers it. This file only
// translates between an API Gateway event and that decision.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { handleIngest } from '../../src/collector/handler.js'
import { validateReport } from '../../src/collector/validate.js'

const TABLE = process.env.TABLE_NAME ?? ''
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

const HOUR_MS = 60 * 60 * 1000

/** Trailing-hour accepted-report times for one install, for the per-install rate limit.
 *  Best-effort: a failed lookup returns no history, so the request is judged on the
 *  gateway's per-source throttle alone rather than being rejected. Failing closed here
 *  would turn a DynamoDB blip into a fleet-wide telemetry outage, and telemetry is not
 *  important enough to fail anyone's cycle over. */
async function recentFor(installId: string, nowMs: number): Promise<number[]> {
  try {
    const since = new Date(nowMs - HOUR_MS).toISOString()
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :pk AND sk >= :since',
        ExpressionAttributeValues: { ':pk': installId, ':since': since },
        ProjectionExpression: 'sk',
        Limit: 64,
      }),
    )
    return (res.Items ?? [])
      .map((i: Record<string, unknown>) => Date.parse(String(i.sk)))
      .filter((n: number) => !Number.isNaN(n))
  } catch {
    return []
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const nowMs = Date.now()
  const body = event.body ?? ''

  // Peek at the install id only to scope the rate-limit lookup. The authoritative
  // validation still happens inside handleIngest — this must not become a second,
  // divergent validation path.
  const peek = validateReport(body)
  const activity = peek.ok ? { recentMs: await recentFor(peek.report.installId, nowMs) } : { recentMs: [] }

  const result = handleIngest({ body, activity, nowMs })

  if (result.store !== undefined) {
    const row = result.store
    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          // Written field by field rather than spreading `row`. A spread would set
          // `expiresAt` twice (once explicitly, once from the spread) and silently depend
          // on key order — reorder the literal and the TTL attribute changes meaning or
          // vanishes, which fails open into indefinite retention.
          Item: {
            pk: row.installId,
            sk: row.receivedAt,
            expiresAt: row.expiresAt, // TTL attribute — epoch SECONDS, never ms
            schemaVersion: row.schemaVersion,
            ts: row.ts,
            installId: row.installId,
            orquestraVersion: row.orquestraVersion,
            nodeVersion: row.nodeVersion,
            platform: row.platform,
            arch: row.arch,
            counts: row.counts,
            errorSignatures: row.errorSignatures,
            receivedAt: row.receivedAt,
          },
        }),
      )
    } catch (e) {
      // Report lost. Acceptable by design: delivery is best-effort and the admission
      // threshold already assumes loss. Log for our own metrics, still return 202 — the
      // sender cannot act on a failure and telling it invites a retry we do not want.
      console.error('ingest: put failed', (e as Error).name)
    }
  }

  // Reject reasons stay in our logs, never in the response: a precise error is a free
  // oracle for probing what the collector accepts.
  if (result.rejectReason !== undefined) {
    console.warn('ingest: rejected', result.rejectReason)
  }

  return {
    statusCode: result.status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result.body),
  }
}
