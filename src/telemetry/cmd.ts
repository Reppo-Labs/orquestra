// src/telemetry/cmd.ts — `orquestra telemetry [--show|--off|--on]`.
//
// Under a default-on design this command IS the privacy guarantee. An operator who is
// never asked to consent has only one way to check what leaves their machine: run
// `--show` and read it. So `--show` prints the exact bytes the sender transmits
// (serializePayload, the same function) rather than a rendered summary — a summary is a
// second implementation that can drift from the first, and a drifted summary is worse
// than none because it manufactures false confidence.
//
// No subcommand here ever transmits. `--show` in particular must not, or an operator
// inspecting the payload before deciding would be sending it by inspecting it.
import { buildPayload, serializePayload } from './payload.js'
import {
  isDisabledByEnv,
  isTelemetryEnabled,
  needsNotice,
  setTelemetryEnabled,
  OPT_OUT_ENV,
} from './consent.js'
import { noticeText, RETENTION_DAYS } from './notice.js'

export interface TelemetryCmdIo {
  out: (s: string) => void
  err: (s: string) => void
}

const defaultIo: TelemetryCmdIo = { out: console.log, err: console.error }

function statusLines(dataDir: string, env: NodeJS.ProcessEnv): string[] {
  const enabled = isTelemetryEnabled(dataDir, env)
  const lines = [`telemetry: ${enabled ? 'enabled' : 'disabled'}`]
  if (isDisabledByEnv(env)) {
    // Distinguish the two ways to be off — an operator who set the env var in one shell
    // and forgot would otherwise think they had disabled it permanently.
    lines.push(`  (disabled by ${OPT_OUT_ENV}; the stored setting is unchanged)`)
  }
  if (needsNotice(dataDir)) {
    lines.push('  (the notice has not been shown yet — nothing has been transmitted)')
  }
  lines.push(`  retention: ${RETENTION_DAYS} days`)
  lines.push('  orquestra telemetry --show   see the exact payload')
  lines.push('  orquestra telemetry --off    disable permanently')
  return lines
}

/** Run the subcommand. Returns the process exit code. Pure w.r.t. the network: no branch
 *  of this function transmits anything. */
export function telemetryCmd(
  dataDir: string,
  argv: string[],
  io: TelemetryCmdIo = defaultIo,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const flag = argv[0]

  if (flag === '--show') {
    // Deliberately the same serializer the sender uses. Do not "pretty print" here.
    io.out(serializePayload(buildPayload(dataDir)))
    return 0
  }

  if (flag === '--off') {
    setTelemetryEnabled(dataDir, false)
    io.err('orquestra: telemetry disabled. Nothing further will be transmitted.')
    return 0
  }

  if (flag === '--on') {
    setTelemetryEnabled(dataDir, true)
    io.err('orquestra: telemetry enabled.')
    io.err(noticeText())
    return 0
  }

  if (flag === undefined) {
    for (const l of statusLines(dataDir, env)) io.err(l)
    return 0
  }

  io.err(`usage: orquestra telemetry [--show|--on|--off]  (unknown option: ${flag})`)
  return 2
}
