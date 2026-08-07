// collector/cdk/stack.ts — the telemetry collector's infrastructure.
//
// Shape: API Gateway HTTP API -> ingest Lambda -> DynamoDB (TTL), plus a scheduled
// aggregation Lambda. See ../README.md for why this shape, and design.md in the OpenSpec
// change for why DynamoDB rather than Postgres (retention as a table property, not a cron).
import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as logs from 'aws-cdk-lib/aws-logs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export class TelemetryCollectorStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    // ── Storage ──────────────────────────────────────────────────────────────────────
    // pk = installId, sk = receivedAt (ISO). That pair supports the only two access
    // patterns: "recent reports for this install" (the per-install rate limit) and a
    // windowed scan for aggregation.
    //
    // timeToLiveAttribute is the load-bearing line in this file. Retention is promised to
    // operators in docs/telemetry.md; making it a table property means the promise does
    // not depend on a scheduled delete continuing to succeed.
    const reports = new dynamodb.Table(this, 'Reports', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Telemetry is reconstructible by definition — nodes send fresh counts every cycle —
      // and a retained orphan table would outlive the retention promise.
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
    })

    /** Lambda log group with a bounded retention of its own.
     *
     *  Log retention is not incidental here: handler logs record reject reasons and
     *  install ids, so an unbounded log group would quietly retain report-derived data
     *  long after the TTL deleted the reports themselves — defeating the retention
     *  promise through the back door. */
    const logGroupFor = (id: string) =>
      new logs.LogGroup(this, `${id}Logs`, {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      })

    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      environment: { TABLE_NAME: reports.tableName },
      bundling: { format: OutputFormat.ESM, target: 'node22', minify: false },
    }

    // ── Ingest ───────────────────────────────────────────────────────────────────────
    const ingest = new NodejsFunction(this, 'Ingest', {
      ...common,
      entry: join(HERE, '..', 'src', 'ingest.ts'),
      handler: 'handler',
      // Short: the sender gives up after 5s and never retries, so a longer timeout only
      // buys billed time for a response nobody will receive.
      timeout: Duration.seconds(10),
      memorySize: 256,
      logGroup: logGroupFor('Ingest'),
      description: 'Accepts operator telemetry reports. Unauthenticated by design.',
    })
    // Least privilege: ingest writes rows and reads only its own install's recent keys.
    reports.grantWriteData(ingest)
    reports.grantReadData(ingest)

    const api = new apigw.HttpApi(this, 'Api', {
      description: 'Orquestra operator telemetry ingest',
      createDefaultStage: false,
    })

    api.addRoutes({
      path: '/v1/reports',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('IngestIntegration', ingest),
    })

    // Stage-level throttling is the per-SOURCE rate limit (specs/telemetry-ingest); the
    // per-INSTALL limit lives in the handler. Two layers, different attackers: this one
    // caps volumetric floods, the handler's caps how much weight any single install id can
    // carry toward the admission threshold.
    new apigw.HttpStage(this, 'V1Stage', {
      httpApi: api,
      stageName: 'v1',
      autoDeploy: true,
      throttle: { rateLimit: 50, burstLimit: 100 },
    })

    // ── Aggregation ──────────────────────────────────────────────────────────────────
    const aggregate = new NodejsFunction(this, 'Aggregate', {
      ...common,
      entry: join(HERE, '..', 'src', 'aggregate.ts'),
      handler: 'handler',
      timeout: Duration.minutes(2),
      memorySize: 512,
      logGroup: logGroupFor('Aggregate'),
      description: 'Applies the distinct-install admission threshold and publishes the aggregate.',
    })
    reports.grantReadWriteData(aggregate)

    // Hourly is ample: the consumer is a twice-daily job, and a fresher aggregate would
    // only add scan cost without changing any decision.
    new events.Rule(this, 'AggregateSchedule', {
      schedule: events.Schedule.rate(Duration.hours(1)),
      targets: [new targets.LambdaFunction(aggregate)],
    })

    new CfnOutput(this, 'EndpointUrl', {
      value: `${api.apiEndpoint}/v1/reports`,
      description: 'Set this as ORQUESTRA_TELEMETRY_ENDPOINT on nodes',
    })
    new CfnOutput(this, 'TableName', { value: reports.tableName })
  }
}
