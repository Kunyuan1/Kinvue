Closes #

<!-- ^ The GitHub issue number, e.g. "Closes #7". Keep this line bare and
     unbolded on its own line — that exact form is what GitHub parses.
     "KV-7" alone is plain text to GitHub and closes nothing. -->

## What

<!-- One or two sentences: what does this PR change? -->

## Why

<!-- The problem or task this solves. -->

**Ticket:** KV-

## How I tested it

<!-- Check all that apply, add detail where it helps the reviewer -->

- [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` all pass
- [ ] Ran the app (`npm run dev`) and exercised the change
- [ ] Capture change: validated against a real webcam session, not just types
- [ ] Not testable locally — explained below

## Does this change what the app claims?

<!-- Delete this section if it plainly does not apply. Answer it if the PR
     touches scoring, the baseline, the capture, or any user-facing copy. -->

- [ ] Changes when a session is flagged, or what a flag means
- [ ] Changes a tuned constant (threshold, window, severity weight)
- [ ] Touches the privacy surface — network, telemetry, stored data, the preload bridge
- [ ] Changes caregiver-facing wording

<!-- If any are checked: say what the new claim is, and confirm README.md and
     ARCHITECTURE.md still describe it accurately. -->

## Anything risky or follow-up needed?

<!-- New env vars? Changes the session file's shape? Known limitations?
     Delete this section if none. -->
