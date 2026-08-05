#!/usr/bin/env node
// collector/cdk/app.ts — CDK entry point.
import { App } from 'aws-cdk-lib'
import { TelemetryCollectorStack } from './stack.js'

const app = new App()

new TelemetryCollectorStack(app, 'OrquestraTelemetryCollector', {
  // Account/region come from the deploying profile (CDK_DEFAULT_*), so the stack is not
  // pinned to one account in source.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  description: 'Orquestra operator telemetry: ingest, retention, and admission threshold.',
})
