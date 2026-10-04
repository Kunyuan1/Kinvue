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

**The window is counted in usable sessions, not days, and has no age bound** (KV-99). It is
the trailing 14 usable check-ins however old. For someone who checks in daily that is a
fortnight; for someone who checks in rarely it can reach back a year, and then a slow
drift — seasonal, or a gradual change in the person — reads as a deviation instead of
moving the baseline with it. That is a known cost, taken deliberately. Bounding the window
by age as well needs a horizon nobody has evidence for yet, and that alone is why it waits
on the calibration #22 will do against confirmed outcomes. It is not that a bound is
dangerous in itself: a *short* one would let a bad fortnight empty an established baseline,
the failure KV-72 removed, but a long one floored so it never takes the usable set below
`MIN_BASELINE_SESSIONS` would not. Only the number is missing. A test with a long, sparse
history pins today's behaviour until then, and the dashboard says how far back the usual
reaches — a card, when its own had gone stale (KV-154, below) —
so the cost is visible to the caregiver and not only written down here.

**Both directions** (KV-9). The question is "does this look like their normal", and a pulse
or breathing rate that falls well below their usual is as much an answer as one that rises.
Until KV-9 only the rise could fire: a real check-in with a pulse of 80 against a usual of 97
(compared, `n` of 5) produced nothing, and a person whose usual drifted upward got an app
that stopped noticing them come down. So `pulse-low` and `breathing-low` mirror the rules
for a rise, with the same threshold (z ≥ 2), curve (full at z ≥ 4) and peak weights. That
avoids inventing numbers only calibration (#22) can supply. The mirroring is exact, so it
cuts both ways: that same 80, at z of about −1.2, still fires nothing, as +1.2 would not.

HRV stays one-directional, and that is a different kind of reason, not an exception to the
first. A pulse or breathing rate is compared as "their normal" because either direction away
from it is a change a caregiver would want to see, and nothing about the number says which
way is worse. HRV is not read that way anywhere in this app: `hrv-drop` exists because falling
HRV tracks stress, illness onset and poor sleep, and a rise carries no such reading. So its
direction is part of what the rule means, where for the rates the direction is only which
side of their usual the reading landed.

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
| Nothing measured | *"The camera ran but no reading came out of it, so this check-in is not being compared."* |
| Capture too short | *"The camera did not run for long enough to use, so this check-in is not being compared."* |
| Nothing rated it | *"The camera did not say how reliable this reading was, so this check-in is not being compared."* |
| Rated, and poor | *"The camera reading was not clear enough to use, so this check-in is not being compared."* |

Each states its own consequence rather than describing the failure and stopping — the
consequence is the part a caregiver acts on. The reason is picked in that order, which is
not the order of the thresholds: a capture cut short is reported as short even when it
also arrived unrated, because the duration explains the missing rating and is the one
thing the person in front of the camera could have done differently.

The verdict is withheld; the reading is not. The rate is still shown, because it is real
— what is withheld is the comparison against their usual, which is the part that would
treat an unvouched-for number as reliable.

**That rule is capture-wide, and one level down it had a hole** (KV-79). A capture's
confidence is the average over the metrics that reported one, so as soon as *one* metric was
rated the capture counted as rated, and an unrated metric beside it rode on that number: a
pulse rated 0.9 carried a breathing rate nothing had rated past the gate and into
`breathing-elevated`, which quoted it to the caregiver. So once either rate is rated, each
rate reports its newest reading that carried a confidence **of its own** — asked of the
reading, not the metric, since a metric that rated one reading and then sent a bare one would
otherwise report the bare value on the other's number — and a rate with no such reading is
dropped before any rule can see it. **Only when something was rated**: when nothing was, the
rule above stands and the reading is shown with the verdict withheld. A capture where only
pulse was rated therefore becomes a pulse-only capture, and `hasScorableVitals` can now turn
on a confidence judgement, not only on which readings arrived.

HRV is outside this in both directions. Whether an HRV reading ever carries a confidence has
not been seen on this hardware, so it is never dropped — that would remove `hrv-drop` on no
evidence — and, on the same evidence, its rating decides nothing: it neither triggers the
drop nor counts in the capture's confidence, which would otherwise delete a real pulse and
breathing rate or carry them into a rule on HRV's number. Whether a metric whose own
confidence is *poor* should be dropped too is a separate, threshold question, and still open.

A dropped rate shows as `—`, the same as one the camera never produced, and #87 does not
name it either: it was not measured, so it is not a gap in the comparison. That is accepted,
not solved — the mirror of inventing a number is silently erasing one. And it compounds,
through the per-metric gate below (KV-71): on hardware where breathing habitually arrives
unrated beside a rated pulse, breathing's own `n` never reaches
`MIN_BASELINE_SESSIONS`, so breathing is never compared at all, and nothing on screen says
so. That is the intended outcome — a usual should not be built from readings nothing vouched
for — but it is silent, and it is also the capture that runs to `DEFAULT_CAPTURE_SECONDS`
every time, waiting for a rating that does not come.

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

**What KV-71 did not reach was the verdict** (KV-87). `flag` is a sum of the rules that
fired, and a rule held back contributes nothing — so a card read *"Looks normal — A normal
day for them"* on a real check-in whose pulse was 101.5 against a usual of 82, because pulse
had two readings of its own and three are needed. The rule was right not to fire; "Looks
normal" is still an active claim that the check-in was compared with their usual, and for
pulse it was not. That is the reassuring-and-wrong direction, reached by suppressing a
comparison rather than by making one. And it is the ordinary state of a young baseline on
this hardware, not a corner: pulse arrived in three captures of five and HRV in none.

So a metric **measured at this check-in** with no usual — the same `canBeCalledUsual` that
holds its rule back, asked from the other side — changes the verdict:

| Would have been | Now | The card says |
|---|---|---|
| `normal` | `insufficient-signal` | "Only partly compared with their usual", then which metric, how many readings it had of how many needed, and that the check-in is therefore not being called normal |
| `elevated` | `elevated`, unchanged | the same gap, without the last clause |

`elevated` stands because it rests on what *was* compared: withholding it would hide an
answers-only amber — pain and no food — whenever pulse happened to be thin, trading a real
signal for a missing one. A metric that produced **nothing** at this check-in changes
nothing; it is not a gap in the comparison. An unusable capture or a baseline still learning
writes nothing either, since its summary already says nothing was compared.

`Assessment.uncomparedMetrics` stores the metric, the two counts and what the thin history
averaged, and `uncomparedDisclosure` composes the sentence where the card is shown, as the
seeded disclosure is — the wording can change without rescoring history. A verdict scored
before KV-87 has no such field, and says that it was not recorded rather than reading as
"none". A withheld verdict still claims a comparison of the other metrics, so the seeded
disclosure shows on it too, whether or not a rule fired.

**The thin history's average is quoted, as evidence and not as "their usual".** The card
already shows *Pulse 102 bpm*; a sentence giving only "2 of the 3 readings" withholds the one
number that makes 102 mean something. So it reads *"it had 2 of the 3 readings needed to
know it (those 2 averaged 82 bpm)"*. That is not what KV-71 forbids. KV-71 forbids calling a
two-reading mean *their usual* — "above their usual 82 bpm" off one morning. Stating the
evidence and its weakness in one breath is the opposite claim, in the same idiom as the
seeded disclosure. A single reading is quoted as that reading, not as an average.

**Which metric a rule compares is stated once, on the rule** (`Rule.compares`). The seeded
disclosure's rule set (`BASELINE_RULE_IDS`) and the gaps (`uncomparedMetrics`) are both
derived from it, so a new comparison rule cannot reach one and miss the other: missing the
second would reopen this ticket's hole silently, with a green card and no note. The gap test
is `canBeCalledUsual`, the gate every comparison rule passes first — not every guard after
it. A rule can still decline past that gate (`zRule` on a spread of 0, `hrvDrop` on a usual
mean of 0), and such a reading is neither compared nor named. That needs a usual of exactly
0. Closing it properly means `Rule.evaluate` reporting "could not look" apart from "looked
and found nothing", which is a change to every rule, not to this.

---

## Why no sentence on a card says "today"

Every sentence the scorer writes — the summary, and each fired rule's title and
explanation — is frozen into the record when the check-in is scored, and shown later under
the card's date. So "Pulse was 95 bpm today" beneath "Sat, Sep 12" is false a week on, in
the one place meant to be read literally (KV-93). None of them says when relative to now:
the card's date says when, and the answer rules anchor to "the check-in" ("At the check-in
they reported being in pain") so that a reported answer still reads as something said that
day, not a standing fact. A test fails on any relative time word in any of them.

The alternative was to keep the copy date-free and have the card add "today" when the
check-in really was today in the person's zone — `localDateOf` can prove that. It reads
more naturally on the one card most often looked at, minutes after the check-in, and that
is its real advantage. It was not taken: every sentence would need a with-today and a
without-today form, some of them composed in the renderer rather than in `core/`, and the
date-free form is true on every card, including today's. New card copy follows the same
rule — #100's "still learning" sentence included.

### What an old card says once the scorer has changed (KV-138)

KV-93 fixed the words for cards scored after it. A card scored before kept saying "Today
looks like a normal day for them" under its date. And more than wording could be stale: a
stored assessment was shown exactly as stored, forever, so every later fix to what a card
*claims* — KV-9's falls, KV-72's refused captures, KV-79's unrated readings, KV-87's
uncompared metrics — skipped every card already there.

Decided by the owner: **the verdict stands, the words are composed now, and drift is
said.** `present` (in `core/scoring`) builds what a card shows:

- **The flag and the fired rules are kept as scored**, severities included. They are what
  the app told the caregiver that day, and history stays a record of that.
- **The summary is composed from facts the record keeps** — flag, fired rules, baseline
  count and, for a withheld verdict, *why* it was withheld — by the one function
  `scoreSession` writes it with, so a card scored now composes to exactly what it stored by
  construction, not by a mirror kept in step by hand. The reason is stored
  (`Assessment.withheld`) rather than asked of today's predicates, which can give a
  different reason under the same flag: a card stored as "still learning" must not start
  saying the camera gave an unrated reading. A record from before the reason was stored is
  read from what it kept — its gap list, or its summary, one of a closed set of sentences
  kept verbatim for this. The scaffold's one catch-all sentence names no single reason, so
  it is kept as written, less its "today", and drift asks only whether today's scorer would
  still call the capture unusable.
- **Rules are reworded, never re-decided.** An answer rule that still fires on those
  answers is evaluated again for its words. Anything else — a comparison rule, whose usual
  is not stored, or a rule today's engine no longer fires or no longer has — keeps its own
  text, run through a frozen table of exactly what KV-93 changed, and the one " today,"
  KV-93 removed from comparison explanations.
- **When today's scorer would say something different, one line says so**: a different
  verdict ("Scored again now, it would read “Not enough to say”, because there was not yet
  enough history to compare it (1 of 3 usable check-ins before it)"), the same verdict with different rules ("…it would also note slept poorly"),
  or the same withheld verdict for a different reason ("…it would say instead: “…”"). The
  second is not optional: a rule that fires or stops firing changes what a card says even
  when the flag does not, and on the owner's history two cards drift only that way.
  Rescoring uses the same person's check-ins before the card, so it compares against the
  same history it had. The line states that observation and no cause: today only a rule
  change produces it, since history is append-only, but a restored backup would too.

  **A card with no drift line is not stale, and that is checked, not assumed.** The card
  that raised this read "Looks normal" on a breathing rate of 5.4, and the ticket assumed
  today's scorer would flag it. It does not: its history holds one reading of 39.8, which
  widens the spread to 7.8, so 5.4 against a usual of 15.9 is about 1.35 spreads out, short
  of `Z_FIRES_AT`. That is a question about one outlier and the spread, not about old
  cards.
- **KV-87's "was not recorded" note** no longer sits on every pre-KV-87 card. The gaps are
  found by scoring the card again against the same history, and the note appears only
  when there is one.
- **Seeded cards are scored as they are shown** (KV-103) inside `present` itself, so no
  caller has to have done it first and a seeded card never drifts.

Not done, deliberately: rescoring on display and showing that instead. A past verdict
would then change after a caregiver had read and acted on it, and history would stop
being a record of what was said.

### A card still learning describes its own check-in (KV-100)

The still-learning sentence was a live status — *"2 of 3 check-ins needed before daily
comparisons start"* — stored in the record and shown under its date forever. Read newest
first, it sat at the bottom of a dashboard, under every card that had since compared. It
now says what that check-in had: *"Not yet enough history to compare this check-in (2 of 3
usable check-ins before it)."* Where the person is *now* belongs in one live place, the
dashboard header (#17). Older cards get the sentence too, composed from their stored count
by KV-138's display-time composition, and the drift line quotes it.

The count is of **usable** check-ins since KV-72, which was right for the mean and hid the
refusals: someone who had done six check-ins was told two. So the refusals the baseline
left out are counted (across the whole history, not the window) and stored beside it, and
the card says so — *"4 check-ins before this one could not be used, so they are not
counted."* Check-ins rather than "camera readings", since a capture that measured nothing had
none; "before this one" rather than "earlier", which KV-93's guard bans.

**Why on the card, when the live count moves to the header.** The clause explains the
card's *own* number, which is frozen with it: "2 of 3 then" is a fact about that check-in,
and so is how many refusals sat behind it. The live question — why the count *today* is
lower than the check-ins done — is #17's header's to answer, from the same stored fact.

**One number for four reasons**, where `UNUSABLE_SUMMARY` insists on telling them apart.
That rule is for the refused card itself, which says which failure happened; the count sits
on a *different* card and only has to say that some check-ins did not count. Each of them
still says why on its own card, further down.

A card scored before the count existed says nothing about refusals: unknown, not "none".
Its drift line treats the count as unknown too — it compares against today's sentence
without the refusal clause — so a record's missing field is never reported as the scorer
answering differently.

### How far back the usual reaches, and when a card's had gone stale (KV-154)

The window is the trailing 14 usable check-ins however old (KV-99), so "their usual" can
mean the past fortnight, the past year, or a fortnight that ended months ago — and nothing
on screen said which. Bounding the window by age waits on #22; *showing* it needs no tuned
number, since it is the `capturedAt` range of the window the code already has. The
baseline records it (`span`), and each assessment stores it (`baselineSpan`).

Two facts, said in two places — decided by the owner in review of #158, after the first
version put one sentence on every card:

- **How far back the usual reaches is said once, live, in the dashboard header** — *"Margaret's
  usual is the last 14 usable check-ins reaching back 6 weeks."* (`usualReachStatus`),
  once comparisons have started and it reaches past four weeks. At a regular cadence it is
  the same on every card — twice a week puts the fourteen over six weeks for good — so a
  line on each card would be sixteen copies of one fact, and stop being read.
- **A card says so only when its own usual had gone stale** — *"Their usual here is 14
  check-ins, the most recent of them 8 months before this one."* (`staleUsualDisclosure`) —
  when the gap before that check-in is past four weeks *and* longer than the stretch the
  usual itself covers. That separates the case the ticket exists for, fourteen daily
  check-ins in January compared with one in September, from fourteen spread over the same
  months, which one "reaches back" distance could not. A regular cadence never meets it:
  monthly check-ins leave a month's gap after a year-long usual.

- **Four weeks** (`USUAL_SPAN_NOTE_AFTER_DAYS`) is twice the fortnight the window stands for
  with daily check-ins. It decides only whether a line appears; nothing is scored or
  withheld differently, so it is a presentation choice rather than #22's horizon.
- **Worded never to overstate, and to say a year as a year**: weeks under two calendar
  months, whole calendar months under a year, then "over a year". A card's note is measured
  from its check-in, so it holds under the card's date; the header's to now.
- **An older card** gets its span by scoring again against the same history, as its gaps do
  — only when that rescore counts the sessions the card did. Otherwise the history has
  changed under it, and a stored count beside a rescored span would be a pair that never
  held; nothing is said.
- **Not on a seeded card** (KV-103), not where nothing leaned on the baseline, and not when
  every check-in behind the card was seeded — the seeded note already says so, and the
  stale note would count invented check-ins as check-ins. Where both appear, the stale note
  comes second, as the *when* to the seeded note's *what*.

### Where the baseline is now: one live line, and a label of its own (KV-17)

A real person checking in twice a week waits over a week for three usable check-ins, and
until then the dashboard said only "Not enough to say" — the same words as a capture the
camera could not use. Decided by the owner, and adjusted in review:

- **One live line at the top while the baseline is learning** — *"Still learning
  Margaret's usual — 2 of 3 usable check-ins so far."* — computed from the history as it
  is now (`learningStatus`), so it is never stale. It is the one place that says where the
  person *is*; every card says only what its own check-in had (KV-100). It also answers the
  live half of KV-100's question, when some check-ins could not be used: *"4 check-ins
  could not be used, so they are not counted."*
- **It stays through 3 of 3.** Comparisons start with the check-in *after* the third
  usable one, so at 3 of 3 nothing has been compared yet; the line says *"Margaret's usual
  is ready — 3 of 3 usable check-ins so far. The next check-in will be the first compared
  with it."* and goes away only once one has been. Nothing for a person with no check-ins,
  where the seed prompt is the page, and never on seeded data: the demo seeds twelve
  days, so a seeded store is always past it.
- **A card withheld because the baseline was learning is labelled "Too early to
  compare"**, not "Not enough to say". The owner's ticket said "Still learning"; review
  moved it, because the label is shown under the card's date for good and "still
  learning" is a claim about the app *now* — the failure KV-100 removed from the sentence
  beneath it. "Too early to compare" is a fact about that check-in, as "Looks normal" is.
  "Not enough to say" now heads two things: a check-in whose capture could not be used,
  and one only partly compared because a metric had no usual of its own (KV-87), whose
  summary and note say which. The label comes from the stored reason (KV-138's
  `withheld`, or an older record's summary); a card whose reason cannot be recovered keeps
  "Not enough to say". The drift line compares and quotes the labels, not just the flags.
- **The card counts "before it"**, the header "so far": *"(1 of 3 usable check-ins
  before it)"* under a header reading *"2 of 3 … so far"* is two counts of different
  things, said so, rather than resting on the word "then".

---

## Why the trend is a view of the baseline, not a second opinion (KV-4)

A card says whether one check-in looked different; what a caregiver cannot do by eye is see
the weeks around it. The dashboard draws one metric at a time — pulse, breathing rate or
HRV, chosen above the chart — over the window the latest usable check-in was scored
against, with that check-in marked and the usual it was compared with drawn behind it.

- **It draws what the scorer used, from the same code.** The points are
  `baselineWindow` of the check-ins before the latest, exported from `core/baseline` so the
  window has one definition; the line is `computeBaseline`'s mean for them, drawn only where
  `canBeCalledUsual` would let a rule quote it. So the chart never shows a usual the card
  below declined to use (KV-71), and its label is rounded the way the rules round, so it
  quotes the card's number. Where there is no usual yet it says so under the chart, per
  metric — HRV routinely has fewer readings than pulse — which is #17's constraint.
- **What is not a point says so.** A capture the scorer refused is left off — a point on a
  line has no "not being compared" beside it, the way its card does (KV-12) — and counted
  in a sentence. A check-in that did not measure the metric is a gap, never a zero. Seeded
  days are hollow, with a key, and counted: never plotted as if measured (KV-8).
- **What the chart spans, and what it counts, follow what is drawn** (review of #162). The
  title counts readings and check-ins apart — *"HRV, ms: 3 readings over the last 14
  check-ins."* — since they differ whenever a metric goes unmeasured, and says "at the latest
  check-in" only when the one reading is the latest's. "The last" and "the latest" are said
  only while no check-in in the stretch or after it was refused; otherwise the title counts
  *"5 check-ins that could be used"*, since the last 5 usable are not the last 5 (second
  review of #162). Refusals are counted from the first point drawn to the latest, so the
  number follows the metric on screen; a lone first point looks back to the check-in before
  it, since a first week of failed captures is exactly when the chart must not be silent. **A refusal newer than the latest point is said first**: the
  chart is read before the cards, and its newest point is then not their newest check-in.
- **The usual is still drawn when the latest check-in did not measure the metric**, though
  that check-in's card says it could not be compared (KV-87). Considered in review of #162
  and kept: the line is a fact about their history, not a comparison the chart is making,
  and the note under it says the latest was not measured — a missing reading is not drawn as
  one near the usual.
- **A band where nothing is flagged is drawn, and the scale never shrinks inside it**
  (KV-165). Scaled to the window alone, a calm fortnight (pulse 71 to 74 around 72, where
  nothing fires until about 3 bpm out) filled the plot top to bottom under a card saying "A
  normal day for them": the amber-versus-red argument, made in pixels. The band is where a
  reading falls with no comparison rule firing, built by `usualRangeOf` in `rules.ts` from
  the rules' own constants: the usual ± 2 of the floored spread for pulse and breathing, and
  for HRV, whose only rule is a drop, from 25% below the usual upward. There is none where
  the rules would not run.
  - **Labelled for what it is, not "usual"** (review of #168): *"pulse not flagged between
    67 and 75 bpm"*, *"HRV not flagged at 26 ms or above"*. The line already spends "usual"
    on the mean, and for HRV "usual" would call 500 ms typical. The numbers are rounded
    inward, so every one named fires nothing; rounded to nearest, the demo's key named 76 bpm
    while a card called 76 above usual.
  - **It is the latest's.** The latest point is inside exactly when no comparison rule fired
    on it. Every other day was scored against the check-ins before its own day, so its card
    can disagree with where it sits (seen on the demo). A note says so, with the count, only
    when a day on the chart actually disagrees; drawing a band per day would be noise.
  - **Quiet, with edges that can be seen.** The fill is background; its dashed
    `--color-muted` edges carry the contrast (over 6:1, where the fill alone was 1.12:1).
  - **The axis always reaches the whole band.** Before there is a usual it uses
    `narrowestRangeAround` the points (±4% for pulse and breathing, ±25% for HRV), so a
    baseline still being learned is not drawn louder than a mature one. Ticks are whole
    units, three to five where a step gives that, otherwise as many as keep three or more.
  - It is worked out from the same history as the usual line, so it does not settle #94,
    which is about the card's words and waits on a real card.
- **Severity is not plotted.** The flag is not a number; the metric is.
- **Placed by date**, so a gap in the check-ins shows as one (KV-154's stale usual, drawn).
- **Shaped in `core/trend`, sentences included**, because the caregiver's own client (#42)
  needs the same series and will not run this renderer. So are the value axis
  (`axisTicks`) and every word and number on it: the reading's label, unit and rounding
  (`READING_LABEL`, `READING_UNIT`, `readingText` in `core/scoring`) are the card's readings
  row's too, so a chart never quotes 74.6 beside a card saying 75, or "breaths/min" beside
  "br/min" (review of #162). A date is shown in the zone it was taken through `knownZone`,
  which every such reader uses: an empty or unknown zone makes `Intl` throw, and the chart,
  drawn above the cards, would have taken them with it. The renderer only draws: a small
  hand-written SVG rather than a chart library, keeping the runtime dependencies at three
  (decided by the owner), with a hover readout and a table view of the same points.

---

## Why the answers may raise a flag on their own

Decided in KV-10: **a day can read `elevated` on the answers alone, with nothing wrong on
camera.** This is not the shortcut the section above rules out. That one is about a capture
that *failed*, where scoring the answers and calling the day `normal` would misstate what
was measured. This is about a capture that *worked* and saw nothing unusual.

Six of the thirty-six answer combinations do it today, and every one includes pain; five
of the six are pain with a meal skipped. A person in pain who has skipped a meal is having a day
worth a look whatever their pulse was, and the camera cannot see either. `elevated` means
"worth a look", not "something is wrong with their body", so a flag that rests on what they
said rather than on what was measured stays inside both lines the product does not cross:
it names no condition, and it is not an alert.

What made this a decision rather than an accident is that it is now pinned.
`tests/scoring.test.ts` lists the six combinations that flag, so a weight change that adds
or removes one fails a test and has to be argued for. The weights themselves are still
judgement (#22).

**Poor sleep weighs, lightly** (KV-91). Until then, "slept poorly" without pain produced
nothing at all: no severity and no line on the card. `poor-sleep` now fires at 0.05, and
that weight does two different things:

- **It adds no answers-only flag.** Without pain the answers reach 0.5 at most, so under
  0.1 it cannot; the six combinations above are still six.
- **It can tip a day the camera already has near the line.** The scorer sums every fired
  rule, camera ones included, so a day whose other rules sum to between 0.55 and 0.6
  becomes `elevated` when they also slept poorly — an HRV drop of about 46–49% against
  their usual, for instance. That is intended: a real drop plus a bad night is a better
  amber than the drop alone. A test pins the band, both that it exists and that nothing
  below it moves.

It also changes the card's headline on a day where it is the only thing that fired: "Broadly
normal, with one or two things worth noting" rather than "A normal day for them", as any
fired rule does.

That made *one* answer visible, not the question. "Slept well" and "slept ok" still fired
nothing, so a card with no sleep line could not tell them apart — or from a record written
before this rule existed. Making an answer visible by giving it a rule also gives it weight,
which is the wrong tool for the job.

**So every card now shows all four answers, apart from the rules** (KV-110): *"Answers:
mood all right · sleep badly · skipped meals no · pain no"*. The answers are shown whatever they
were; the fired rules below them say what counted. They are labels, not sentences: sentences
repeated the rule titles word for word on the cards that matter, and "they said" put words in
the mouth of seeded data nobody spoke. The values are the person's own choices from the
questions, with no "today" (the card's date says when), and a stored value the tables have no
words for reads "not recorded" rather than vanishing. `describeAnswers` in
`core/session/answers.ts` writes them, so the caregiver's client will say the same.

That leaves `poor-sleep` without the job it was added for. **It keeps its 0.05 on the case
above, not on visibility**: a bad night tips a camera day already within 0.05 of the
threshold, and cannot add an answers-only flag. `rules.ts` says so beside the weight. If that
case stops holding, the rule can go without hiding anything. `low-mood` and the meal rule never
had visibility as their reason: they were scoring rules from the start, and KV-10 decided
which answer combinations they may flag.

What this does not settle: that the camera finds it much harder to raise a flag than the
questions do. **No single camera rule flags a day except an HRV drop of half or more.** A
pulse or breathing rule carries half its peak the moment it fires at 2 standard deviations
— 0.225 for pulse, 0.20 for breathing — and caps at 0.45 and 0.40 at 4, in either direction
(KV-9). So one rate, however far out, cannot reach 0.6 alone. **Two camera rules together
can**: pulse and breathing each 3 standard deviations out sum to about 0.64, and a quarter
drop in HRV beside breathing at 3 to about 0.62. Both just past 2 sum to about 0.44, and do
not. `tests/scoring.test.ts` pins which camera-only days flag, so this paragraph and the
weights cannot drift apart silently. Whether one large vitals deviation should flag on its
own is the other half of the same balance; #9 answered only the direction, so the magnitude
question belongs with #22.

---

## Why the meal question asks about a skipped meal

Decided in KV-16. The question was *"Have you eaten today?"*, and "Not yet" fired
`not-eaten` at 0.30, the second-heaviest answer rule. At 8am "not yet" is breakfast still to
come; at 4pm it is a day without food. The rule could not tell them apart, so a morning
check-in carried a standing weight that had nothing to do with the person's day.

Two ways out were on the ticket: have the rule read the local hour and hold off before a
cutoff, or change the question so its answer means the same whenever it is asked. **The
question changed**: *"Have you skipped any meals since yesterday?"* A "no" at 8am and a "no"
at 4pm are the same fact, the rule stays a one-line read of an answer, and there is no
cutoff hour, which would have been one more tuned constant for #22 to defend. The context
sits where the person answering can see it rather than inside the scorer.

- **A new field, not a new meaning for the old one.** New check-ins store `skippedMeal`, and
  `skipped-meal` fires on `true`. A real check-in written before keeps `eatenToday`, and
  `not-eaten` still reads it: its verdict stands (KV-138), and "not yet" is not an answer to
  the new question, so it is never converted. `not-eaten` fires only on an explicit `false`
  (absent is not "no"), and never on a record that also carries `skippedMeal`: one question,
  one rule (review of #167). The type, `MealAnswer`, holds exactly one of the two.
- **A seeded day is read as the question asked now** (review of #167). It is generated data,
  and KV-103 already treats its verdict as a view of today's rules; the seed draws
  `skippedMeal` from the same number that drew `eatenToday`, so reading an old seeded record
  as `skippedMeal: !eatenToday` is exactly what a fresh seed writes. The store's `list` does
  it on the way out and never writes it back, so a demo seeded before KV-16 reads the same as
  one seeded since, rather than saying "Had not eaten yet" forever about nobody.
- **Weighed the same, 0.30 — kept, not re-argued.** The case for changing the question is
  that the old 0.30 often fired on nothing, so a skipped meal, a firmer fact, may deserve
  more. The weight stays because KV-10 decided which answer combinations may flag, and
  moving it would reopen that decision inside a wording change. Whether it should move is
  #22's, which owns the weights; until then the six combinations are the same six.
- **The card labels each record by the question it was asked**, with the button pressed:
  "skipped meals yes" or "skipped meals no" from KV-16 on, "eaten yes" or "eaten not yet"
  before it. Not "meals none skipped": nobody chose those words (review of #167).
- The process boundary requires `skippedMeal`: a check-in carrying only the old answer is
  rejected, not quietly converted.
- **`not-eaten` can go** once no real check-in from before KV-16 can be read: when every
  store in use has been started after it, or a migration has moved those records aside.
  Until then it is what keeps an old real card's verdict in its own words.

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

### How much to check before merging an Electron bump (KV-145)

CI never launches Electron, so a green Electron bump proves nothing about the app. Every
one is launched before merging, and a real capture is added only when its vendored Node
or Chromium moved — read from the installed binary, the artifact that ships, with `DEPS`
at the two tags as a cross-check (review of #153) — or on a minor or major release. The
full check is expensive enough that doing it on every patch would get it skipped on the
one that mattered. Why each level is enough:

- **A launch proves the SDK *loads*.** `app/main/index.ts` statically imports `./vitals`,
  which statically imports `@smartspectra/node-sdk`, whose import loads the native runtime
  through koffi — so a window on screen means it loaded. `tests/sdk-load.test.ts` pins
  both imports. **If either is ever deferred, the launch stops proving the load and the
  lighter level stops being enough**; that test fails first so the rule is revisited, not
  silently weakened.
- **The load does not depend on Node's version, for this stack.** koffi ships one
  Node-API binary per platform (`build/koffi/win32_x64/koffi.node`), stable across Node
  versions by design, and the SmartSpectra runtime beneath it is a plain shared library
  loaded over FFI, bound to no Node ABI. Electron's own module ABI
  (`process.versions.modules`, 149 on 44.x) is set by Electron and is not in `DEPS`. So
  `node_version` is not an ABI signal here. **If a non-Node-API native addon ever joins
  the tree, it becomes one**, and this rule must look at `process.versions.modules` too.
- **A capture proves what a launch cannot: the calls, and the frame path.** Only a capture
  calls into the SDK through koffi at run time, converts frames with Electron's
  `nativeImage`, and draws them in the renderer's preview. A `chromium_version` move puts
  the renderer end of that in question — the camera itself is opened by the SDK in main,
  not by Chromium.
- **A `node_version` move is a size signal, not an ABI one.** The point above settles that
  Node's version does not reach the SDK's load or its calls, which go through the same
  Node-API binary. But a patch that vendors a new Node is a larger release than one that
  does not, with more of Electron moved beside it — which is what a capture is for.
- **The frame path's own code is the gap, and it is accepted.** `nativeImage` is
  Electron's code, versioned by the tag rather than by `DEPS`, so a patch can change it
  with both versions identical, and the lighter level never reaches it: with no key there
  is no capture, and no frame is converted. It is accepted because of what a failure there
  costs — a frame the conversion cannot handle costs the preview and nothing else, as
  above, and the reading and its guidance carry on — and because the next real capture
  shows it. When a release's notes mention `nativeImage`, treat it as the heavier level.
- **A launch still catches what `DEPS` cannot see.** 44.4.3 → 44.4.4 changed 239 files
  with both versions byte-identical, one of them the `ready-to-show` fix behind KV-139.
  That is why the lighter level is a launch rather than nothing.

SDK bumps are outside this: every one gets a real capture, checked against the privacy
claims, because a release can change what a capture sends.

---

## Why `core/` has no framework imports

`core/` is plain TypeScript: no Electron, no React, no DOM. **ESLint enforces it** (KV-15):
`eslint.config.mjs` restricts `electron`, `react`, `react-dom`, `@renderer/*`, the
SmartSpectra SDK and **any import from `app/`** inside `core/**`, and `npm run lint` is
part of the check set the pre-commit hook and CI both run.

**And `core/` loads nothing dynamically** (KV-129). `no-restricted-imports` sees only static
forms, so `await import('@smartspectra/node-sdk')` or `require('electron')` walked past it:
lint green, and the suite needing hardware. Deferring the SDK's load is what someone reading
"it loads its native runtime at import time" might reach for, which is what made it the
likely accident. So `import()`, `require()`, `createRequire()` and `import x = require()`
are banned in `core/` outright. That is simpler than listing the banned packages a second
time, and it covers a specifier no list could read, like `import(name)`. `core/` never
needed them.

**The guard is itself tested** (`tests/lint-boundary.test.ts`), because a linter bump that
quietly stopped the rule matching would pass lint with nothing to report. Each banned form is
linted at a virtual `core/` path; controls prove it is scoped to `core/` and that a file which
was never linted is not read as clean; and the resolved config is read back, so a group added
without a probe fails the build.

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

**The Electron security baseline** (KV-29), before the app is packaged (#19) or networked
(Phase 5). The trust boundary is one decision, in `app/main/security.ts`, with no
Electron import so the plain suite tests it: *Kinvue's own page* is the built
`index.html`'s path on this machine (a `file:` URL with no host), and in development the
dev server's `http(s)` origin. It is the only place the window may be and the only frame
IPC is answered for, and the window loads exactly the URL it is checked against. A dev
address that is not `http(s)` or a local file falls back to the built page and says so,
rather than matching on an opaque origin, which once made every URL without one "ours"
(review of #169).

**The dev boundary is deliberately looser.** It matches the whole dev-server origin, so
every path electron-vite serves is "ours", Vite's `/@fs/` route to files on disk included.
That is accepted because it is a developer's own machine running a developer's own server,
and nothing is packaged from it; the built app, which is what anyone else runs, is pinned to
one file. #19 replaces `file://` with a custom protocol, and the dev branch is worth
re-reading then.

Verified in the running
app, dev and built, by driving the page over a debugging port: the sandboxed preload
loads and IPC is answered; `require` and `process` are undefined; `window.open` returns
null; camera access is refused; and a page sent to another origin stays where it was.

Electron's security checklist, item by item:

| # | Item | Here |
|---|---|---|
| 1 | Only load secure content | Done: only the local page. There is no remote content to load. In development that page is a plain-`http` local origin, the looser case above. |
| 2 | No Node integration for remote content | Done: `nodeIntegration: false`. |
| 3 | Context isolation | Done: `contextIsolation: true`. |
| 4 | Process sandboxing | Done: `sandbox: true`, and `app.enableSandbox()` for any renderer that ever exists. The preload needs only `contextBridge` and `ipcRenderer`, and bundles the rest. A lint rule holds the window's security options to literals across `app/main/`, and `tests/security.test.ts` checks both are there, from the syntax tree. |
| 5 | Handle permission requests | Done: every request and every check is refused. The camera runs in main through the SDK, and the self-view reaches the page as pictures over IPC. |
| 6 | Keep `webSecurity` | Done: never turned off. |
| 7 | Content Security Policy | Done: `default-src 'self'` in `index.html`. `style-src` allows inline styles, which the charts' positioning uses. |
| 8 | No `allowRunningInsecureContent` | Done: never set. |
| 9 | No experimental features | Done: never set. |
| 10 | No `enableBlinkFeatures` | Done: never set. |
| 11 | `<webview>` without `allowpopups` | Not applicable: no `<webview>`, and `will-attach-webview` refuses one. |
| 12 | Verify `<webview>` options | Not applicable, as 11: none may be attached. |
| 13 | Limit navigation | Done: `will-navigate` (the main frame), `will-frame-navigate` (any frame) and `will-redirect` refuse anything not Kinvue's own page. A subframe is also refused by IPC and held by the CSP. |
| 14 | Limit new windows | Done: `setWindowOpenHandler` denies all. |
| 15 | No `shell.openExternal` on untrusted content | Done: not used. A future link out must pass a fixed allowlist, not a URL from the page. |
| 16 | A current Electron | Done: pinned exactly, and each bump arrives alone and is launched before merge (KV-131; "How much to check before merging an Electron bump", KV-145). |
| 17 | Validate the IPC sender | Done: every handler is registered through `handle()`, which answers only the main frame (by identity, `event.sender.mainFrame`) of Kinvue's own page. A lint rule over all of `app/main/` refuses any other use of `ipcMain` (`handle`, `handleOnce`, `on`, `once`, a renamed import, `electron.ipcMain`), and `tests/lint-main.test.ts` checks it still fires. |
| 18 | Avoid `file://`, prefer a custom protocol | **Not done: #19.** The built page is `file://`, and the navigation and sender checks pin it to one exact path. A custom protocol changes how the built app loads its own files, so it belongs with packaging, which owns that. |
| 19 | Electron fuses | **Not done: #19.** Fuses are flipped on the packaged binary, and there is none yet. |
| 20 | Do not expose Electron APIs to untrusted content | Done: the preload exposes named calls only (above), never `ipcRenderer` itself. |

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
the app that changes nothing, since either way a capture needs the network. For #36 it
means two obstacles to offline use rather than one: a model that is not kept between
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
established. Phase 4 and 5 plan around all of this, so it belongs in #36 rather than
being discovered when sync is designed. (#32 decided what Kinvue itself sends to a viewer,
under *What leaves the device*; the SDK's own traffic was never in its gift.)

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

**A failure with no tag names no cause, and advises no retry** (KV-80). Every SDK call sits
inside a path that decides what its failure says, and every one that touches the camera or the
service is tagged with its own sentence. Setting the SDK up — the constructor and the event
registrations, before anything has asked for the camera — is mapped separately
(`setupFailure`): an account code says the app is not set up, and anything else stays
untagged, since naming the camera there would name a device nobody had opened. So what reaches
`unknown` on the capture screen is a fault inside the app: its own code, a tag that belongs to
the questions screen, or the SDK failing to be set up. None of that is the camera, and none of
it is cleared by trying again.

It used to say "Something went wrong with the camera. Trying again is worth a go." — a
confident wrong cause to the person being filmed, and wrong advice beside it. It now says that
something went wrong inside the app, that nothing is wrong on their side, and that whoever set
it up may need to look. A cause belongs in its own tagged entry, never in the one for having
none. A setup failure also tears the constructed session down, since the SDK warns that
`destroy()` owns process-global state and an undestroyed session could fail the next capture.

**A stop is the one rejection that does not cross IPC as a rejection** (KV-89). Electron logs
every rejection from an `ipcMain.handle` handler as "Error occurred in handler" with a stack
trace, so pressing Stop — the one thing the capture screen invites — printed ten lines of
fault, directly beneath the `[capture] camera release` line #86 added so a stuck camera would
be visible, on the path where that line is likeliest to matter. `checkin:capture` therefore
resolves a cancellation as a value (`app/shared/capture-reply.ts`) and the preload turns it
back into a rejection carrying the same tag, so the screen classifies it exactly as before —
though the rejection is a bare `Error` now, not Electron's `Error invoking remote method …`
wrapping. Only cancellation: every other capture failure is a fault and still reaches the log as one.
Making every failure a value would change the contract of every handler and hide the faults
the log exists for; what `app/main` logs, and where, is still #86's open question. The module
sits in `app/shared/`, not `core/`: it exists because of how Electron logs a handler, which is
not a domain concern, and `core/` is meant for clients that have no `ipcMain` (#38).

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
until a new history is started no history can be shown and no new check-in can be stored.
`submit` reads history before scoring, so a corrupt file is discovered *after* the capture
ran and the questions were answered — which is why the error is tagged `store-unreadable`
rather than left to classify as `unknown`, whose copy invites a retry that cannot succeed.
Two cases are deliberately not refused: a **missing** file, which is the ordinary first run,
and a **zero-byte** file, which is the one corruption holding no history to protect.
**The way out is the caregiver's choice, and it keeps the bytes** (KV-98). The dashboard
offers *Start a new history* under the store's sentence, for an unreadable file only. It
sets the file aside beside itself as `sessions.json.unreadable-<local date>` and names where
it went. Setting aside is an exclusive copy followed by removing the original, not a rename:
`rename` silently replaces whatever is at its destination, and the copy fails instead, so an
earlier set-aside file can never be overwritten (`-2`, `-3` for more the same day). A plain
note, `sessions.json.unreadable-README.txt`, is written beside them once, so they still mean
something after the notice on screen is gone.

It is never automatic — code that quietly set a file aside would be the silent-empty
fallback this section rejects — and it re-checks at the press: a file that has become
readable since the error was shown is left where it is, and the dashboard says so. A press
that fails leaves the button on screen, since the history is no less unreadable than before.
Three cases get no button. A file that cannot be opened at all (`UnreachableStoreError`,
KV-95), because whatever holds it may hold it against a move too. That reasoning is right
for a file another program has open, which does clear by itself; it is not right for a broken
permission — `EACCES` after a restore, say — which does not, and whose only pointer is the
sentence's "its permissions may need checking". If that turns up in practice it wants its own
tag and a way out; it is not assumed away here. A history written by a
**newer version** of the app (`NewerStoreError`), because it is a whole history rather than a
broken one: set aside, it would be stranded, since the newer version installed again would
find no file and start from nothing. And anything untagged. The set-aside file is not
offered back; it is left for someone technical to look at.

**An older build refuses a newer file outright, and there is no migration path.** The
file's `version` is read, not decoration: a version this code does not write is refused
with a message naming both. That makes bumping `FILE_VERSION` a one-way door — anyone who
downgrades afterwards is locked out of their own history until they install the newer
version again. The dashboard says so, and deliberately offers no *Start a new history* for
it (KV-98): the file is whole, and the newer version reads it as it is.
That is the deliberate choice, on the grounds that misreading a newer file as though it
were this one is the quieter and worse failure, but it is a real contract and the cost
lands on a person, not a developer. KV-30 decided there is no migration that rewrites
records: each record now says its own format, and a history holding one in a format this
build does not know is refused the same way as a newer file — see *What a record carries on
its own*.

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
cleaner in principle. It was rejected when seeded records held no verdict of their own, on
the grounds that the fortnight then existed *only* to be a baseline for a real capture, and
removing it from that role would leave the dashboard with nothing scored to develop against.

**KV-103 weakened that argument, and the conclusion survives it.** Seeded days now carry
verdicts of their own, so excluding them from a real capture's baseline would no longer
leave the dashboard empty — twelve scored demo cards would remain. What it would still lose
is a real capture on the demo persona being compared at all: that capture's baseline would
be empty, so it would read "not yet enough history to compare this check-in" for its first
three check-ins, and
the one verdict built on live readings would stop being demonstrable. That is the cost the
disclosure exists to make acceptable.

**No seeded day is allowed near `elevated`** (KV-101). The demo is what someone new to the
product sees, and an amber card on invented data is exactly the wrong first impression.
That used to hold by luck: across 2000 seeds, 18.4% of fortnights had an elevated day, and
the shipped seed's worst sat 0.03 below the line. Now a day whose rules sum to
`DEMO_DAY_CEILING` (0.5) or more is drawn again, so it holds for every fortnight seeded
from now on, whatever the seed. The ceiling is below the threshold on purpose: the redraw is
judged by the scorer at seeding time, but the verdict by whichever scorer shows it later,
and a 0.1 margin is what lets a demo seeded today survive a weight change tomorrow.
Narrowing the demo's answer odds was measured too, and only halved the rate — the camera
readings alone push some days over.

**Two limits, both accepted.** A demo seeded *before* KV-101 keeps its old fortnight —
`demo:seed` refuses to write into a history that has anything in it — so its worst day
stays 0.03 below the line, and only a new install gets the ceiling. And the ceiling does
more than stop amber cards: it stops signals *stacking*. No seeded day fires three rules
(excluding `poor-sleep`), and poor sleep with pain never appears beside anything else,
since 0.45 plus the lightest other rule is already over 0.5. So the demo shows at most two
signals on a day — about one such day a fortnight counting `poor-sleep`, about one in three
fortnights without it — and never the near-miss that sums several just under the
threshold. The full combination the app exists to catch was already off
limits — it would be `elevated` — and the demo's job is unremarkable weeks, so that cost is
accepted rather than engineered around; a real capture is where the summing shows.

**Seeded verdicts are computed when shown, not stored** (KV-103). `withSeededVerdicts`
scores each seeded record as the dashboard renders it, the way `submit` scores a real
check-in — against the records before it, never itself — so the fortnight reads as a
fortnight: three days still learning their normal, the rest compared. A real check-in's
verdict is stored because it is a fact about a day and is never redone. A seeded record's
verdict is a view of the current rules: stored, it would go stale the first time a weight
moved, and the demo would go on showing a scorer the app no longer has. Scoring on display
also reaches installs that seeded before this existed, with no migration. Until KV-103 the
dashboard the seeding exists to populate showed twelve cards saying "Not enough to say".

A seeded card carries no seeded-baseline disclosure; its own label already says what it
is. The sentence exists for a real capture compared against invented days, which otherwise
looks measured, and repeating it on every demo card would bury that one.

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
  physiology without consent is surveillance, however well meant. It is the person's own
  consent; a path for someone who cannot give it waits on legal advice (#35). See
  *Who sees it, and how it is taken back* below.
- **What leaves the device is decided in one place** — `toShared` in `core/share/`,
  with every field of a session explicitly classified. Each shape that leaves has a table
  over its own keys — every branch's, for a union — so a new field does not compile until
  it is decided. A field that can hold a shape is decided by that shape's table (a list,
  by a list of it), never shared whole; one walk reads the tables from the record's down,
  `never` included, so they cannot say one thing while the code does another. The shared
  types, and which fields a viewer must be granted, are read off the tables too. A record
  that is not what its tables describe — a list where one shape belongs, a corrupt item, a
  missing `id` — does not leave. Sync code sends what `toShared` and `shareSet` return —
  `SharedRecord`s — and nothing else. (KV-37)
- **A calm daily summary, never a real-time alert.** A notification the moment a flag
  fires would turn the app into the emergency alarm it is designed not to be, and a lock
  screen far away cannot carry the difference between "worth a look" and "drive over".
  (#43)
- **No secondary use without its own consent.** The data exists for that person's care:
  no analytics on it, and no aggregation across people. The one planned exception is
  calibrating the rule thresholds (#22), which pools caregiver-confirmed outcomes (#47)
  across people. That is opt-in, asked for separately from sharing with a caregiver —
  approving a viewer (KV-31) is not consent to it, and that decision did not consider it —
  and its own consent must be designed, and clear #35, before any session is used for it.
- **`core/` stays framework-free**, so that it can be imported by more than one app. One
  will be: KV-34 decided a caregiver client built on it, which #42 builds. Until then
  nothing checks that `core/` runs outside Electron, beyond the lint rule that keeps
  Electron and React out of it. `core/session/store.ts` is already the exception — it
  imports `node:fs` — and #38 decides where it lives when the repo is split. (#15, #38)

### What leaves the device (KV-32)

Decided 2026-10-01. This governs what Kinvue itself sends to a viewer — the share payload.
What the SDK sends on its own during a capture (the licence meter and the model load,
above) is a separate matter, and stays with #36.

**A viewer's device receives the records the dashboard is built from, not a view composed
for it.** A view composed on the check-in device would be frozen in the words of the day it
was sent, and could not draw the trend (#4, #165), which needs the readings behind the usual.
The ticket's ladder of five rungs (verdict, sentences, vitals, answers, note) does not
survive that: its second rung already shares the numbers, since every explanation quotes
them.

**What the viewer composes, and what it does not** (review of #173). Not every word on a
card is composed when shown: a comparison rule's explanation and the summary are stored
text, written when the check-in was scored, and they travel inside `assessment`. What is
composed when shown is what the check-in device composes too — the answer rules re-worded
from the answers (KV-138), the readings, the answers row. The viewer composes **each card
from its own record and never rescores it.** Rescoring needs the whole history, which a
viewer does not hold: tried with a viewer's share, the oldest shared card gained "Scored
again now, it would read 'Too early to compare' (0 of 3 usable check-ins)" — true of the
viewer's records, false of the person. So what is computed over the whole history stays on
the check-in device: the drift line under a card, and the header lines for a usual still
being learned (KV-17) or reaching far back (KV-154). The counts a card itself quotes —
seeded, refused, the span of its usual — are stored in its `assessment` (KV-53, KV-100,
KV-154), and travel with it.

So the rule is **what the dashboard shows, and nothing it does not**. The shared record is
its own type, so a field it does not carry is absent rather than set to something that
means another thing:

| Field | Leaves | Why |
|---|---|---|
| `format` | Yes, always | What a viewer checks before reading anything else (KV-30). Written on the way out even for a record from before it, as 1. |
| `id` | Yes | An opaque UUID; updates and removals (#45) travel by it. |
| `personId` | **Replaced** | The local id can read like a name. The share's own opaque id is written into `personId` on the way out — `presentAll` groups and `trendOf` filters by it, so it cannot simply be dropped. |
| `capturedAt`, `timeZone` | Yes | A viewer elsewhere needs *their* day (#28). The zone names a region; that is the cost. |
| `vitals.pulseRateBpm`, `.breathingRateBrpm`, `.hrvRmssdMs` | Yes | The card's readings and the chart. |
| `vitals.hrvSdnnMs` | **No** | Nothing reads it — no rule, no screen. Absent from the shared type; a viewer's device that needs a `Vitals` may supply `null`, which nothing reads either. |
| `vitals.confidence`, `.stable`, `.durationSec` | Yes | Quality, not personal: without them a viewer's device cannot tell "not enough to say" from a reading. |
| `answers.mood`, `.sleep`, `.painReported` | Yes | On every card (KV-110), and the answer rules are worded from them. |
| `answers.skippedMeal`, or `.eatenToday` on a real record from before KV-16 | Yes | Whichever the record carries — the same answer, asked two ways. |
| `answers.painNote` | **Only with consent, per viewer** | Below. |
| `assessment.flag`, `.summary`, `.firedRules` (each rule's `id`, `title`, `explanation`, `severity`) | Yes | The verdict and the words it was given in. Severity orders the rules and is never shown as a score (#42). |
| `assessment.baselineSessions`, `.baselineSeededSessions`, `.baselineRefusedSessions`, `.baselineSpan`, `.uncomparedMetrics`, `.withheld` | Yes | The counts and reasons the card quotes, stored so the viewer need not recompute them. |
| `assessment.rulesVersion` | Yes | Which rules gave the verdict (KV-30): a viewer never rescores, so this is how it can tell a verdict from rules the app no longer has. |
| `seeded`, and seeded records | **Never** | Demo data about nobody, with ids that repeat across installs. |

`assessment` is classified field by field, like the rest: five tickets have each added a
field to it (KV-53, KV-87, KV-100, KV-138, KV-154), and a sixth must not leave by default.

- **One policy, except the pain note.** What the cared-for person agrees to has to fit on
  one screen (#31): *they see what this dashboard shows — the readings, your answers and
  what the app made of them.* A per-field menu would be consent nobody can follow.
- **The pain note is off by default, and turned on by the person for a viewer.** It is the
  only text in their own words, and the case for sharing it (KV-2: "left hip, since
  yesterday" serves a caregiver deciding whether to drive over) is strongest exactly when
  the caregiver is far away — which is why it is a choice and not a rule either way. When
  it is on for anyone, the note field says who will read it, as they type.
- **A new viewer gets every check-in from the earliest one behind the current usual
  onward** — refused captures included, since the chart's and the cards' caveats are counted
  from them (KV-12, KV-100), and a viewer shown fewer would be more confident than the
  check-in device. Not the whole history: agreeing today must not share months nobody
  agreed to share. The usual counts 14 usable check-ins, not 14 days, so for someone who
  checks in twice a week that reaches back about seven weeks; **the person is shown the
  actual date it reaches back to** when they approve, not "about a fortnight" — the day
  of the first check-in actually sent, named in the zone it was taken in (KV-28).
- **A demo install's real check-ins lose their seeded usual on the way out.** A real card
  scored against seeded days arrives with its stored verdict and seeded disclosure, but the
  viewer's chart, holding no seeded records, may have no usual to draw beside it — the card
  quoting a usual the chart cannot. Demo installs are not meant for sharing, but such a
  card **is** shared (KV-37): its stored verdict already says it was compared with demo
  data, and holding back a real check-in would be the wrong way round. What the viewer's
  chart draws beside such a card — it holds none of the days its usual was built from — is
  #42's to decide; the count it needs (`baselineSeededSessions`) travels with the card.
- It travels end-to-end encrypted and signed, through a relay that cannot read it (KV-33).

### Who sees it, and how it is taken back (KV-31)

Decided 2026-10-01. Remote access shares an older adult's physiology with other people;
whether that is care or surveillance depends almost entirely on who agreed to it and
whether they can take it back. So every control over **remote viewers** sits with the
cared-for person, at their own device. Whoever reads the dashboard *at* that device is not
a remote viewer, is on no list and cannot be revoked; that is the device's own boundary
(#175), not this model's (review of #174).

- **The person approves each viewer, on the check-in device.** A viewer cannot add
  themselves: pairing starts on the check-in device, with a code shown there, so approving
  someone means being at their own device to do it. There is no approval from a viewer's
  phone, by link, or by default.
- **Nothing is shared until they do.** Each approval says, on one screen, what that viewer
  will see: *the readings, your answers and what the app made of them* (KV-32); whether
  the pain note is on for them; and the date their history will reach back to.
- **The person can see who has access, what they get, since when, and when each has been
  looking.** Not who *can* look but who *does* — and how often, since a viewer opening the
  dashboard forty times a day and one who glanced once this month are different things: so
  a short recent history of each viewer's looks, not one timestamp. It is taken from what
  the relay delivered to each viewer, **not reported by the viewer's own app**, which a
  viewer who is the danger could silence or alter. Two costs, said plainly: the relay then
  holds when each viewer fetched, which #36's T4 wants kept small; and reading a copy
  already on the viewer's phone, offline, is not seen at all. KV-33 keeps those delivery
  records for this window only, 30 days. The list is also offered unprompted,
  periodically: a list nobody revisits protects nobody.
- **Revocation is on the check-in device, immediate, and needs nobody's sign-off.** The
  removed viewer receives nothing new from that moment, and their app deletes the
  check-ins it holds the next time it connects; the check-in device stops sealing to it
  (KV-33). **A viewer's device that never reconnects keeps its copy** — no longer sealing
  to it protects only what had not yet been delivered. Said honestly in the app: removing
  access stops what comes next and deletes what it can reach, and cannot unsee what was
  seen. (#45 implements it.)
- **A removed viewer is told only that sharing has ended** (except when the recovery card
  ends every share, which is announced to all of them; KV-33) — no date, no reason, no prompt
  to ask. It will be noticed anyway; what is avoided is a notification that reads as an
  event to react to, which matters when the viewer is remote and the danger (#36).
- **Viewers cannot see each other.** Who else has access is the person's business.
- **Only the person's own consent, for now.** Dementia and cognitive decline are common in
  exactly the people this is for. Whether a guardian or power of attorney may approve
  viewers, and what that looks like, is a legal question (#35), and it is not guessed at
  here: until it is answered, someone who cannot agree at their own device is not shared
  with anyone. **Deliberately unsupported**, not overlooked.

**What this model cannot do** (review of #174), stated as limits rather than listed as
defences:

- **Someone at the device has the device's authority.** Approval and revocation need only
  presence at the check-in device, so a household member who is the danger can approve
  their own phone, revoke the one viewer who might notice, and — removal being silent by
  design — leave that viewer told only that sharing ended. The two choices that protect the
  person from a remote viewer, presence-only authority and silent removal, turn against
  them when the danger is in the room. The mitigation is a lock on the sharing screen,
  separate from the check-in itself (#40; #36's T2), and until it exists the model assumes
  the device is the person's.
- **Consent given under pressure** — a viewer standing beside the person while they approve
  — cannot be told apart from consent freely given.
- **A lost check-in device ends every revocation.** Authority sits on that one device, so
  if it is lost, broken, wiped or replaced, no share can be ended and the person cannot see
  who still holds their check-ins. KV-33 answers it with a printed recovery card that can
  see who has access and end every share, never approve anyone new — and never quietly:
  using it starts a 72-hour countdown that every viewer is told about.

What remains as defence: the person can see who looks and how often, from a record the
viewer cannot alter; a remote viewer can be removed at once, silently; and viewers cannot
see each other. #36 tests them.

### How it travels, and who holds the keys (KV-33)

Decided 2026-10-01, revised in review of #177. **An end-to-end encrypted relay, kept
deliberately small.** The relay stores and forwards what it cannot read, and cannot alter,
forge, drop or replay anything without the viewer's device seeing it.

One fact shapes this more than any other: **the check-in device holds the whole history and
is the only sender.** End-to-end designs are usually hardest at restoring history onto a
replaced device, which pushes them toward key backup or escrow. Here a viewer who loses
their phone re-pairs and is sent their **share set** — the records KV-32 says that viewer
receives — again, so no viewer key is ever backed up. Recovery is hard in exactly one
place: the check-in device itself, and there it is hard for the history as well as for
authority (below).

- **Proven cryptography only, and what each part answers.** Each device has two key pairs:
  Ed25519 to sign, X25519 to receive. For each viewer the check-in device builds an
  **envelope** — that viewer's id, the next number in that viewer's stream, the hash of the
  previous envelope, and the record — **signs the envelope**, and seals it to that viewer's
  key with a libsodium sealed box. No home-made construction, and no group protocol, since
  viewers are few. The seal answers #36's T3: no one else can read it. A sealed box cannot
  be altered, but it is anonymous — anyone holding the viewer's public key can make a new
  one — so it cannot say who sent it; the signature can. Signing the envelope, not just the
  record, puts the stream number and the link to the previous envelope inside what is
  signed, so a relay that dropped record 7 and renumbered the rest is caught (T13). A record
  signed once, with per-viewer numbers outside the signature, would not catch it.
- **Each viewer's stream is numbered and chained.** Gaps, replays and reordering are
  visible on the viewer's device, and a gap is shown as one, beside #44's missed check-ins.
- **The pairing code confirms all four keys.** It is derived from both devices' signing
  *and* receiving public keys, so a relay that substituted any of them during pairing is
  caught at the one moment it could do so. Without this, both "the relay cannot read it"
  (T3) and "the relay cannot forge it" (T13) hold only as long as the relay never lies at
  pairing. A viewer is paired in person where they can be; a caregiver far away compares
  the code over the phone, which protects only if both sides actually compare it, and #40
  designs that comparison so skipping it is hard.
- **The check-in device is the outbox, not the relay** (#41). It keeps, for each viewer,
  every envelope it has sealed and the last stream number that viewer acknowledged. A
  viewer reconnecting after any gap — six weeks with the phone off — asks from its last
  number, and the device seals what is missing again, deletions included (#45, T12). So
  nothing depends on the relay keeping anything.
- **The relay keeps as little as it can, for as short as it can.** Ciphertext until each
  recipient has fetched it, at most 14 days; delivery records only for #31's access-history
  window, 30 days. **These are the operator's policy, not controls:** the relay is the
  adversary T3 and T4 name, and an operator who kept more would be invisible to both
  devices. What holds against that operator is what it holds — sealed envelopes it cannot
  read — not how long it holds them.
- **Revocation stops sealing to that viewer** and asks the relay to delete their waiting
  envelopes; their app deletes its copy on next contact, and one that never reconnects keeps
  it — the limit #31 states (#45).
- **A lost check-in device: a recovery card that can only end things, and never quietly**
  (T14). At setup the person is given a printed recovery code. With it they can see who has
  access and **end every share**, but **not approve anyone new**. **Using it is delayed and
  announced:** it starts a 72-hour countdown, every viewer is told the recovery card was
  used and when sharing will end, and the check-in device, if it still exists, shows it and
  can cancel. A genuinely lost device still ends every share. Someone who finds the card
  and uses it to cut the person off — T2's attack, without being at the device — alerts
  every caregiver instead of silencing them. A replacement check-in device starts fresh,
  and each viewer is approved again at it.
- **The daily summary's push carries no content** (#43). The viewer's app fetches, verifies
  and composes.

**Options not taken.** A **conventional backend** (encrypted in transit and at rest, but
readable by its operator) and a **managed backend service** would have been simpler and
faster, and both put every shared check-in — the pain note included, where a person has
turned it on — where an operator, a third party under #35, or whoever breaches either can
read it. (Either could carry the same signed envelopes, so integrity does not separate
them; confidentiality does.) **No Kinvue server**, the family's own cloud storage carrying
the sealed share sets, keeps the encryption and removes #46 almost entirely, but has
nowhere to take #31's access history from, no server to send #43's push, and asks older
adults to set up a shared folder correctly; it is the fallback if running a relay is ever
ruled out.

**What it costs.**
- **A relay to run** (#46): small and nearly stateless — store, forward, expire — but still
  backups, monitoring, a breach plan and an owner.
- **Key handling that has to be right**, which is why it uses recommended libraries only and
  is reviewed before #39 carries real data. It weighed on #34, which keeps the code that
  holds the keys in a signed app and the keys in the phone's secure storage (KV-34) — and
  that settles where the keys live, not whether they are handled right.
- **No forward secrecy.** Sealed boxes seal to a viewer's long-lived key, so someone who
  archived envelopes from the relay and later takes that viewer's phone and key can read all
  of them (T5). The short retention narrows what an honest relay holds, not what an attacker
  copied. Rotating viewer keys, or a ratchet, is the remedy if this becomes the weak point.
- **Every signature rests on the check-in device's key**, which sits where its data sits:
  behind the operating system's account boundary and nothing more until #175 decides
  otherwise. Malware running as the person can sign forged cards that every viewer accepts.
- **A dead check-in device loses the history, unless it was exported.** The card recovers
  authority, not data: the history, and with it the baseline the scorer compares against,
  goes with the device unless it was exported (KV-21) or backed up (#175). Restored from an
  export, the history and its baseline come back as of that export. Otherwise a replacement
  starts from zero check-ins, "too early to compare" until it has enough.
- #36's T4 remains in part: the relay still sees when envelopes arrive and who is paired
  with whom; sending on a schedule rather than at capture time is noted, not required.

### The caregiver's client (KV-34)

Decided 2026-10-01, revised in review of #178. **The caregiver's client is the dashboard's
own React code, built on `core/` and the existing dashboard components, shipped inside a
native shell (Capacitor) for iPhone and Android — with its web code inside the signed app,
never fetched.**

Three facts decided it more than any general comparison:

- **The components are already portable.** `SessionCard`, `TrendChart`, `SectionBoundary`
  and `boxes.ts` are plain React for the browser, with no Electron in them. That is where
  the product's care lives — the not-flagged band and its notes (KV-165), the sections that
  fail alone (KV-163), the cards that never rescore (KV-32). A caregiver's chart should be
  *the* chart, not a second drawing of it that can drift from the first. `core/` imports
  nothing from Node except the JSON-file store, and the viewer does not reuse that file: it
  implements the same `SessionStore` seam over the phone's own storage, keeping the file's
  discipline — never read a record from a newer format as one it knows, check the shape of
  what is read, write so a crash leaves the old copy — since a newer desktop app is exactly
  where its records will come from (#30, #42). Not the check-in device's way of refusing,
  though: see *What a record carries on its own*.
- **A web app served live would weaken KV-33.** Whoever controls the server that sends the
  page can send code that reads the viewer's keys, to one viewer or all of them, on any
  request, with nothing to show it happened — the standing weakness of end-to-end encryption
  in a browser. A shell carries a different risk: its code and plugins are fixed in a
  signed build that changes only by a new release, through review, to everyone at once.
  That is the smaller surface, and it is the reason for the shell — **but only while the
  web code ships in the bundle.** Capacitor can point its webview at a remote page
  (`server.url`), and live-update services push new JavaScript into an already-signed app;
  either puts the browser's weakness back inside it. So a release build has no remote page
  address and no over-the-air JavaScript updates, and #179 makes that a check that fails
  rather than a rule someone remembers.
- **The phone does what the web does badly here:** a native push for the daily summary
  (#43), where a web app on an iPhone gets one only once added to the home screen; the
  phone's own secure storage (Keychain, Keystore) for the viewer's keys (KV-33); and **an
  app lock** — the client opens only after the phone's own authentication (face, fingerprint
  or passcode), so a phone picked up unlocked does not open its check-ins (#36's T5). The
  lock is its own plugin, and so part of #179's list.

**Options not taken.** An **installable web app** shares the reuse and avoids app stores,
but ships its key-holding code from a server on every load, and has weaker push and key
storage. **React Native** keeps native push and storage and reuses `core/`, but redraws the
chart and the card — a second implementation of the most carefully worded screens. **Fully
native** apps reuse nothing and mean two codebases.

**What it costs.**
- **App store accounts and review:** Apple at $99 a year, Google $25 once, with the extra
  scrutiny health-adjacent apps get — privacy labels, and no medical claims, which the
  product's "not a diagnosis" framing already keeps.
- **A second release channel.** An iOS build needs a macOS host with Xcode, signing
  identities and provisioning profiles; an Android build needs a signing key that cannot be
  replaced once lost; both need family testing (TestFlight, internal testing) before a
  listing. #19 covers only the desktop installer, so #179 owns this.
- **Trust in the shell and its plugins** — native code on the phone that holds the keys,
  pinned and reviewed under #179 (#36's T9).
- **The reuse is partial.** The two screens that matter port as they are; what a caregiver
  needs around them does not exist in either app. The caregiver app is the many-people case
  — an aide with six clients, a parent with three children who each look (#18) — so a person
  index, a switcher and a combined "today" view are new work for #42, not reuse.
- **A webview**, less native in feel than React Native.
- When the repo is split (#38), the shared components move to a `ui` package beside
  `core`: `core`, `ui`, the desktop app, the caregiver app, and the relay.

### What a record carries on its own (KV-30)

Decided 2026-10-02. A record used to have to make sense only inside one file on one machine.
Shared, it lands on a viewer's phone, is read there by code of another age, and outlives the
code that wrote it. What #30 asked, and what was decided:

- **Its format, on the record.** `format` (`RECORD_FORMAT` in `core/session/format.ts`) is
  written on every record, and always on one that leaves (KV-37). A reader refuses a record
  in a format newer than it knows rather than reading it as one it does: the check-in device
  refuses the whole history, as it refuses a newer file (`NewerStoreError`): leaving one
  record out would score every later check-in against a usual missing a day, and it cannot
  be left out of one person's history only, since a record in a format this build does not
  know cannot be trusted to say whose it is. A viewer is placed differently (review of
  #182): it never rescores (KV-32), and it knows whose a record is from the share it came
  in, not from the record. So a viewer holds just that record aside and shows the rest,
  saying a check-in needs a newer version of the app; refusing everything there would cost
  a caregiver every person they look after and protect nothing. How it says so is #42's.
  An entry the device cannot read at all — not a record, or a format that is not one — is
  refused the same way as a newer one, with no offer to set the history aside
  (`UnrecognisedRecordError`): the file is as intact, and archiving a baseline over one
  entry somebody needs to look at would be the destructive answer. **It is bumped only when a reader of the old format would
  misread the new** — a field that changes meaning, or is renamed or removed. KV-16's meal
  question would have been one. Adding a field is not: every reader leaves behind what it
  does not know (`toShared` does by construction), so bumping for one would lock older
  readers out of records they read correctly. **Since KV-181, any change to an existing
  field's type bumps it too**, widening included: every field is checked as it is read,
  so an older reader would refuse such a record — and its whole history — as one it cannot
  read, where bumped it says what is true, that a newer version wrote it. Format 1 is
  every record so far, both meal questions included, since today's reader reads both. **One number covers both shapes a
  record is read in** — as stored, by an older check-in app, and as it leaves
  (`SharedRecord`), by a viewer — and is bumped when a reader of either would misread the
  new. So a change to what leaves can need a bump with nothing stored changing, and a test
  pins the share tables beside the number so that is decided, not missed; the other way
  round, a change to a field that never leaves bumps it too, and viewers hold back records
  they could have read until they are updated. That cost was taken over two numbers kept in
  step by hand (review of #182).
- **No migration that rewrites history.** A record from before KV-30 carries no format; it
  is format 1 by definition and read as that (`formatOf`), and nothing on disk is rewritten
  to say so. A migration editing every record would be the riskiest write the store ever
  made, to record what is already true. The file's own `version` is unchanged, so a build
  from before KV-30 still reads a file written since, ignoring the new fields. A future
  format that does change a meaning is read through a function from the old to the new,
  applied as it is read and never written back — the way `asAskedNow` already reads a
  seeded day from before KV-16.
- **Which rules gave the verdict.** `assessment.rulesVersion` (`RULES_VERSION` in
  `core/scoring`) is written on every verdict. A viewer never rescores (KV-32), so without
  it a caregiver reading last year's flag could not tell it came from rules the app no
  longer has; with it, #42 can say so where the check-in device says it with a drift line
  (KV-138). It is bumped whenever the scorer would store something different for the same
  check-in and history, and `tests/rules-version.test.ts` makes that a check rather than a
  rule someone remembers: it scores a fixed set of check-ins, straddling each comparison
  rule's line, and pins a hash of what comes out beside the version. A change to a
  threshold, weight, rule or sentence fails until both move together. It catches what that
  set exercises, which is why it straddles the lines. Verdicts from before it carry none,
  and read as unknown: several earlier scorers gave them, and which is not recorded.
- **Person identity was settled by KV-32.** `personId` never leaves the device — the
  share's own opaque id replaces it (KV-37) — so a readable local id like `demo-margaret`
  is sent nowhere, and the global uniqueness the ticket asked for is the share id's. A
  person added once #18 allows more than one gets a random UUID as their local id as well,
  so the file names nobody; the existing id stays, since rewriting it would rewrite every
  record.
- **No field for the device that wrote it.** Its three uses are answered better elsewhere.
  Pairing and revocation (#40, #45) work by device keys (KV-33), and every envelope a
  viewer receives is signed by the check-in device's key, which proves who sent it where a
  field could only claim it — and two names for one device could disagree. For debugging,
  the format and the rules version say which code wrote a record and which scored it.
- **The same record arriving twice is one record.** Ids are UUIDs and never reused, and
  `append` on any store behind the `SessionStore` seam is idempotent (`sameRecord`): a
  record already held, arriving again, writes nothing; a *different* record under a held id
  is refused — not merged, and not taken for a duplicate, since either would lose one of
  the two unseen. Key order, and a format of 1 left unsaid, are not differences. A record
  that does have to change on a viewer — the pain note turned on or off for them later, or
  a deletion — travels as its own message, by id (#41, #45), never as a second copy that
  quietly replaces the first. A tombstone, whatever #45 makes it, must win over the record
  it names whichever of the two arrives first.
- **Every field is checked as it is read (KV-181).** A signature proves who sent a record,
  not that it is well formed, so the format is not the only thing read before a record is
  trusted. `checkRecord` (`core/session/check.ts`) checks each field against its type —
  required fields present, the meal question answered exactly one way, verdicts, moods and
  reasons within their values, and `null` only where a field can hold it — and gives the
  first reason, naming the field. It never repairs. Fields it does not know are left
  alone, since adding one does not change the format. It checks types, not ranges: a
  `confidence` of 95 — a percentage a sender failed to convert — passes, so ranges stay
  with whoever produces a value and whoever leans on one. Every shape the store has ever
  written passes: each field added since the first commit is optional, and the one
  required field that changed widened (`confidence`, KV-12). One spec per shape, typed
  over its keys, so a new field does not compile until it is checked. What a refusal does
  is each reader's:
  - **the check-in device refuses its whole file**, under the same no-button sentence as an
    unrecognised format (`UnrecognisedRecordError`), now naming the field — an entry it
    cannot read cannot say whose it is, and a file set aside over one entry would cost a
    baseline;
  - **a viewer holds the one record aside** and shows the rest: `checkShared` asks of a
    received record what `checkRecord` asks of a stored one, steered by the share tables
    so the two cannot drift, and the viewer knows whose it is from the share. How it says
    so is #42's.
  `toShared` refuses a record `checkRecord` refuses, so nothing leaves that a viewer would
  have to hold aside.

### Exporting, deleting, and how long a history is kept (KV-21)

Decided 2026-10-04, revised in review of #184. There was no way to export a person's
history, no way to delete it, and no retention policy — `sessions.json` grew forever —
and `README.md` was silent on all three. For an identified person's physiological data,
"it's local" is necessary and not sufficient. It applies on one machine before anything is
shared, and sits here because its tombstones are what sync will carry (#45). This is the
policy; the change that builds it adds what is then true to the privacy section of
`README.md`.

- **Export is a restorable file, one per person.** Their records exactly as stored —
  format, verdict and pain note included — inside a small container that says what it is
  (its own `kind` and `version`, and when it was made), with the tombstones below. Not a
  spreadsheet: a file someone can read but not restore would do nothing for KV-33's limit,
  that a dead check-in device takes the history with it. This makes the history
  recoverable **if the person exported it** — export is manual, so T14 stays a limit for
  anyone who did not. **Nothing schedules or nags; the date is shown instead**: beside
  the export control, "Last exported: never", or "Last exported 3 October (41 check-ins
  since)", so how much a dead device would take is visible without a prompt an older adult
  may not follow (review of #184). A readable form can come later, on top. **Seeded demo
  days are not exported**: they are about nobody. **The pain note goes with its
  check-in**: it is the person's own data, exported at their own device.
- **Restoring writes everything it accepts, or nothing, and says which.** A restore that
  stopped halfway would look like success, so the file is read in full before anything is
  written, in this order (review of #184):
  1. **The container's `kind` and `version`.** Not a Kinvue export: refused. A newer
     container: refused as *made by a newer version of Kinvue, which can restore it*.
  2. **Each record's format** (KV-30). One newer than this build reads: the whole file is
     refused with the same newer-version sentence, never entry by entry — the person needs
     a newer app, not a list of entries.
  3. **Every field of every record** (`checkRecord`, KV-181) **and every tombstone.** Any
     refusal refuses the file, naming the entry and the field.

  Then records are merged by id: one already here is the same record (`sameRecord`, KV-30)
  and changes nothing; a different one under an id already held refuses the file. **A
  record this device has a tombstone for is skipped, and the screen says so** — "None
  restored: all 60 check-ins in this file were deleted on this device on 3 October, and
  stay deleted", or "Restored 12; 3 others were deleted here and stay deleted". Skipped is
  an outcome reported, not a partial write. A refused restore changes nothing, and offers
  nothing that would: the history already here is never set aside to make room (the
  mistake #182's review took out of the store). Restoring the same file twice changes
  nothing.
- **The three version numbers answer three questions.** The store file's `version`
  (KV-13) is the shape of `sessions.json`; an export's container `version` is the shape of
  an export; each record's `format` (KV-30) is the shape of a record, the same inside both.
  Each moves on its own, and each is read before the thing it describes.
- **Deleting: one check-in, every check-in before a date, or a person's whole history.**
  "Before a date" is one instant — midnight at the start of that date, in the device's own
  zone when the person deletes — compared with each `capturedAt`, so a record from before
  KV-28, which has no local day (`localDateOf` answers null), is decided like any other
  rather than left behind by an unstated rule; and the screen shows how many check-ins it
  will delete, and when the last of them was taken, before anything goes. It is the
  person's action, at their own device, confirmed on screen, which says it
  **cannot be undone, not even by restoring an export** — the export it offers first is a
  copy to keep, not an undo (review of #184). The record is removed from the store, not
  hidden in it; what a disk keeps of a file rewritten over is a cost below. What is kept
  is a **tombstone**: the record's id, whose it was, and when it was deleted — no reading,
  no answer, no note — so a deletion can travel (#45) and outlast an export. **Tombstones
  live in `sessions.json`, beside the records.** **A seeded day leaves none**: it never
  leaves the device, so there is nothing to tell, and its id repeats across installs —
  a tombstone for `seed-demo-margaret-4`, exported and restored elsewhere, would delete
  another install's demo day the file never mentioned (review of #184).
- **A tombstone wins over the record it names, whichever arrives first — for a copy that
  comes back through the app.** A restored export, or a record arriving by sync, cannot
  bring a deleted check-in back; and a tombstone arriving in a restored file removes the
  record it names. This is KV-30's rule, made concrete: a deletion an export can undo is
  not one. **Not against a rollback of the file itself** (review of #184): restore
  yesterday's `sessions.json` from File History, Time Machine or a sync client's version
  history, and the records come back with the tombstones gone in the same step — nothing
  is left to win. That is the operating system's backups doing what they do, and it is
  T7's limit, below; #175 decides what protects the store at rest.
- **Verdicts already given stand.** A card is a record of what the app said (KV-138).
  Deleting a day does not rescore the cards that were compared against it: they keep their
  stored verdicts and counts. Check-ins after it are compared against what remains. A card
  whose usual included the deleted day may gain a drift line, which says the verdict would
  differ now and not why — the same line a change of rules produces. Rescoring was
  rejected: it would rewrite what a caregiver had already been told. **The confirm screen
  says so** (review of #184): older cards compared against these days may note that they
  would read differently now — so a line appearing on a settled card, on a day when
  nothing about the person changed, has been explained before it appears.
- **Kept until the person deletes it, deliberately.** No automatic window. A person's own
  log, on a device they control, deleted on a schedule nobody chose, would surprise more
  than protect; and the usual reaches back by count (14 usable check-ins), not by age, so
  age is not what makes old data matter. What is held elsewhere has its own limits — the
  relay keeps ciphertext at most 14 days (KV-33) — and protection at rest is #175's.
- **The pain note shares its check-in's lifecycle.** Exported, kept and deleted with it. It
  is already treated apart where that matters — sent only to a viewer the person chose
  (KV-32) — and how it is protected at rest is #175's question. Deleting only the note
  would edit a record, which is never done.

**What it costs.**
- **Anyone at the device can export or delete.** The app has no notion of who is at a
  shared computer: the same limit #40 meets for approving a viewer, and #175 for data at
  rest (T2, T7).
- **An exported file is the whole history in plain JSON**, wherever it is put — a USB
  stick, a synced folder, an email — outside `userData` and any account boundary. The
  screen that makes one says so. Its own row: T16.
- **What a disk keeps of a deleted record.** A deletion rewrites `sessions.json` through a
  temporary file and a rename, so the old file's blocks are released, not overwritten:
  reachable for a while from free space, a filesystem journal, an SSD's spare area, a
  shadow copy, or a sync client's version history. Until #175 decides protection at rest
  there is nothing to make that residue unreadable (T7). "Deleted" means gone from the
  app and from the store, not from the disk.
- **Tombstones outlive a whole-history delete, and say something** (review of #184). A
  person who deletes everything leaves one entry per check-in they ever took, with whose
  it was and the day they erased them — at a shared computer (T2), in a plain file (T7),
  that is how many check-ins there were and when they were wiped. They cannot be removed:
  they are what stops an export made earlier, or a copy arriving by sync, bringing the
  records back. The confirm screen says so before a whole-history delete. They accumulate,
  one small entry per deleted check-in, for as long as a copy could exist — which on one
  machine is indefinitely.

### What must hold before real check-ins are stored

Each is owned by a Phase 1 ticket that has to land before the check-in flow (#2) stores
real sessions, because a record written without them cannot be repaired afterwards. All
three hold:

- **Records are never edited in place, and have globally unique ids.** Both hold.
  Sessions are only ever appended, which is the property sync needs, and an id is a UUID
  rather than the local clock, so two devices — or two submits in the same millisecond —
  cannot produce the same one (#25). The same record arriving twice is one record
  (KV-30). Seeded ids repeat across installs, which is acceptable only because seeded
  records never leave the device (#37). When a record is
  removed — by the person, since KV-21 settled on no automatic retention — sync must
  carry that as a tombstone, not as silence, and the tombstone wins over the record
  whichever comes back first through restore or sync (KV-21, #45).
- **Vitals originate in the main process and nowhere else.** This holds: `submit` takes
  the id of a capture main is holding, never the numbers. The rule, and what else that
  held capture is pinned to, is under *Why the API key lives in the main process*. (#25)
- **Every record knows its local time zone.** This holds since #28: each check-in stores
  the zone it was taken in. `capturedAt` is UTC; a caregiver in another zone needs the
  cared-for person's *today*, and a UTC timestamp recorded without its zone can never be
  placed on the right local day afterwards. Records from before #28 have none: they are
  displayed in the reader's zone, and have no local day at all (`localDateOf` answers
  null). An empty or unknown zone is displayed the same way, indistinguishable from none —
  which matters once records arrive from another device (#166).

### What is still open

One decision is left, and as KV-31 to KV-34 were, it must be closed and written into this
file before remote code is written. Unlike them, it is open for want of qualified legal
advice, not by choice: it is not one this project can answer for itself.

| Question | Ticket |
|---|---|
| What legal and regulatory obligations sending health data brings — and whether a guardian or power of attorney may consent for someone who cannot (KV-31 left this open) | #35 |

End-to-end encryption is decided (KV-33, above). It does not keep the privacy guarantees
in `README.md` true: any sync ends *no network* and *session data is local*, encrypted or
not, and the other three are unaffected either way. What it adds is a new guarantee —
neither the relay's operator nor anyone who compromises the relay can read a check-in, or
alter one undetected (#36).

When remote access ships, the privacy section of `README.md` is rewritten in the same
change. The docs must never describe a device that sends nothing after it starts sending
something.

### Threat model (KV-36)

Written 2026-10-01, against #32 (what leaves) and #31 (who controls it), and updated for
#33 (how it travels) the same day. **Revisit it before #39 ships, and whenever #32, #31 or
#33 changes.** A mitigation counts only when a ticket owns it.

**What is protected, from being read:** the readings, the answers and the pain note. **The
routine itself:** a history of check-in times says that an older person lives somewhere,
probably alone, and is at home at a predictable hour — so timestamps are as sensitive as
the vitals. The relationships: who looks after whom. And who looks, and how often — the
access history #31 shows the person is itself the most revealing record in the system.

**And from being changed** (review of #176). A caregiver acts on what a card says: one
altered from "normal" to "different", or a fortnight with its flagged day removed, sends
someone two hundred miles for nothing or keeps them home when it mattered. A viewer's device
composes each card from its own record and never rescores it (KV-32), so it has no history
to check a card against. Integrity is protected as deliberately as confidentiality.

| # | Threat | From whom | Mitigation | Owner | Status |
|---|---|---|---|---|---|
| T1 | A viewer uses legitimate access to watch or control the person | **A remote viewer who is the danger** | What #31 keeps as defence: the person sees who looks and how often, from a record the viewer cannot alter (what the relay delivered, not the viewer's own report); removal is immediate and silent; viewers cannot see each other. Coerced consent cannot be detected — a limit. Presence at the device is **not** a defence here: see T2. | #31, #45 | Decided, until T2 is closed |
| T2 | Someone at the check-in device acts with its authority: approves their own phone, revokes the viewer who might notice, and — removal being silent — leaves that viewer told only that sharing ended | **A household member who is the danger**, at a shared computer | Approval and revocation need only presence at the device, so until there is a lock on the sharing screen, separate from the check-in itself, the model assumes the device is the person's (#31's first limit). The recovery card's mass revocation needs no presence at all, which is why its use is delayed and announced (T14). | #40 | **Gap → #40** |
| T3 | The relay's contents read in a breach, or by its operator | Outside attacker; the operator | End-to-end encryption: each envelope sealed per viewer, so the relay holds nothing it can read; the pairing code derived from all four public keys, so a key substituted at pairing is caught — without it the seal protects nothing (KV-33). Retention limits and operator access are policy, not controls, against this actor. No forward secrecy: envelopes archived now are readable by whoever later takes a viewer's key (T5). Encrypted, restore-tested backups; logs with no health data. | #33, #39, #40, #46 | Decided; #39, #40 to build, #46 to operate |
| T4 | The relay infers behaviour from metadata it must hold even under end-to-end encryption: when check-ins arrive, who shares with whom, and **when each viewer fetched** — the access history #31 takes from it | The operator; whoever breaches it | Ciphertext kept until fetched, at most 14 days; delivery records for #31's 30-day access window only, then deleted; no analytics (KV-33). **These limits are enforced by the relay, which is this row's adversary**: an operator who kept more is undetectable from either device. Arrival timing and the pairing graph remain visible — a limit; sending on a schedule rather than at capture time is noted, not required. | #33, #39 | Decided as policy; a limit against the operator |
| T5 | A caregiver's phone is lost or stolen with shared check-ins on it | Whoever finds it | The client opens only after the phone's own authentication — an app lock, its own plugin — and its keys are held in the phone's Keychain or Keystore (KV-34); the person can revoke that viewer from the check-in device (#45). A device offline after revocation keeps its copy until it connects — a limit. With no forward secrecy (KV-33), the phone's key also opens any envelopes an attacker archived from the relay. | #34, #42, #45, #179 | Decided; #42 to build; two limits stand |
| T6 | The daily summary leaks on a lock screen, or through the push provider | Bystanders; Apple's or Google's push service | The push carries no health data, only "your summary is ready"; the content is fetched and composed on the device (#33). | #43 | **Gap → #43** |
| T7 | Data on the check-in device itself: `sessions.json` is plain JSON, readable by anyone with that operating-system account, its backups (File History, Time Machine, a sync client), or malware running as it | Others on the computer; malware; a backup service | **Today**, only the operating system's account boundary, on Windows, macOS and Linux alike. #175 decides whether the store is encrypted at rest (for example with Electron's `safeStorage`, backed by each platform's own keychain) and what that protects against — not malware running as the same user. | #175 | **Gap → #175** |
| T8 | The renderer is compromised (a bug, a malicious dependency) and reaches the camera, the key's use or the history | Malicious code in the page | Sandbox, one page, IPC answered only for it, every handler through one checked wrapper, enforced by lint (KV-29). | #29 | Done |
| T9 | A malicious release reaches installs through the update channel or a dependency | Supply-chain attacker | **Today:** Electron and the SDK pinned exactly, each bump alone and launched before merge (KV-131, KV-145). **Not yet:** signed installers and signed updates, which wait on there being an installer and an update channel (#19); which dependencies may run install scripts (#147); and the caregiver app's native shell and its plugins — code on the phone holding the viewer's keys — pinned and reviewed, with its web code kept in the signed bundle (KV-34, #179). | #19, #147, #179 | Partly done; open on #19, #147, #179 |
| T10 | **The SDK's own traffic reveals the routine:** the licence meter carries each session's times and per-metric datapoint counts to the vendor, today, whatever Kinvue builds | The SDK vendor; whoever breaches it | Not mitigable in the app: a capture cannot run without it (KV-65). Established from the runtime's own schema, not by decrypting the traffic; *when* each report is sent is only partly known, but a report carrying the session's times says when the check-in happened whenever it arrives. `README.md` says so. Whether a third party receiving it is acceptable, and what users must be told, is a legal question. | #35 | **Accepted, disclosed; → #35** |
| T11 | The pain note, the most personal field, reaches people the person did not mean it for | Any viewer | Off by default; turned on per viewer by the person; the note field says who will read it as they type (KV-32). | #31, #37, #40 | Decided |
| T12 | Data the person deleted, or withdrew, survives elsewhere | Any copy holder | Deletion travels as a tombstone; a revoked viewer's app deletes its copy on next contact, and one that never reconnects keeps it — a limit; partial deletion is tested as a flow because it looks like success. | #21, #45, #175 | Decided (KV-21: a tombstone wins over a copy coming back through restore or sync); #21, #45 to build. A rollback of the store file restores records and tombstones together — T7's limit |
| T13 | **A delivered card is altered, fabricated, replayed or dropped**, so a viewer reads a day that did not happen, or misses one that did | The relay; a network attacker; whoever breaches the relay | A per-viewer envelope — viewer id, stream number, previous envelope's hash, record — signed by the check-in device (Ed25519) and verified on the viewer's device before it is shown, so drops, renumbering, replays and reordering show, and a gap is shown as one (with #44); the pairing code derived from all four public keys; the daily summary composed from verified records only (KV-33). **Rests on the check-in device's signing key**, which is protected only as T7's data is: malware running as the person can sign forgeries. | #33, #39, #40, #42, #43, #175 | Decided; rests on #175 |
| T14 | **The check-in device is lost, broken, wiped or replaced**, and with it every share's authority: nothing can be revoked, and the person cannot see who still holds their check-ins | Accident; theft | A printed recovery card that can see who has access and end every share, never approve anyone new; using it is delayed 72 hours and announced to every viewer, and can be cancelled from the check-in device if it still exists, so a card misused to cut the person off alerts every caregiver instead of silencing them (KV-33). A replacement device starts fresh, each viewer approved again at it. **The history is recovered only if it was exported:** a restored export brings back the history and its baseline as of that export (KV-21); without one it goes with the device, or a backup (#175), and the baseline restarts from zero. | #33, #40, #45, #21 | Decided; #40, #45 to build; history loss a limit, unless exported (KV-21) |
| T15 | **The SmartSpectra API key at rest.** In development it is plain text in `.env`, beside `sessions.json`; a packaged install has no route to a key yet. A stolen key means vendor account abuse and billing, and reaches the metered record of when check-ins happen (T10) | The same actors as T7 | **Today**, only the operating system's account boundary, as for T7. How a packaged install receives and holds its key is #19's, and it is a data-at-rest question in the same sense as #175's. | #19, #175 | **Gap → #19** |
| T16 | **An exported history, read where it was put.** A complete, identified physiological history in plain JSON, copied by the person to a USB stick, a synced folder or an email (KV-21) — outside `userData`, so outside even T7's account boundary | Whoever finds or receives the file; the services it passes through | The screen that makes an export says it is the whole history, unprotected, and that it should be kept as carefully as the device. Whether an export is encrypted with a passphrase the person chooses is a question for #175, beside the store's own protection at rest. | #21, #175 | **A limit**; encryption → #175 |

Four of these are the ones most likely to be argued with. **T10 is live now**, not a Phase 5
risk: the vendor already receives when each check-in happened. **T2, T7 and T15 are the
check-in device's own weakness** — every remote defence above assumes the device is the
person's, and a shared family computer is exactly where this app is likely to sit. And
**T13 is the one whose failure makes a caregiver act on something that never happened.**

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
