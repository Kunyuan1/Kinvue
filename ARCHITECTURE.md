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

A fourth produces it as of KV-12: the camera measured something and **nothing rated it**.
A rate can arrive carrying a value and a timestamp and nothing else — no confidence, no
stable flag — and scoring that would present a number as reliable on the grounds that
nothing said otherwise.

The card says which one happened, because they are different things for a caregiver to be
told and collapsing them hides which. The four sentences, verbatim, are the ones in
`UNUSABLE_SUMMARY`:

| Reason | What the card says |
|---|---|
| Nothing measured | *"The camera ran but no reading came out of it, so today is not being compared."* |
| Capture too short | *"The camera did not run for long enough to use, so today is not being compared."* |
| Nothing rated it | *"The camera did not say how reliable this reading was, so today is not being compared."* |
| Rated, and poor | *"The camera reading was not clear enough to use, so today is not being compared."* |

Each states its own consequence rather than describing the failure and stopping — the
consequence is the part a caregiver acts on. The reason is picked in that order, which is
not the order of the thresholds: a capture cut short is reported as short even when it
also arrived unrated, because the duration explains the missing rating and is the one
thing the person in front of the camera could have done differently.

The verdict is withheld; the reading is not. The rate is still shown, because it is real
— what is withheld is the comparison against their usual, which is the part that would
treat an unvouched-for number as reliable.

The tempting shortcut is to score the four questions alone when the camera reading fails
and call the result `normal`. That would quietly redefine what the flag means, on exactly
the days the measurement failed, without telling anyone. The rules that fired are still
shown in this state; only the verdict is withheld.

**With one exception, added in KV-71: a rule that quotes "their usual" does not fire
until that metric has at least `MIN_BASELINE_SESSIONS` readings of its own.** Until then
`scoreSession` ran every rule before the maturity check, so a card could say *"1 of 3
check-ins needed before daily comparisons start"* and, in the next sentence, *"Breathing
was 16 breaths/min, above their usual 15"*. Both halves on screen, one denying the other.

**Counted per metric, not per card, and the distinction is the whole of it.**
`Baseline.sessions` counts sessions that produced *some* reading, and a capture routinely
produces some vitals and not others — `Vitals` says so, and HRV is the standing example.
Three sessions can therefore back a pulse mean and a single breathing reading, and gating
on the session count would let the card quote "their usual 15 breaths/min" off one
morning. `Stat.n` is the count that actually backs the number being quoted. It can never
exceed `Baseline.sessions`, so the per-metric gate subsumes the card-level one rather
than sitting beside it, and `scoreSession` does not filter the rule list at all.

The comparison at that point is not merely early, it is meaningless. `stat` reports an
`sd` of 0 for a sample of one, so `MIN_SD_FRACTION_OF_MEAN` floors it at 2% of the mean
and that floor becomes the scale the z is measured against — a one-session baseline
cannot produce a small z, because nothing about the person is setting the spread. The
floor was written to stop an unusually consistent fortnight making every reading a
6-sigma event; applied to a sample with no spread because it has one member, it
manufactures the deviation it is meant to damp.

So the answer rules still fire and the reading is still shown. What is withheld is the
comparison, which is the part there is no evidence for.

---

## Why Electron, and where the camera runs

The SmartSpectra SDK has no browser build. Supported targets are Android, Swift/iOS, C++
and Node/Electron, and the Node package binds a platform-specific native runtime through
`koffi` (FFI). A pure web app was therefore never available; Electron is the shortest path
that still lets the UI be written as a web app.

`externalizeDepsPlugin()` in `electron.vite.config.ts` keeps `@smartspectra/node-sdk` out
of the bundle. Bundling it breaks the native runtime lookup at require time. That line is
load-bearing.

### What the SDK actually emits

Recorded from a real capture (KV-1), because the reduction in `app/main/vitals.ts` was
written against the type definitions and got this wrong:

