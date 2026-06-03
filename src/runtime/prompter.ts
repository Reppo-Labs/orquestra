// src/runtime/prompter.ts
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import type { Prompter } from '../onboarding/types.js'

/** Interactive terminal Prompter. Honors the Prompter contract: a blank answer
 *  returns the provided default. */
export function terminalPrompter(): Prompter & { close(): void } {
  const rl = createInterface({ input: stdin, output: stdout })
  // readline intercepts SIGINT during a prompt; without this, Ctrl-C mid-onboarding
  // is swallowed and the process hangs. Close + exit (130 = terminated by SIGINT).
  rl.on('SIGINT', () => {
    rl.close()
    process.exit(130)
  })
  return {
    async ask(question: string, def?: string): Promise<string> {
      const suffix = def !== undefined && def !== '' ? ` [${def}]` : ''
      const answer = (await rl.question(`${question}${suffix} `)).trim()
      return answer === '' ? (def ?? '') : answer
    },
    info(message: string): void {
      stdout.write(`${message}\n`)
    },
    close(): void {
      rl.close()
    },
  }
}
