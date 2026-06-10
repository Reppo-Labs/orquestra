# Public Release Checklist

Gate before flipping the repo to public. Items marked **[you]** need a human to
run (destructive or external); the rest are verified in-repo.

## Secret exposure — assessed

A full-history scan was run (`git log -p --all`) for credential shapes:

- **Live Alchemy RPC key** (`xonK3…`): **not in history.** It only ever lived in
  the untracked `activity-log.jsonl` and in `.env` — neither was ever committed
  (verified: `git ls-files .env` empty, `git log -- .env` empty).
- **No** private keys, bearer tokens, or `inf_`/`acp_` API keys in any commit.
- The only `alchemy.com/v2/<key>`-shaped string in history is a **synthetic test
  fixture** (`abcDEF123xyz4567890key` in `src/util/redact.test.ts`).

**Conclusion:** no live secret is in git history. A history rewrite is **not
required for secret removal.**

## Operational data in history

Four live-node files were tracked in early commits and untracked in `8660ad9`:
`orquestra-data/{budget-ledger,vote-state,strategy.config}.json` and
`strategy-notes.md`. These contain no secrets but do reveal the operator's
strategy, balances, and notes.

- **[you] Decide:** acceptable to leave in history, or scrub?
  - **Recommended for a clean public launch:** publish from a **fresh-history
    mirror** — simplest, loses nothing a new audience needs:
    ```sh
    # in a scratch dir
    git clone --no-local /Users/anajuliabittencourt/code/orquestra orquestra-public
    cd orquestra-public
    rm -rf .git && git init && git add -A
    git commit -m "Initial public release"
    git remote add origin <new-public-remote>
    git push -u origin main
    ```
  - Alternative (preserve history, scrub files): `git filter-repo
    --path orquestra-data --invert-paths` then force-push. Heavier; only if the
    commit history itself has value to publish.

## Pre-flip verification — done

- [x] `.gitignore` ignores `orquestra-data/`, `.env*`, `*.key`, screenshots,
      `.playwright-mcp/`
- [x] `LICENSE` present (MIT)
- [x] `README.md` has full operator setup (env, build, docker run, dashboard)
- [x] `.env.example` documents every variable; no real values
- [x] CI runs typecheck + tests + build on push/PR (`.github/workflows/ci.yml`)
- [x] All secrets redacted at the exec boundary and on activity-log read/write
- [x] `npm test` green (326), `npm run typecheck` clean, `npm run build` clean

## [you] Key rotation — do regardless

The live Alchemy key sat in the running node's plaintext `activity-log.jsonl`
(local disk) and `.env`. Even though it's not in git, rotate it as hygiene before
going public, since the node and its logs may be shared or screenshotted:

- [ ] **[you]** Rotate the Alchemy API key in the Alchemy dashboard; update `.env`
      (`RPC_URL`) and restart the node.
- [ ] **[you]** Confirm no screenshot/log you've shared externally contains the
      old key.

## [you] Final flip

- [ ] **[you]** Merge the open PRs (orquestra remediation + reppo-cli #47).
- [ ] **[you]** Run the secret scan once more on the exact commit you publish:
      `git log -p --all | grep -nE '0x[0-9a-f]{64}|alchemy\.com/v2/[A-Za-z0-9_-]{24,}|inf_|acp_|Bearer '`
      and confirm only synthetic test fixtures match.
- [ ] **[you]** Flip visibility to public.