- **A metrics message carries whichever metrics were ready at that instant**, not all of
  them. Over one 60-second capture: 1309 messages carried breathing only, 118 cardio
  only, 90 both. Reading every vital off the final message therefore returns whatever
  that one happened to hold and silently drops the rest — which is exactly what the code
  did, and the scorer still found no reason to withhold, so nothing surfaced the loss.
- **Only the rate readings actually reported `stable` and `confidence`** —
  `cardio.pulseRate[]` and `breathing.rate[]`. The schema declares both on HRV too, but
  across that capture no HRV entry set either, so a rule keyed on "the last HRV the SDK
  marked stable" matched nothing. Note the limit of the evidence: a decoded message is a
  protobufjs instance whose proto3 defaults sit on the prototype, so "field absent" and
  "field present and zero" look identical unless you ask by own-property. Everything
  reading this stream has to ask that way, or a reading nobody took arrives as a
  confident zero.
- **Most of the stream is waveform, not rates.** Those 1517 messages held 53 pulse
  readings, 17 breathing rates and 30 HRV entries; the rest were trace points.
- **The first seconds of guidance are noise.** Every run so far — six of them, well lit
  and badly lit alike — emitted exactly 57 `kTooDark` hints between about 4s and 5s while
  the camera was still settling, and nothing after. Forwarding `validationStatus`
  straight to the person would tell them to turn on a light at the start of every
  check-in. #6 waits for a code to persist rather than ignoring a fixed opening window:
  exposure complaints have to hold for seconds before they are believed, framing advice
  only for a moment. A wall-clock window would have had to be calibrated against how long
  one particular camera takes to open, and would quietly stop working on a slower one.
- **The metrics arrive at different times.** In that capture the first breathing rate
  appeared at ~13s, the first pulse at ~20s, and the first HRV at ~34s. A 30-second
  capture can therefore end before HRV exists at all, which matters because HRV is the
  signal the scorer leans on hardest. The capture-length constants are not settled by one
  run on one person in one room; KV-63 owns that.

The reduction lives in `app/main/metrics.ts`, apart from the SDK plumbing, because
importing `@smartspectra/node-sdk` loads its native runtime through koffi at import time.
Splitting them keeps the reduction testable on any machine, including ones with no
runtime for their platform.

### Capture stays in the main process (KV-1, settled on hardware)

The SDK's own docs note that `useCamera()` "captures in THIS process" and suggest the
renderer SDK's `useMediaStream()` for Electron. The renderer path emits a
`streamAvailable` `MediaStream`, so it looked like the only way to give the person a live
self-view — and framing is not a detail: the first two real captures produced **no
readings at all**, purely because the person could not see that their face was sitting at
the bottom of the frame. The SDK holds the webcam exclusively, so no second app can show
them either.

The cost of that path is the whole of *Why the API key lives in the main process*: the
renderer SDK is constructed with the key.

It turns out not to be a trade at all. The main-process SDK emits a `videoOutput` event
carrying each processed frame — the docs call it "mainly useful for the custom-input /
headless path", but it fires under `useCamera()`, confirmed by rendering those frames
live during a real capture. So the self-view can be fed from main, over the same kind of
one-way channel as `checkin:progress`, and the key never moves.

What that costs instead, now built in #3: frames are throttled to ten a second, sampled
down to 320px *as they are converted* — a full 1280×720 conversion followed by a resize
would be most of the work and all of it discarded, on the same loop that carries the
guidance — and encoded as JPEG by Electron's own `nativeImage`, on a one-way channel the
renderer can only listen to. It is display only — nothing writes
footage to disk, and the README's *no raw video is stored or transmitted* claim holds —
but it is the widest thing the bridge carries, and #29's Electron security baseline should
treat it as such. A pixel format the conversion does not handle costs the preview and
nothing else: the capture and its guidance carry on.

---

## Why `core/` has no framework imports

