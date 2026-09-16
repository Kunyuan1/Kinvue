# Architecture

`README.md` describes *what* the system does and where the code lives. This file is the
*why* — the decisions that are load-bearing, and what they cost. Read it before changing
the scoring model, the baseline, or where the API key lives.

---

## Why a rule engine and not a trained model

The obvious-looking version of this project trains a classifier on "days before something
went wrong" and reports a risk probability. We are not doing that, and the reason is not
schedule pressure alone.

- **There is no labelled data.** Nobody has a dataset of older adults' daily vitals
  annotated with what happened next. Building one is a longitudinal study, not a weekend.
- **Training on synthetic data would launder a guess into a number.** A model fit to data
  we invented would produce confident probabilities whose only real content is the
  assumptions we wrote into the generator. A rule that says "HRV is 41% below their usual"
  makes the same assumption *visible* instead of hiding it behind a number.
- **The output has to be explainable to a family member,** not to a data scientist. A
  caregiver deciding whether to drive over needs to know *what* changed. `firedRules` is
  that, directly, with the values in the sentence.
- **Rules are testable.** `tests/scoring.test.ts` pins the behaviour that matters,
  including the specific combination the product exists to catch. A model would need an
  evaluation harness and a dataset before it could be said to work at all.

The honest framing, and the one that should appear in any writeup: this is a transparent
heuristic over a real physiological signal, not a predictive model. The technical
substance is in the real-time video pipeline the SDK provides and in the baseline
comparison — not in the arithmetic of the scorer.

**If this is ever revisited**, the path is: collect real sessions with caregiver-confirmed
outcomes, then use them to *calibrate the existing rule thresholds*, which are currently
judgement. That is a much smaller and more defensible step than fitting a classifier.

---

## Why the baseline is per-person

Population reference ranges are the wrong comparison for this user. A resting pulse of 88
is unremarkable for one 80-year-old and a meaningful change for another; a fixed threshold
flags the first person every single morning and never flags the second. Either failure
destroys the product — the first through alarm fatigue, the second by missing the thing it
exists to catch.

So every vitals rule compares against `computeBaseline(history)` and nothing else. Two
consequences follow, and both are deliberate:

1. **The app is useless on day one and says so.** Below `MIN_BASELINE_SESSIONS` the
   verdict is `insufficient-signal`, not `normal`. Reporting "normal" from no baseline
   would be a lie told in the reassuring direction, which is the worse direction.
2. **The scored session is excluded from its own baseline.** A reading averaged into the
   mean it is compared against pulls that mean toward itself and understates every
   deviation. `scoreSession` takes `history` separately for exactly this reason, and a
   test pins it.

Pulse and breathing are compared in standard deviations rather than percentages, so a
person with naturally variable readings is not flagged for ordinary variation.
`MIN_SD_FRACTION_OF_MEAN` floors the sd so an unusually consistent fortnight cannot make
every subsequent reading a 6-sigma event.

---

## Why `insufficient-signal` is a first-class verdict

Three different situations produce it: the capture was too short, the SDK's own confidence
was too low, or there is not yet enough history. All three mean the same thing to the
caregiver — *we cannot tell you today* — and none of them should be rendered as a green
tick.

The tempting shortcut is to score the four questions alone when the camera reading fails
and call the result `normal`. That would quietly redefine what the flag means, on exactly
the days the measurement failed, without telling anyone. The rules that fired are still
shown in this state; only the verdict is withheld.

---

## Why Electron, and where the camera runs

The SmartSpectra SDK has no browser build. Supported targets are Android, Swift/iOS, C++
and Node/Electron, and the Node package binds a platform-specific native runtime through
`koffi` (FFI). A pure web app was therefore never available; Electron is the shortest path
that still lets the UI be written as a web app.

`externalizeDepsPlugin()` in `electron.vite.config.ts` keeps `@smartspectra/node-sdk` out
of the bundle. Bundling it breaks the native runtime lookup at require time. That line is
load-bearing.

**Open decision (KV-1):** capture currently runs in the *main* process via `useCamera()`.
The SDK's own docs note this "captures in THIS process" and suggest the renderer SDK's
`useMediaStream()` for Electron. The renderer path also emits a `streamAvailable`
`MediaStream`, which would let the person see and fix their own framing while the capture
runs — and since bad framing and low light are the single most likely way the live demo
fails, that is worth real weight. The cost is that the renderer SDK is constructed with
the API key, moving it out of the main process. This should be settled against hardware,
not in the abstract.

---

## Why `core/` has no framework imports

`core/` is plain TypeScript: no Electron, no React, no DOM. This is enforced socially
rather than by tooling right now, and it buys two things.

- **The rules are testable without a harness.** `npm test` runs in a plain node
  environment with no camera, no API key and no Electron. A suite that needed a window
  would not be run often enough to be worth having.
- **The scorer is portable.** If this ever becomes a phone app — which is the right shape
  for the real product, since the SDK has native iOS and Android SDKs — `core/` is the
  part that survives unchanged.

`core/session/store.ts` is the one exception: it imports `node:fs` and is main-process
only. It is kept in `core/` because it is a domain concern rather than an Electron one,
and the file says so at the top.

---

## Why the API key lives in the main process

