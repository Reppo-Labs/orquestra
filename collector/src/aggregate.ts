// collector/src/aggregate.ts — scheduled Lambda that turns stored reports into the
// published aggregate.
//
// Like ingest.ts this is a shell: the admission threshold lives in src/collector/aggregate.ts
// where it is unit tested. This file scans the window and writes the result.
//
// NOTE the deliberate omission: nothing reads the published aggregate yet. Wiring a
// consumer is a separate, later change, gated on the fleet actually being large enough for
// the threshold to mean something (openspec task 8.5).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { aggregate, type PersistedReport } from '../../src/collector/aggregate.js'
import { WINDOW_DAYS } from '../../src/collector/config.js'

const TABLE = process.env.TABLE_NAME ?? ''
const AGG_TABLE = process.env.AGG_TABLE_NAME ?? TABLE
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}))

/** Scan rows received inside the window.
 *
 *  A Scan, not a Query: the access pattern is "everything recent across all installs",
 *  which has no partition key. Acceptable because TTL keeps the table bounded to
 *  RETENTION_DAYS and the fleet this is built for is small. If the table ever grows past
 *  that assumption, add a GSI on a coarse time bucket rather than raising the scan limit. */
async function scanWindow(nowMs: number): Promise<PersistedReport[]> {
  const since = new Date(nowMs - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const items: PersistedReport[] = []
  let key: Record<string, unknown> | undefined

  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: 'sk >= :since',
        ExpressionAttributeValues: { ':since': since },
        ExclusiveStartKey: key,
      }),
    )
    for (const i of res.Items ?? []) items.push(i as unknown as PersistedReport)
    key = res.LastEvaluatedKey
  } while (key !== undefined)

  return items
}

export async function handler(): Promise<void> {
  const nowMs = Date.now()
  const reports = await scanWindow(nowMs)
  const result = aggregate(reports, { now: nowMs })

  // Single current-aggregate row, overwritten each run. History is not kept: an aggregate
  // is a view over raw rows that expire, so retaining derived history indefinitely would
  // quietly outlive the retention promise made to operators.
  await ddb.send(
    new PutCommand({
      TableName: AGG_TABLE,
      Item: {
        pk: 'AGGREGATE',
        sk: 'current',
        computedAt: new Date(nowMs).toISOString(),
        ...result,
      },
    }),
  )

  console.log(
    `aggregate: ${result.fleet.installs} installs, ${result.signals.length} signals admitted, ` +
      `${result.withheld} withheld below threshold ${result.minDistinctInstalls}`,
  )
}