`core/` is plain TypeScript: no Electron, no React, no DOM. **ESLint enforces it** (KV-15):
`eslint.config.mjs` restricts `electron`, `react`, `react-dom`, `@renderer/*`, the
SmartSpectra SDK and **any import from `app/`** inside `core/**`, and `npm run lint` is
part of the check set the pre-commit hook and CI both run.

The last of those is the one that makes it a rule about direction rather than a list of
today's offenders. Banning the packages alone left the shortest route to them open: a
relative `../../app/main/metrics` is not any of the restricted names, and that module
imports the SDK, so a test touching the core file that imported it would need hardware.
It is also the likelier accident rather than the exotic one, because `@core/*` and
`@renderer/*` have tsconfig aliases and `app/main` has none — a relative path is the only
spelling available to someone who wants a type from it. Type-only imports are restricted too — `import type` is
erased and would not break the suite, but a React type in a signature couples `core/` to
the framework just as firmly, and the next value import would then be a one-word change
with nothing objecting.

It was enforced socially until then, which was the risk: the day it broke would be the
day the tests started needing a harness, and nothing would have announced it. The rule
buys two things.

**What the rule does not see:** any `import()` expression, including one with a literal
specifier — `await import('electron')` in `core/` lints clean. That is a limitation of
`no-restricted-imports` rather than of this config, and it is the honest edge of the
guard: it catches someone adding a normal import, which is the realistic case, not
someone routing around it.

- **The rules are testable without a harness.** `npm test` runs in a plain node
  environment with no camera, no API key and no Electron. A suite that needed a window
  would not be run often enough to be worth having.
- **The scorer is portable.** If this ever becomes a phone app — which is the right shape
  for the real product, since the SDK has native iOS and Android SDKs — `core/` is the
  part that survives unchanged.

`core/session/store.ts` is the one exception: it imports `node:fs` and is main-process
only. It is kept in `core/` because it is a domain concern rather than an Electron one,
and the file says so at the top. Node built-ins are deliberately *not* restricted — the
rule bans frameworks and the SDK, not the platform — so that exception needs no carve-out
in the config. If `core/` is ever wanted in a browser, that is the line to revisit.

---

## Why the API key lives in the main process

`app/preload/index.ts` exposes named calls only — `listSessions`, `capture`, `submit`,
`seedDemo` — and deliberately no generic `invoke(channel, ...)` passthrough. A generic
bridge hands the renderer the entire main process the moment any renderer code is
compromised, which for an app processing a person's physiological data is not a
theoretical concern worth accepting for the convenience.

The renderer additionally runs under a `default-src 'self'` CSP, so it cannot load remote
code or call out to a remote origin.

**The SDK is a different matter, and this was wrong until a capture was measured.** The
claim here used to be that `enableTelemetry: false` made "no network calls of its own"
literally true. It does not. Every real capture opened an outbound TLS connection as the
session started — before any measurement existed — to an AWS-fronted endpoint, with
telemetry off; `cont-api.physiology.presagetech.com` is compiled into each platform runtime.
(KV-1 recorded it as `api.physiology…` by matching a substring: every occurrence in the
binary is prefixed `cont-`, `dev.cont-` or `test.cont-`, and there is one production host.) A
control process of the same shape without the SDK opened nothing, so it is the SDK.

**Measured properly since (KV-65), and most of it is reassuring.** Two Wireshark runs. The
first, two captures of different lengths, each from a fresh app launch:

| | 28s capture | 50s capture |
|---|---|---|
| Outbound | 55 kB | 66 kB |
| Inbound | ~2.05 MB | ~2.10 MB |
| TCP connections | 11 | 18 |
| Download connection, outbound | 34 kB | 28 kB |
| The other connections, outbound | 21 kB over 10 | 38 kB over 17 |
| **Per short connection** | **~2.1 kB** | **~2.2 kB** |

The last two rows are derived: total outbound less the download connection, over the
connections that are not it.