`app/preload/index.ts` exposes named calls only — `listSessions`, `capture`, `submit`,
`seedDemo` — and deliberately no generic `invoke(channel, ...)` passthrough. A generic
bridge hands the renderer the entire main process the moment any renderer code is
compromised, which for an app processing a person's physiological data is not a
theoretical concern worth accepting for the convenience.

The renderer additionally runs under a `default-src 'self'` CSP, so it cannot load remote
code or call out to a remote origin. Combined with `enableTelemetry: false` on the SDK,
the claim "this app makes no network calls of its own" is meant literally.

---

## Why a JSON file and not SQLite

One record per person per day. At that size a single JSON file is not a compromise — it is
the correct amount of machinery, and it avoids rebuilding a native module against
Electron's ABI, which is a genuine way to lose an afternoon.

Writes go through a temp file and a rename, so a crash mid-write cannot truncate the
history. Losing one day's check-in is recoverable; losing the baseline that every
comparison depends on is not.

`SessionStore` is an interface for exactly one reason: it is the seam to swap when the
size assumption stops holding.

---

## Why the demo history is seeded, and why it is labelled

The product compares a reading against weeks of that person's own history. A hackathon
build has no weeks. The demo therefore seeds an invented fortnight for one persona and
stacks a single real, live capture on top of it.

This is a shortcut, and the response to a shortcut is to disclose it rather than disguise
it. Every seeded record carries `seeded: true`, `SessionCard` renders that label, seeding
is opt-in (`KINVUE_SEED_DEMO`, default off), and the README and demo script say so out
loud. A judge who discovers a hidden fake baseline has learned something bad about the
team; one who is told about a disclosed one has learned the constraint was understood.

---

## Planning for remote access

Everything above describes an app used at one machine. The product it is for is not: the
caregiver it exists to help is often not in the room. A caregiver seeing check-ins from
their own device is therefore a certain part of the product's future — and it is the
single change most able to undo the decisions in this file by accident.

It is not being built yet. It is being planned now, because several of its requirements
are cheap to honour today and expensive to retrofit once real check-ins exist.

### What is settled

- **Scoring stays on the check-in device.** A server, when there is one, carries results;
  it never scores and never needs raw data to do its job. `core/` runs where the camera
  is.
- **Consent comes first.** Nothing leaves the device without the cared-for person's
  agreement, and they can see who has access and take it back. Remote visibility of
  someone's daily physiology without their say is surveillance, however well meant.
- **What leaves the device is decided in one place** — a single tested function in
  `core/`, with every field of a session explicitly classified. Sync code sends what it
  returns and nothing else. (#37)
- **A calm daily summary, never a real-time alert.** A notification the moment a flag
  fires would turn the app into the emergency alarm it is designed not to be, and a lock
  screen far away cannot carry the difference between "worth a look" and "drive over".
  (#43)
- **No secondary use.** The data exists for that person's care. No analytics on it and no
  aggregation across people.
- **`core/` stays framework-free**, because it will be imported by more than one app.
  (#15, #38)

### What applies from today

These hold now, before any remote code exists, so that the records being written today
are ones remote access can use:

- **Records are immutable, append-only and globally unique.** Sessions are already never
  edited in place, which is exactly the property sync needs. Ids must not come from a
  local clock. (#25, #30)
- **Vitals originate in the main process and nowhere else.** Once records are read far
  away, the boundary that stops invented numbers has to be the process boundary, not the
  capture code. (#25)
- **Every record knows its local time zone.** `capturedAt` is UTC; a caregiver in another
  zone needs the cared-for person's *today*, and a UTC timestamp recorded without its zone
  can never be placed on the right local day afterwards. (#28)

### What is deliberately still open

Each of these is a real decision with its own ticket, and each must be closed and written
into this file before remote code is written:

| Question | Ticket |
|---|---|
| Who consents, and how is access withdrawn — including for someone who cannot consent | #31 |
| What leaves the device: verdict, explanation, vitals, answers, the pain note | #32 |
| Can the server read what it carries, and how are keys managed and recovered | #33 |
| What the caregiver's client is | #34 |
| What legal and regulatory obligations sending health data brings | #35 |
| What is being protected, from whom — including a viewer who is the danger | #36 |

End-to-end encryption, so the relay cannot read what it carries, is the preferred
direction because it keeps most of the privacy guarantees in `README.md` true. It is not
assumed: lost-device recovery and revocation are genuinely harder under it, and #33 has
to weigh that honestly.

When remote access ships, the privacy section of `README.md` is rewritten in the same
change. The docs must never describe a device that sends nothing after it starts sending
something.

---

## What this architecture is bad at

- **One person per install.** `personId` exists throughout, but nothing manages multiple
  cared-for people, and a home-care aide with six clients is the obvious real user. Remote
  access makes it many-to-many — a parent with three children who each want to see — so
  the relationship should be modelled that way from the start. (#18)
- **No remote access yet.** The caregiver has to be at the same machine as the camera,
  which is precisely backwards for the family-member-at-a-distance case the product is
  for. Fixing it means a backend and a real authorization story, and it renegotiates the
  privacy guarantees — which is why it is planned deliberately above rather than
  discovered later.
- **Severity weights are unvalidated.** They are ordered sensibly and tested for the
  behaviour we want, but no number in `rules.ts` is calibrated against an outcome.
- **A single daily sample is a weak signal.** Time of day, having just walked upstairs,
  and caffeine all move these metrics more than a mild illness does. The baseline absorbs
  some of that; nothing here corrects for it.
