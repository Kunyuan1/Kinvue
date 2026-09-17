Closes #

<!-- ^ The ticket's issue number, e.g. "Closes #25". Keep this line bare and
     unbolded on its own line — that exact form is what GitHub parses. The
     ticket's KV number is the same number: KV-25 is #25. -->

## What

<!-- One or two sentences: what does this PR change? -->

## Why

<!-- The problem or task this solves. -->

## How I tested it

<!-- Check all that apply, add detail where it helps the reviewer -->

- [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` all pass
- [ ] Ran the app (`npm run dev`) and exercised the change
- [ ] Capture change: validated against a real webcam session, not just types
- [ ] Not testable locally — explained below

## Does this change what the app claims?

<!-- Delete this section if it plainly does not apply. Answer it if the PR
     touches scoring, the baseline, the capture, stored data, or any copy. -->

- [ ] Changes when a session is flagged, or what a flag means
- [ ] Changes a tuned constant (threshold, window, severity weight)
- [ ] Touches the privacy surface — telemetry, the preload bridge, where the API key lives
- [ ] Changes what leaves the device, or what could once remote access exists
- [ ] Changes the shape of a stored record — a test shows a record written before it still loads
- [ ] Changes wording the caregiver or the cared-for person reads

<!-- If any are checked: say what the new claim is, and confirm README.md and
     ARCHITECTURE.md still describe it accurately. A record-shape change needs
     the test as well; a docs check does not cover it. The same list is in
     .github/ISSUE_TEMPLATE/ticket.yml — change both together. -->

## Anything risky or follow-up needed?

<!-- New env vars? Known limitations? Delete this section if none. -->