The second, one launch with two captures in it and then a third with Wi-Fi off — the run
that separates what happens per launch from what happens per capture. Frames are what
Wireshark counts; data is the TCP payload inside them; acknowledgements are frames that
carry no data at all:

| | Once, at launch | Capture A (40s) | Capture B (47s) |
|---|---|---|---|
| Connections | 3 | 12 | 14 |
| Outbound frames | 7.6 kB | 59.2 kB | 48.1 kB |
| of which data | 6.0 kB | 22.5 kB | 28.3 kB |
| of which acknowledgements | 0.8 kB | 34.0 kB | 16.6 kB |
| Inbound | 19 kB | 2.11 MB | 2.12 MB |

The video is not being uploaded. Fifty seconds of even heavily compressed 320px frames
would be megabytes; no capture in either run sent more than 66 kB of frames, and the most
data any capture sent was 28 kB. The traffic is overwhelmingly inbound, and **about 2 MB is
fetched at the start of every capture**, not once per launch: in the second run each capture
opened with its own ~2.03 MB download over a single connection lasting about half a second.
Only three small connections happen once per launch. Nothing crossed at all between the two
captures, while the questions were being answered, or after the second one ended.

**Why a capture cannot run offline — both candidates, per the SDK's own log.** With Wi-Fi
off, after two successful captures in the same launch, the third failed as
`kProcessingFailed` and the SDK logged, in this order: from `rest_api_client`, "Metrics
authorization failed. Status code: 0"; from `metric_gating_calculator`, "Authorization
server unavailable or returned error"; then, 1.5 seconds later, from `secure_model_loader`,
a cancelled load of `model_id=phasic-bp-inference`, followed by "Model load failed". So the
licence check gates measurement, and a model is loaded through a secure loader as each
capture starts — which is most likely what the per-capture 2 MB is. The log does not say
which of the two alone would have stopped the capture; it does show both in the path. For
the app that changes nothing, since either way a capture needs the network. For #32 and #36
it means two obstacles to offline use rather than one: a model that is not kept between
captures, and an authorization that is never offline by design. `kProcessingFailed` (8)
still says nothing about the network, which is why the app decides from `net.isOnline()`
rather than from it (KV-104) — and on this run it named the connection correctly.

Nor does outbound scale like a stream of readings. During a capture the SDK opens a new TLS
connection every five seconds, plus a second series every fifteen whose requests run a
little larger — up to 4 kB of data — and none is held open: the longest connection in the
second run lasted under five seconds. In the first run the short connections stayed at about
2.1–2.2 kB each while the capture nearly doubled, which is what a fixed handshake plus a
small request looks like — a TLS 1.3 handshake alone is 1–2 kB client-side — and not what a
payload growing with the measurement looks like.

**The first run's 41 kB fixed term is acknowledgements.** Fitting its two points gives roughly
41 kB fixed plus 0.5 kB per second, and the fixed part is dominated by the download
connection. In the second run, 30.3 kB of that connection's 32.2 kB outbound was frames
carrying no data — the acknowledgements of 2 MB coming in — and the data it sent was 1.7 kB.
The same download at the next capture produced 14.4 kB outbound, 12.5 kB of it
acknowledgements. That is also why the first run's 34 kB to 28 kB drop on that connection
means nothing: it follows how a download happened to be acknowledged, not the capture.

**Those pings are a licence meter**, established from the runtime's own compiled-in
schema rather than by decrypting anything. The endpoints in `smartspectra.dll` are
`/v2/initialize`, `/v2/metrics/authorize`, `/available-usage`, `/sync-usage` and
`/device_keys/{rotate,migrate}`, against one host, `cont-api.physiology.presagetech.com`.
Device identity is an ed25519 keypair. The graph carries a `usage_statistics_calculator`
and a `usage_sync_calculator`.

Its only upload-shaped message is:

