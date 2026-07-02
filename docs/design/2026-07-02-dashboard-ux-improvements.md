# Dashboard UX improvements — plan from operator feedback

Date: 2026-07-02
Status: proposed

## Source feedback (new operator, verbatim themes)

1. "The UI chat is quite hard to read — hard to tell which messages are from me and which from orquestra."
2. "Perhaps make the reply text box longer (maximize the real estate)."
3. "Onboarding needs to be a little more guided — after choosing the datanet, it took me a while to figure out that I need to manually start the node."
4. "I'm not sure what I'm supposed to do after starting the node."

All four are first-run comprehension problems, not feature gaps. The operator got through onboarding —
the cost was confusion, which is exactly what conversational onboarding (ADR 0001) is supposed to remove.

## 1. Chat message distinction (ChatTab + onboarding chat)

Current state (`web/src/styles.css:318-323`): user vs assistant bubbles differ only by
`--accent-soft` vs `--panel-2` background and left/right alignment. On some monitors/themes the
two panel tones are nearly identical; the 10px uppercase `who` label is easy to miss.

Plan:
- Strengthen the user bubble: solid accent background (not `-soft`), higher-contrast text, so the
  eye separates the two sides without reading labels.
- Add a small avatar glyph per side (`you` → filled circle initial, `orquestra` → node logo mark)
  replacing the text-only `.who` label. Keep the label as a tooltip/aria-label for accessibility.
- Increase bubble gap between opposing roles (group consecutive same-role messages tighter,
  larger gap on role change) — the alternation rhythm itself becomes a reading aid.
- Apply the same treatment to the onboarding chat (`Onboarding.tsx` shares message rendering
  patterns) so both chats read identically.

Acceptance: in both light/dark themes, a screenshot of a 6-message conversation is
role-attributable at a glance with the `who` labels hidden.

## 2. Compose box real estate (ChatTab)

Current state (`ChatTab.tsx:79`, `styles.css:324-325`): single-line `<input type="text">`.
Goals/strategy descriptions are sentence-to-paragraph sized; a one-liner truncates visually and
discourages detail.

Plan:
- Replace `<input>` with an auto-growing `<textarea>` (1 → ~6 rows max, then internal scroll).
- Enter submits, Shift+Enter inserts newline (standard chat convention); document in placeholder.
- Widen the chat column: `.msg { max-width: 76% }` and the compose row currently sit inside a
  container that leaves unused margin on wide screens — raise the chat column max-width so the
  compose box and messages use more of the viewport.

Acceptance: typing a 3-sentence goal shows all text without horizontal scrolling; compose area
visibly grows; Enter/Shift+Enter behave per convention.

## 3. Guided onboarding — the "manually start the node" gap

Current state (`Onboarding.tsx:186`): after the interview finalizes a strategy, a
`Confirm & start the node` button appears among the summary UI. The operator didn't find it
quickly — the transition from "chatting" to "you must now act" is not signposted.

Plan:
- Add an explicit stepper across the onboarding screen: `1 Connect → 2 Interview → 3 Review →
  4 Start`. Highlight the active step; the interview's finalization advances the stepper to
  Review, making "there is a next action" structurally visible.
- When the strategy finalizes, auto-scroll to and pulse-highlight the confirm button once
  (CSS animation, no JS timer loops), with a one-line banner: "Your strategy is ready — review
  it on the right, then start the node."
- Rename the button to `Start the node` (the "Confirm &" prefix buries the action verb).

Acceptance: a first-time operator reaching finalization sees, without scrolling or hunting,
that the next action is starting the node.

## 4. Post-start orientation — "what am I supposed to do now?"

Current state: after confirm, `confirmMsg` says "saved — the node starts its first cycle shortly"
(`Onboarding.tsx:126`) and the operator lands on the dashboard with empty panels (no activity yet,
PnL zeros). Nothing explains that the node is autonomous and the dashboard is read-only observation.

Plan:
- First-run "what happens next" card on the dashboard, shown until the first cycle completes
  (dismissible; keyed on localStorage + first activity row):
  - "Your node runs a cycle every N hours (from your strategy). Each cycle it votes and mints
    within your budget. You don't need to do anything — watch activity land here."
  - Links: Activity tab, Strategy tab ("adjust anytime — changes apply next cycle"), and the
    health endpoint note.
- Empty-state copy for Activity/PnL panels pre-first-cycle: "No cycles yet — first cycle at
  ~HH:MM" (scheduler exposes the next-tick time; surface it via the existing health/earn-status
  endpoint rather than adding a new one if the field already fits).
- README: add a short "After you start the node" section mirroring the card (docs and UI say the
  same thing).

Acceptance: immediately after onboarding, the dashboard states in one glance that the node is
autonomous, when the first cycle runs, and where results will appear.

## Sequencing & scope

| # | Item | Size | Files (expected) |
|---|------|------|------------------|
| 1 | Chat bubble contrast + avatars | S | `styles.css`, `ChatTab.tsx`, `Onboarding.tsx` |
| 2 | Textarea compose + wider column | S | `ChatTab.tsx`, `styles.css` |
| 3 | Onboarding stepper + start CTA | M | `Onboarding.tsx`, `styles.css` |
| 4 | Post-start orientation card + empty states | M | `App.tsx`, new `FirstRunCard.tsx`, `Activity.tsx`, `PnlCards.tsx`, README |

1+2 are one PR (both ChatTab). 3 and 4 land as separate PRs. All are `web/`-only except 4's
possible next-tick field; no node/runtime behavior changes, no new endpoints unless the
next-cycle timestamp isn't already surfaced.

## Non-goals

- No auth, no public-bind changes (ADR 0002 unchanged).
- No re-architecture of onboarding — the interview flow stays; this adds signposting around it.
- No theming overhaul; contrast fixes work within existing CSS variables.
