# Architecture

`README.md` describes *what* the system does and where the code lives. This file is the
*why* — the decisions that are load-bearing, and what they cost. Read it before changing
the scoring model, the baseline, or where the API key lives.

---

## Why a rule engine and not a trained model

The obvious-looking version of this project trains a classifier on "days before something
went wrong" and reports a risk probability. We are not doing that, and not because it would
be more work.

- **There is no labelled data.** Nobody has a dataset of older adults' daily vitals
  annotated with what happened next. Building one is a longitudinal study.
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

The honest framing, and the one to use wherever the project is described: this is a transparent
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
runs — and since bad framing and low light are the single most likely way a capture
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

The key reaches the main process from `.env`, read at startup by `app/main/env.ts` and
only when the app is not packaged. It is
deliberately not named with one of electron-vite's `VITE_` prefixes: prefixed variables
are replaced into the bundle at build time, so the convenient-looking fix would write the
key into `out/main` in plain text and ship it. Reading it at runtime keeps it out of every
built file. Where the key lives for a packaged install, where there is no dotfile to edit,
is still open (KV-19).

**Vitals originate in the main process and nowhere else.** `capture` returns the reading
for display along with a `captureId`; `submit` takes that id, never the numbers. The
renderer can show a measurement but cannot hand one back, so a renderer bug cannot score
and store vitals that no camera produced. Everything else the renderer sends is validated
at runtime in `core/session/validate.ts` and rejected rather than repaired, because
whatever gets past that line is written into the permanent history — and, once remote
access exists, into someone else's view of it.

The held reading carries two more things the renderer cannot talk main out of. It belongs
to the person it was taken for, so a stale selection in the UI cannot file one person's
reading against another's baseline. And it expires: answers describe how someone is now,
so a reading left waiting past `PENDING_CAPTURE_TTL_MS` cannot be stored alongside answers
given later. Both are enforced in `core/session/checkin.ts`, which holds that state and is
tested without a camera or an Electron harness; `app/main` only wires it to IPC.

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

The product compares a reading against weeks of that person's own history, and a new
install has none. To develop the dashboard with a baseline behind it — and to show it to
anyone — the app can seed an invented fortnight for one persona, with real captures
stacked on top.

This is a shortcut, and the response to a shortcut is to disclose it rather than disguise
it. Every seeded record carries `seeded: true`, `SessionCard` renders that label, and
seeding only happens when someone asks for it. Anyone who finds a hidden fake baseline
learns not to trust the real numbers either.

The label does not yet cover everything the shortcut touches. The dashboard always
records against the demo persona, and `computeBaseline` does not look at `seeded`, so a
real capture taken after seeding is scored against the invented fortnight — which clears
`MIN_BASELINE_SESSIONS` on its own. That card's vitals are real, but its verdict and
explanation ("HRV is N% below their usual") compare them with numbers nobody measured,
and it carries no label saying so. Until the scorer either leaves seeded records out of a
real session's baseline or marks the result (KV-53), treat any verdict on the demo
persona as a demonstration of the dashboard, not a reading of anyone.

Seeding does not solve the underlying problem, which is that a genuine install says "not
enough to say" for its first few check-ins. That is a product question (KV-17), and
seeded data must never be the answer to it — which is why the gap above is a defect to
close rather than a convenience to keep.

---

## Planning for remote access

Everything above describes an app used at one machine. The product it is for is not: the
caregiver it exists to help is often not in the room. A caregiver seeing check-ins from
their own device will therefore be part of the product — and it is the single change most
able to undo the decisions in this file by accident.

It is not being built yet. It is being planned now, because several of its requirements
are cheap to honour today and expensive to retrofit once real check-ins exist.

### What is settled

- **Scoring stays on the check-in device.** A server, when there is one, carries results;
  it never scores and never needs raw data to do its job. `core/` runs where the camera
  is.
- **Consent comes before anything leaves the device.** Who has access is visible on the
  check-in device, and access can be revoked from it. Remote visibility of someone's daily
  physiology without consent is surveillance, however well meant. *Whose* consent that is
  — the person's own, or a guardian's when they cannot give it — is not settled here.
  (#31)
- **What leaves the device is decided in one place** — a single tested function in
  `core/`, with every field of a session explicitly classified. Sync code sends what it
  returns and nothing else. (#37)
- **A calm daily summary, never a real-time alert.** A notification the moment a flag
  fires would turn the app into the emergency alarm it is designed not to be, and a lock
  screen far away cannot carry the difference between "worth a look" and "drive over".
  (#43)
- **No secondary use without its own consent.** The data exists for that person's care:
  no analytics on it, and no aggregation across people. The one planned exception is
  calibrating the rule thresholds (#22), which pools caregiver-confirmed outcomes (#47)
  across people. That is opt-in, asked for separately from sharing with a caregiver, and
  must clear #31 and #35 before any session is used for it.
- **`core/` stays framework-free**, so that it can be imported by more than one app if
  #34 chooses a TypeScript client. `core/session/store.ts` is already the exception — it
  imports `node:fs` — and #38 decides where it lives when the repo is split. (#15, #38)

### What must hold before real check-ins are stored

Each is owned by a Phase 1 ticket that has to land before the check-in flow (#2) stores
real sessions, because a record written without them cannot be repaired afterwards. Two
hold today; the third does not:

- **Records are never edited in place, and have globally unique ids.** Both hold.
  Sessions are only ever appended, which is the property sync needs, and an id is a UUID
  rather than the local clock, so two devices — or two submits in the same millisecond —
  cannot produce the same one (#25). Seeded ids repeat across installs, which is
  acceptable only because seeded records never leave the device (#37). When a record is
  removed — by deletion, or by whatever retention #21 settles on — sync must carry that
  as a tombstone, not as silence. (#45)
- **Vitals originate in the main process and nowhere else.** This holds: `submit` takes
  the id of a capture main is holding, never the numbers. The rule, and what else that
  held capture is pinned to, is under *Why the API key lives in the main process*. (#25)
- **Every record knows its local time zone.** This does not hold yet — no record has one.
  `capturedAt` is UTC; a caregiver in another zone needs the cared-for person's *today*,
  and a UTC timestamp recorded without its zone can never be placed on the right local
  day afterwards. (#28)

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
direction. It does not keep the privacy guarantees in `README.md` true: any sync ends *no
network* and *session data is local*, encrypted or not, and the other three are
unaffected either way. What it adds is a new guarantee — neither the relay's operator nor
anyone who compromises the relay can read a check-in (#36). It is not assumed:
lost-device recovery and revocation are genuinely harder under it, and #33 has to weigh
that honestly.

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