```protobuf
package presage.physiology;
message UsageStatistics {
  utc_start_time_epoch
  utc_end_time_epoch
  map<string, MetricUsageStatistics> metrics   // { precision, out_freq, total_datapoints }
}
```

Counts, frequencies and timings — *how much* was measured per metric, never *what*. Every
other Presage protobuf in the runtime is local graph I/O: `Metrics`, `Trace`, `Insight`,
`StatusValue`, `RequestedMetrics`, the point and landmark types. None is shaped like a
request.

That is schema, not wire bytes, and the distinction is worth keeping: it establishes that
no measurement-upload schema exists in the binary, not that no such payload could ever be
built at runtime. It agrees with the traffic measurement from the other direction, which is
what makes it load-bearing.

So the position is: the app writes and reads check-ins locally and uploads none of them,
the frames are processed on this machine and are not sent, a licence meter reports session
times and per-metric datapoint counts, and the capture cannot run offline. *When* the meter
reports is only partly known: a complete `UsageStatistics` carries the session's end time,
so it can only be sent at or after the end, and what the connections opened every five and
fifteen seconds *during* a capture carry — quota polls, incremental syncs, keepalives — is not
established. Phase 4 and 5 plan around all of this, so it belongs in #32 and #36 rather
than being discovered when sync is designed.

Intercepting the TLS with a proxy has not been tried, and whether the native runtime would
accept a proxy's certificate is unknown. It is the direct test of the gap above — what the
bytes are, not what the schema permits — and it is deferred rather than dismissed: two
independent lines of evidence are enough for the plan as it stands. If the gap ever matters
more than it does now, a proxy run or an answer from Presage is how it closes.

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

## Why a failed capture is still a check-in

A camera reading that produced nothing is a fact about the day, and the history has to
carry it (KV-7). The alternative — discarding it — makes a day the person sat down for
look exactly like a day they did not, and nobody can tell the two apart afterwards.

So an unusable capture goes through the questions like any other and is stored with
`insufficient-signal` as its verdict. The answers were still given; what is missing is the
measurement, and the card says which.

This matters more the further away the caregiver is. From the same room, a failed capture
is visible — someone watched it happen. From three hours away, a discarded one is
indistinguishable from silence, which is what #44 is about.

**The failures that are not this.** No API key — or a key the service rejects — is setup;
a camera another application is holding is hardware; and an SDK failure a lost connection
could explain, on a device that was offline when the capture started, is the connection
(KV-104). None is about the person, none is stored as a check-in, and each says so in its
own words rather than arriving as a raw error string. `core/capture/failure.ts` tells them
apart by a tag carried inside the message, because an Error crossing IPC keeps nothing
else. The tag is also what keeps a *rejected* key from being reported as a busy camera: the
SDK only discovers it at session start, so it arrives on the same path as a real camera
fault and is told apart by the SDK's own error code, not by the call site guessing.

Being offline does not make every failure the connection. Only the codes a connection could
produce are relabelled; a camera held by a video call is still the camera, offline or not,
because naming the connection over it would send someone to reconnect only to be told about
the camera on the next try. And a capture the SDK fails outright is not stored on any path,
offline or not, whatever it had measured by then — that has not changed.

**The connection also took one case from the other side, and that is an open cost.** A
capture that starts with the device offline, runs to its ceiling and measures nothing a
rule can read was stored as `insufficient-signal` until KV-104; it now reports the
connection, and nothing is stored. The card it would have shown — "the camera ran but no
reading came out" — named the wrong cause, on the one path where the SDK said nothing and
the network was the likeliest reason. But that argues for a different card, not for losing
the day, and the day is lost: the person sat down, the camera ran its whole ceiling, and
because the capture now fails they are never asked the questions either, so the answers a
stored `insufficient-signal` check-in would have carried are gone too. That is the thing
this section argues against. It is left open with the expired reading below, and belongs
with #44. A capture that ran to its ceiling and measured anything a rule can read is still
stored and judged like any other.

**An expired reading is none of those.** It is a timer, and grouping it with setup,
hardware and the connection hides the harder question: the person sat down, the camera
measured well, they answered, and a clock ran out. Today that day is discarded, which is the
very thing this section argues against. The TTL itself is right — a reading must not
be stored beside answers about a different moment — but "these two cannot be one check-in"
is not the same as "neither exists". Left open deliberately, and it belongs with #44.

---

## Why a JSON file and not SQLite

One record per person per day. At that size a single JSON file is not a compromise — it is
the correct amount of machinery, and it avoids rebuilding a native module against
Electron's ABI, which is a genuine way to lose an afternoon.

Writes go through a temp file and a rename, so a crash mid-write cannot truncate the
history. Losing one day's check-in is recoverable; losing the baseline that every
comparison depends on is not.

**A file that exists and cannot be parsed is refused, not recovered from.** `read` raises
`UnreadableStoreError`, and because `append` is read-modify-write, that refusal is what
keeps the history intact: a read answering "empty" for a file it could not parse would push
one record onto nothing and rename that over the original — losing everything on the one
path where the app already knew something was wrong. It is also the
reassuring-and-wrong direction this product avoids everywhere else. Someone with months of
check-ins would be shown none, with nothing to say anything was amiss.

The cost is real and worth stating plainly: this is **fatal to reads and writes both**, so
until the file is moved aside no history can be shown and no new check-in can be stored.
`submit` reads history before scoring, so a corrupt file is discovered *after* the capture
ran and the questions were answered — which is why the error is tagged `store-unreadable`
rather than left to classify as `unknown`, whose copy invites a retry that cannot succeed.
Two cases are deliberately not refused: a **missing** file, which is the ordinary first run,
and a **zero-byte** file, which is the one corruption holding no history to protect.
Offering the person an explicit way out — quarantine the file and start a new history,
rather than asking them to find a path inside `userData` — is #98.

**An older build refuses a newer file outright, and there is no migration path.** The
file's `version` is read, not decoration: a version this code does not write is refused
with a message naming both. That makes bumping `FILE_VERSION` a one-way door — anyone who
downgrades afterwards is locked out of their own history until the file is moved aside.
That is the deliberate choice, on the grounds that misreading a newer file as though it
were this one is the quieter and worse failure, but it is a real contract and the cost
lands on a person, not a developer. A migration, when one is needed, is #30's to design,
and it will need a version per record rather than per file.

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

The label has to cover the verdict as well as the records, because the dashboard always
records against the demo persona, so a real capture taken after seeding is compared with
the invented fortnight — which clears `MIN_BASELINE_SESSIONS` on its own. That card's
vitals are real. Nothing else about it would distinguish "HRV is 41% below their usual"
computed from measurements from the same sentence computed from numbers nobody measured.

So the baseline carries how many of its sessions were seeded and the assessment carries
that count, which `seededBaselineDisclosure` turns into a sentence wherever the card makes
a claim resting on them — a verdict, or a withheld verdict whose fired rules still quote
"their usual". An unusable capture compared nothing with anything and says nothing. The
count is what is stored rather than the prose, so the wording can be corrected without
rescoring history, and a record written before the count existed reports that instead of
reading as "none": absent is unknown, not zero (KV-53).

The alternative was to drop seeded records from a real session's baseline, which is
cleaner in principle and was rejected for what it costs: seeded records hold no assessment
of their own, so the fortnight exists *only* to be a baseline for a real capture. Removing
it from that role would leave the dashboard with no scored verdict to develop against,
which is the entire reason for seeding.

Seeding still does not solve the underlying problem, which is that a genuine install says
"not enough to say" for its first few check-ins. That is a product question (KV-17), and
seeded data must never be the answer to it. A labelled verdict on a demo persona is a
demonstration of the dashboard; it is not a reading of anyone, and the label is what keeps
those two apart.

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
