import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CaptureResult, CheckInAnswers, SessionRecord } from '@core/session/types'
import { DEMO_PERSON_ID, DEMO_PERSON_NAME } from '@core/seed/persona'
import { hasScorableVitals, learningStatus, presentAll, usualReachStatus } from '@core/scoring'
import { DEFAULT_CAPTURE_SECONDS } from '@core/capture/length'
import {
  classifyCaptureError,
  classifyDashboardError,
  classifySubmitError,
  type CaptureFailure,
  type DashboardFailure,
  type SubmitFailure,
} from '@core/capture/failure'
import type { Protection } from '../shared/protection'
import { CARD_BOX, CHART_BOX } from './components/boxes'
import CaptureScreen from './components/CaptureScreen'
import ConfirmPersonRemoval from './components/ConfirmPersonRemoval'
import ConfirmRemoval from './components/ConfirmRemoval'
import HistoryPanel from './components/HistoryPanel'
import QuestionFlow from './components/QuestionFlow'
import SectionBoundary from './components/SectionBoundary'
import SetupScreen, { setupNeeded } from './components/SetupScreen'
import KeySettings from './components/KeySettings'
import NameField from './components/NameField'
import WhoIsReading from './components/WhoIsReading'
import {
  PERSON_BUTTON,
  PERSON_NOTE,
  PERSON_PRIMARY,
  useFocusWhenShown,
} from './components/person'
import type { CameraAccess } from '../shared/camera-access'
import type { KeyStatus } from '../shared/api-key'
import type { PeopleNow, PersonShown } from '../shared/people'
import SessionCard from './components/SessionCard'
import TrendChart from './components/TrendChart'
import { dashboardErrorText } from './dashboardError'

/**
 * What a finished capture actually produced.
 *
 * A capture that measured nothing must not read as a success: the first real
 * run came back with every metric null and a card that still said "reading
 * taken", which is the reassuring direction and the wrong one. The camera runs
 * for a fixed time whether or not the person is framed, so an empty result is
 * a normal outcome and has to say what to do about it.
 *
 * On the cared-for person's path, between the camera and the questions, so it
 * is sized as they are and takes focus as it appears (KV-20).
 */
function ReadingSummary({
  result,
  onRetake,
  onContinue,
}: {
  result: CaptureResult
  onRetake: () => void
  onContinue: () => void
}): React.JSX.Element {
  const { pulseRateBpm, breathingRateBrpm, hrvRmssdMs } = result.vitals
  const parts = [
    pulseRateBpm === null ? null : `pulse ${pulseRateBpm.toFixed(0)} bpm`,
    breathingRateBrpm === null ? null : `breathing ${breathingRateBrpm.toFixed(0)} br/min`,
    hrvRmssdMs === null ? null : `HRV ${hrvRmssdMs.toFixed(0)} ms`,
  ]
  const measured = parts.filter((part): part is string => part !== null)
  // Asked of the scorer rather than decided again here: the retake is offered
  // on exactly the question the scorer answers with `insufficient-signal`.
  const measuredSomething = hasScorableVitals(result.vitals)
  const heading = useFocusWhenShown<HTMLHeadingElement>()

  return (
    <div className="mb-8 rounded-xl border border-(--color-line) bg-(--color-raised) p-5">
      {!measuredSomething ? (
        <>
          <h2
            ref={heading}
            tabIndex={-1}
            className="text-xl font-semibold text-(--color-unknown)"
          >
            Nothing was measured
          </h2>
          <p className={`mt-1 ${PERSON_NOTE}`}>
            The camera ran, but no reading came out of it. That usually means the framing
            was not right for long enough — the face centred, chest in view, reasonably
            lit, and still.
          </p>
          <p className={`mt-1 ${PERSON_NOTE}`}>
            Another try is worth it. Either way the day is worth recording: a check-in
            that says the camera could not tell is still something a caregiver should
            see.
          </p>
        </>
      ) : (
        <>
          <h2 ref={heading} tabIndex={-1} className="text-xl font-semibold">
            Reading taken
          </h2>
          <p className={`mt-1 ${PERSON_NOTE}`}>{measured.join(' · ')}</p>
          {measured.length < parts.length && (
            <p className={`mt-1 ${PERSON_NOTE}`}>
              The rest did not settle in the time the camera ran.
            </p>
          )}
        </>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" onClick={onRetake} className={PERSON_BUTTON}>
          Try the camera again
        </button>
        <button type="button" onClick={onContinue} className={PERSON_BUTTON}>
          Answer the questions anyway
        </button>
      </div>
      {/* A failed camera reading is a fact about the day, not an error to
          swallow (KV-7). The questions still get answered and the check-in is
          still stored, with `insufficient-signal` as its verdict — because a
          discarded day and a day nobody sat down look identical in the history,
          and from three hours away that difference is the whole point (#44). */}
    </div>
  )
}

/**
 * The caregiver's view. This app is not used by the person being checked on —
 * every string on this screen is addressed to whoever looks after them, which
 * is the framing the whole product hangs on. Keep it that way.
 *
 * The loop closes here: a capture leads into the four questions, answering
 * them stores a scored session that appears in the list below, and the trend
 * above the list draws one metric over the baseline window (KV-4).
 */
export default function App(): React.JSX.Element {
  // Each press of "Try again" draws the screen from nothing: a new key for the
  // boundary and a fresh `Dashboard`, which loads the history again.
  const [attempt, setAttempt] = useState(0)

  // The last resort (KV-163). Everything that reads a record is contained
  // closer in — each card, the chart, the baseline lines, the capture and the
  // questions — so this is for a throw in the screen's own code. It covers the
  // screens the cared-for person reads too, so the sentence names no one.
  //
  // Whatever it catches, a capture may be running: the camera would stay on,
  // with the Stop button gone, until its ceiling (review of #164). So it is
  // abandoned — asking when none is running does nothing. And the way out is
  // "Try again", not a restart: a throw that happens every time happens after
  // a restart too, and the inner boundaries keep a record that always throws
  // from ever reaching here.
  return (
    <SectionBoundary
      as="main"
      fallback="Kinvue could not show this screen. Nothing saved has been changed."
      className="mx-auto max-w-3xl px-6 py-10"
      resetKey={attempt}
      onFailure={() => {
        void window.kinvue.cancelCapture().catch(() => {
          // Nothing to add: the screen already says it could not be shown.
        })
      }}
      onRetry={() => setAttempt((n) => n + 1)}
    >
      <Dashboard key={attempt} />
    </SectionBoundary>
  )
}

/**
 * Where their usual stands, while it is still learning (KV-17) and once it
 * reaches far back (KV-154). Its own section: both read every record, and a
 * line about the baseline that cannot be worked out must not cost the page
 * (review of #164). Null lines draw nothing — no check-ins, or nothing to say.
 */
function BaselineStatus({
  sessions,
  personId,
  name,
}: {
  sessions: SessionRecord[]
  personId: string
  name: string
}): React.JSX.Element {
  const learning = useMemo(
    () => learningStatus(sessions, personId, name),
    [sessions, personId, name],
  )
  // Measured to when the check-ins last changed, which is when this page last
  // had anything new.
  const reach = useMemo(
    () => usualReachStatus(sessions, personId, name, new Date()),
    [sessions, personId, name],
  )
  return (
    <>
      {learning !== null && <p className="mt-3 text-sm">{learning}</p>}
      {reach !== null && <p className="mt-3 text-sm">{reach}</p>}
    </>
  )
}

/**
 * Whose check-ins the dashboard shows (KV-18): whoever was chosen at the top,
 * the demo among them, while they are still here; otherwise the first person
 * on the list; otherwise the demo, so a computer that has only seeded it shows
 * it. Null when there is nobody and no demo.
 */
function viewedOf(now: PeopleNow, wanted: string | null): string | null {
  if (wanted === DEMO_PERSON_ID && now.demo) return DEMO_PERSON_ID
  if (wanted !== null && now.people.some((p) => p.id === wanted)) return wanted
  const first = now.people[0]
  if (first !== undefined) return first.id
  return now.demo ? DEMO_PERSON_ID : null
}

/**
 * What a person not yet named is called where a sentence needs a name. Shown
 * only: whether someone is named is `name === null`, never this string, which
 * someone could choose as a name (review of #200).
 */
const UNNAMED = 'This person'

/** A button at the top choosing whose check-ins are shown, and the one chosen. */
const SWITCH = 'rounded-lg border px-3 py-1 text-sm'
const SWITCH_ON = 'border-(--color-ink) font-medium'

/** A quiet control of the caregiver's, drawn as the delete links are. */
const LINK = 'text-(--color-muted) underline underline-offset-2 hover:text-(--color-ink)'

function Dashboard(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null)
  // The sentence, and which failure it is: an unreadable history is the one
  // that offers a way out (KV-98), so the box needs to know which it is showing.
  const [error, setError] = useState<{ text: string; failure: DashboardFailure } | null>(null)
  // Said once a new history has been started, naming where the old one went.
  const [notice, setNotice] = useState<string | null>(null)
  // A press on a button that touches the store, still in flight. Two presses of
  // "Start a new history" would race in main and put a success and a failure on
  // screen at once (KV-98 review); seeding has the same shape.
  const [busy, setBusy] = useState(false)
  const [capturing, setCapturing] = useState(false)
  // Asked of main rather than assumed: the countdown and the sentence under
  // the button both have to be the length a capture will actually run (#63).
  // The same constant main defaults to, so the one render before the answer
  // arrives is right whenever the setting is unset.
  const [captureSeconds, setCaptureSeconds] = useState(DEFAULT_CAPTURE_SECONDS)
  const [captureFailure, setCaptureFailure] = useState<CaptureFailure | null>(null)
  const [answering, setAnswering] = useState<CaptureResult | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitFailure, setSubmitFailure] = useState<SubmitFailure | null>(null)
  const captureGeneration = useRef(0)
  const [reading, setReading] = useState<CaptureResult | null>(null)
  // The card whose deletion is being confirmed under it (KV-21), if any.
  const [deleting, setDeleting] = useState<string | null>(null)
  // When the history was last exported: null for never, undefined until known.
  const [lastExported, setLastExported] = useState<string | null | undefined>(undefined)
  // Whether Windows lets Kinvue use the camera (KV-19): undefined until known.
  // Off, the setup screen is shown in place of this one, until the person
  // turns it on or goes past it to read the check-ins.
  const [camera, setCamera] = useState<CameraAccess | undefined>(undefined)
  // Where the household's SmartSpectra key stands (KV-19): undefined until
  // known. Missing, it is asked for on the same setup screen.
  const [keyStatus, setKeyStatus] = useState<KeyStatus | undefined>(undefined)
  // The last reading was refused by the service, or its key was: the key
  // section at the foot of the page says the key may be the cause.
  const [keySuspect, setKeySuspect] = useState(false)
  const [pastSetup, setPastSetup] = useState(false)
  // Who takes readings here, and whether the demo has days to show (KV-18):
  // undefined until known, null when it could not be asked — the dashboard's
  // error says why, and no name is asked for over a list nobody could read.
  const [people, setPeople] = useState<PeopleNow | null | undefined>(undefined)
  // Whose check-ins are wanted, chosen at the top: a person's id, the demo's,
  // or null for the first person. A ref, read by `refresh` when it runs, not a
  // state it closes over: the closure was what let a reload started before a
  // switch land after it (review of #200).
  const wanted = useRef<string | null>(null)
  // The choice the screen shows now: what `wanted` goes back to when the reload
  // asked for by a switch fails, so the switch pressed next is not honoured by
  // some later reload, a deletion's say (second review of #200).
  const wantShown = useRef<string | null>(null)
  // Whose check-ins `sessions` are: set with them, by the same reload, so the
  // heading, the usual and the trend are always about the records shown.
  const [viewedId, setViewedId] = useState<string | null>(null)
  // Everyone who takes readings here (KV-18). The demo is never one of them.
  const readers: PersonShown[] = people?.people ?? []
  // Someone whose check-ins are here but who has not been named: a history
  // from before KV-18, or a name this build could not hold (second review of
  // #200). The setup screen asks for one name at a time.
  const unnamed: PersonShown | undefined = readers.find((p) => p.name === null)
  // Nobody to take a reading, or someone not told whose check-ins are whose:
  // the setup screen asks (KV-18). For the whole household, not only whoever
  // sits down: today an unnamed person comes only from a history from before
  // KV-18 or a name this build could not hold, each one person on their own.
  // Restore by key (#18's third PR) can bring one in beside others, and is
  // where this is scoped to the reader if it must be (review of #203).
  const nameNeeded = people != null && (readers.length === 0 || unnamed !== undefined)
  // *Who is taking the reading?* is open (KV-18).
  const [choosing, setChoosing] = useState(false)
  // Who the reading running now is for: its answers are stored as theirs, and
  // their name is on the capture and the questions where more than one person
  // takes readings. One state for both, so the name shown and the person filed
  // under cannot drift apart — a ref beside it once could (review of #203).
  const [readingFor, setReadingFor] = useState<string | null>(null)
  const readingName =
    readers.length > 1 ? (readers.find((p) => p.id === readingFor)?.name ?? null) : null
  // Adding someone, renaming them, or deleting them, from the dashboard
  // (KV-18). A rename or a deletion holds whom it is about from the moment it
  // opens, and closes when another person is shown: read from `viewedId` as it
  // saved, a rename renamed whoever the switcher had moved to since (review of
  // #203).
  const [changing, setChanging] = useState<
    | { what: 'add' }
    | { what: 'rename' | 'delete'; id: string; name: string }
    | null
  >(null)
  const demoShown = viewedId === DEMO_PERSON_ID
  // Null when the person shown has not been named yet.
  const viewedName = demoShown
    ? DEMO_PERSON_NAME
    : (people?.people.find((p) => p.id === viewedId)?.name ?? null)
  // Which reload is the latest: only its answer is shown (review of #200).
  const loads = useRef(0)
  // Back on the dashboard from the camera, the questions or the setup screen,
  // focus goes to its heading (KV-20): the button pressed to leave — Stop, Go
  // back, Finish, Go to the check-ins — is gone, and focus left on nothing
  // starts a screen reader from the top. Not when a reading is waiting: its
  // card takes focus itself. A layout effect, as `useFocusWhenShown` is, so
  // focus moves in the commit that draws the dashboard rather than resting on
  // the page a moment first (review of #202).
  //
  // The setup screen counts because Take a reading can open it, when the
  // camera is off or the key is missing (review of #196); it is also where a
  // first run starts.
  const showingSetup =
    camera !== undefined &&
    keyStatus !== undefined &&
    setupNeeded(camera, keyStatus, nameNeeded) &&
    !pastSetup
  const away = capturing || answering !== null || showingSetup || choosing
  const wasAway = useRef(away)
  const dashboardHeading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    if (wasAway.current && !away && reading === null) dashboardHeading.current?.focus()
    wasAway.current = away
  }, [away, reading])
  // Where its protection stands (KV-175): undefined until known.
  const [protection, setProtection] = useState<Protection | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++loads.current
    const latest = (): boolean => mine === loads.current
    const asked = wanted.current
    let now: PeopleNow
    let id: string | null
    let listed: SessionRecord[]
    try {
      now = await window.kinvue.listPeople()
      // Set at once, before the check-ins are asked for: a list that then fails
      // to load still leaves the screen knowing who is here, so it is drawn with
      // the error rather than waiting. Who is here is the same answer whichever
      // reload fetched it.
      if (latest()) setPeople(now)
      id = viewedOf(now, asked)
      listed = id === null ? [] : await window.kinvue.listSessions(id)
    } catch (e) {
      // Only the latest reload says what went wrong: a failure of one a later
      // reload has answered since would stand over the screen it drew, and
      // could offer *Start a new history* for a file that reads (second review
      // of #200).
      if (!latest()) return
      // Known not to be known, so the screen is drawn with the error, rather
      // than waiting on a list that is not coming.
      setPeople((was) => was ?? null)
      wanted.current = wantShown.current
      throw e
    }
    // A later reload began while this one waited — a switch pressed, a seed —
    // and its answer is the one to show. Landing after it, this one put a real
    // person's check-ins under the demo's heading (review of #200).
    if (!latest()) return
    wantShown.current = asked
    setViewedId(id)
    setSessions(listed)
    // The file just read may not be the one the protection line described — a
    // new history started, a restore written (review of #187) — so it is asked
    // again here. Not worth a screen: the line is all it feeds.
    window.kinvue.historyProtection().then(setProtection, (e: unknown) => {
      console.error('Could not read whether the history is encrypted.', e)
    })
    // A list that loaded is the current state of the screen, so an earlier
    // failure to load it is no longer true (KV-95 review). The post-submit
    // sentence is set only after its own refresh has failed, so this never
    // clears it. The new-history notice goes the same way: it describes a
    // moment, and a later reload is a later moment (KV-98 review).
    setError(null)
    setNotice(null)
  }, [])

  /** Shows a person's check-ins, or the demo's, as chosen at the top (KV-18). */
  const show = (id: string): void => {
    wanted.current = id
    setChanging(null)
    void refresh().catch((e: unknown) => showFailure(e, 'The check-ins could not be shown.'))
  }

  // An unreadable history says so in its own words; anything else gets a plain
  // sentence here and the original in the console (KV-95).
  const showFailure = useCallback((e: unknown, fallback: string): void => {
    console.error(e)
    setError({ text: dashboardErrorText(e, fallback), failure: classifyDashboardError(e) })
  }, [])

  useEffect(() => {
    void refresh().catch((e: unknown) => showFailure(e, 'The check-ins could not be shown.'))
  }, [refresh, showFailure])

  useEffect(() => {
    // Not worth a screen: the fallback is the default, so a failure here is
    // invisible when the setting is unset. It is *not* harmless when it is set
    // — the button would promise 30 seconds while the capture runs 60, and the
    // countdown would reach "Finishing up" half a minute early — so the failure
    // is recorded rather than swallowed.
    void window.kinvue.captureSeconds().then(setCaptureSeconds, (err: unknown) => {
      console.error('Could not read the capture length; using the default.', err)
    })
  }, [])

  const loadLastExported = useCallback(async (): Promise<void> => {
    setLastExported(viewedId === null ? null : await window.kinvue.lastExported(viewedId))
  }, [viewedId])

  useEffect(() => {
    // Not worth a screen: the line beside the export control is all it feeds.
    void loadLastExported().catch((e: unknown) => {
      console.error('Could not read when the history was last exported.', e)
    })
  }, [loadLastExported])

  // KV-175. Where the history's protection stands — asked again every few
  // seconds while the file is still plain, so the line moves to "encrypted"
  // once the seal lands on disk, and every thirty after that: "encrypted" is
  // not taken as final, so the line cannot go on saying it over a file that has
  // changed (review of #187). Asking changes nothing in main.
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = (): void => {
      window.kinvue.historyProtection().then(
        (now) => {
          if (stopped) return
          setProtection(now)
          timer = setTimeout(ask, now === 'not-yet-encrypted' ? 3000 : 30_000)
        },
        (e: unknown) => console.error('Could not read whether the history is encrypted.', e),
      )
    }
    ask()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  /**
   * The one export (KV-21), for the panel's button and the confirm screen's
   * "Export first" alike (review of #185): the second used to say nothing, and
   * leave the panel's line reading "never", on the screen before a deletion.
   * Resolves to what to say, or null when cancelled — or when it failed, which
   * it has already said.
   */
  const exportHistory = useCallback(async (passphrase?: string): Promise<string | null> => {
    if (viewedId === null) return null
    try {
      const made = await window.kinvue.exportHistory(viewedId, passphrase)
      if (made === null) return null
      await loadLastExported().catch((e: unknown) => {
        console.error('Could not read when the history was last exported.', e)
      })
      const count = `${String(made.count)} check-in${made.count === 1 ? '' : 's'}`
      return made.protected
        ? `Exported ${count}, protected with the passphrase.`
        : `Exported ${count}, without a passphrase.`
    } catch (e) {
      showFailure(e, 'The history could not be exported.')
      return null
    }
    // `viewedId` named, not left to `loadLastExported` dragging it along: the
    // export is of whoever is shown, and a closure over the last one exported
    // the wrong person's history (review of #200).
  }, [viewedId, loadLastExported, showFailure])

  // KV-98. The caregiver's choice, never automatic. Main re-checks before it
  // moves anything, so a history that has become readable since the error was
  // shown comes back as null and is simply loaded.
  const startNewHistory = async (): Promise<void> => {
    setBusy(true)
    try {
      let aside: string | null
      try {
        aside = await window.kinvue.startNewHistory()
      } catch (e) {
        // The press failed, but the history is no less unreadable than it was a
        // second ago, so the way out stays on screen (KV-98 review): a file an
        // antivirus scan or a backup held for a moment is free on the next go.
        // A failure that has words of its own — the file turned out to be from
        // a newer version, or could not be opened — says those instead.
        console.error(e)
        const failure = classifyDashboardError(e)
        setError(
          failure === 'unknown'
            ? {
                text:
                  'The old history could not be set aside just now, so nothing was moved. ' +
                  'It is worth another go.',
                failure: 'store-unreadable',
              }
            : { text: dashboardErrorText(e, ''), failure },
        )
        return
      }
      try {
        await refresh()
      } catch (e) {
        // The file was set aside; where it went must not be lost with the list.
        showFailure(
          e,
          aside === null
            ? 'The list could not be reloaded.'
            : 'A new, empty history was started for everyone on this computer. The old file, ' +
                `with everyone's check-ins and names, was kept unchanged as ${aside}. ` +
                'The list could not be reloaded.',
        )
        return
      }
      setNotice(
        aside === null
          ? 'The history could be read after all, so nothing was moved.'
          : 'A new, empty history was started for everyone on this computer. The old file, ' +
            `with everyone's check-ins and names, was kept unchanged as ${aside}.`,
      )
    } finally {
      setBusy(false)
    }
  }

  // Two steps that fail differently. Seeding can succeed and the reload after
  // it fail — a sync client briefly holding the file — and "could not be added"
  // would then be false with a fortnight sitting in it (KV-95 review). The
  // submit path makes the same split for the same reason.
  const seed = async (): Promise<void> => {
    setBusy(true)
    try {
      await seedThenReload()
    } finally {
      setBusy(false)
    }
  }

  const seedThenReload = async (): Promise<void> => {
    try {
      await window.kinvue.seedDemo()
    } catch (e) {
      showFailure(e, 'The demo history could not be added.')
      return
    }
    // The demo is a person of its own (KV-18): seeded, it is what is shown —
    // by the reload below, which reads the choice when it runs.
    wanted.current = DEMO_PERSON_ID
    await refresh().catch((e: unknown) =>
      showFailure(e, 'The demo history was added, but the list could not be reloaded.'),
    )
  }

  // What each card says, composed as it is shown (KV-138): a real check-in
  // keeps its verdict in today's words, and a seeded day is scored by today's
  // rules (KV-103) — both inside `presentAll`. It rescores the whole history,
  // so it runs when the check-ins change, not on every render: the capture
  // screen's countdown alone re-renders once a second.
  //
  // A record that cannot be presented is its own card's failure, not the
  // page's (review of #164): this runs above every card's boundary, so a throw
  // here once took the whole screen, and "Start a new history" — the one way
  // out of a store the app cannot handle — with it. Its card says it could not
  // be shown; it is never drawn with no presentation, which reads "Not enough
  // to say".
  const [shown, unshown] = useMemo(() => {
    const failed = new Set<string>()
    const map = presentAll(sessions ?? [], (record, e) => {
      console.error(`Check-in ${record.id} could not be presented.`, e)
      failed.add(record.id)
    })
    return [map, failed] as const
  }, [sessions])
  const newest = useMemo(() => [...(sessions ?? [])].reverse(), [sessions])

  /**
   * Started here, on the press, rather than inside the capture screen. Opening
   * the camera cannot be undone, and React runs an effect twice in development
   * — which asked main for two captures and had the second refused.
   */
  // Asks main again each time: a switch can be turned on, or off, at any time.
  const askCamera = useCallback(async (): Promise<CameraAccess> => {
    const now = await window.kinvue.cameraAccess()
    setCamera(now)
    return now
  }, [])

  useEffect(() => {
    // Not worth a screen if it cannot be asked: the dashboard is drawn, and a
    // capture says what is wrong.
    void askCamera().catch((e: unknown) => {
      console.error('Could not read whether the camera is allowed.', e)
      setCamera('unknown')
    })
  }, [askCamera])

  // Where the key stands (KV-19). Not asked, it is `unknown`: the dashboard is
  // drawn without asking for a key, and a capture without one says so. Not
  // `environment`, which would tell a household it runs a development build
  // and hide the control that could fix it (review of #195).
  useEffect(() => {
    window.kinvue.apiKeyStatus().then(setKeyStatus, (e: unknown) => {
      console.error('Could not read where the SmartSpectra key stands.', e)
      setKeyStatus('unknown')
    })
  }, [])

  // Starts a capture with no checks at all. Only `readAs`, below, calls it, and
  // only `beginReading` reaches that: every button that starts a reading goes
  // through it, so Windows is asked about the camera first (review of #193).
  const startCaptureUnchecked = useCallback((personId: string): void => {
    setReadingFor(personId)
    setReading(null)
    setCaptureFailure(null)
    setCapturing(true)

    // Which capture this is. A stopped capture still resolves in main, and
    // without this its reading arrived half a minute later and appeared on the
    // dashboard — a card for a run the person deliberately abandoned, or worse,
    // one that yanked them off an error screen.
    const started = ++captureGeneration.current

    window.kinvue
      .capture(personId)
      .then((result) => {
        if (started !== captureGeneration.current) return
        setCapturing(false)
        // A reading the service accepted: the last one was not refused after all
        // (review of #195), so the key section stops saying it may be the key.
        setKeySuspect(false)
        // The reading stays in main. What crosses back is its id, and the
        // questions are what turn it into a check-in. A capture that measured
        // nothing is shown first: answering four questions about a reading
        // that does not exist should be a choice, not something that happens.
        if (hasScorableVitals(result.vitals)) setAnswering(result)
        else setReading(result)
      })
      .catch((e: unknown) => {
        if (started !== captureGeneration.current) return
        const failure = classifyCaptureError(e)
        // Null is cancellation: nothing to say, and nothing left to show it on
        // either. Leaving `capturing` true would keep the capture screen up —
        // frozen self-view, a countdown stuck at its last tick and a Stop button
        // — for a capture that has already ended, shown to the one person in
        // this app who is being filmed. Today the generation guard in
        // `stopCapture` means a user-pressed stop never reaches here, but that
        // is an invariant in another file, and a cancellation the person did
        // not ask for would arrive on exactly this path.
        if (failure === null) {
          setCapturing(false)
          return
        }
        // The key missing or refused, or the service refusing the reading: the
        // key section says the key may be why (KV-19).
        if (failure === 'no-api-key' || failure === 'service-refused') setKeySuspect(true)
        setCaptureFailure(failure)
      })
  }, [])

  /** Stops the camera, then leaves the screen. */
  const stopCapture = useCallback((): void => {
    captureGeneration.current++
    setCapturing(false)
    void window.kinvue.cancelCapture().catch(() => {
      // Nothing useful to say: the screen is already gone and the capture is
      // abandoned either way.
    })
  }, [])

  /** Submits the answers against the reading main is holding. */
  const submit = useCallback(
    (answers: CheckInAnswers): void => {
      const personId = readingFor
      if (answering === null || personId === null) return
      setSubmitting(true)
      setSubmitFailure(null)

      window.kinvue
        .submit(personId, answering.captureId, answers)
        .then(async () => {
          // The check-in is stored by the time this runs, so a refresh that
          // fails now is a stale list, not a lost check-in — and it has to be
          // said on the dashboard, because `submitError` is rendered only by
          // the screen that clearing `answering` unmounts. Dropped silently, it
          // sent the person back to take a second reading of the same moment,
          // which would then enter the baseline twice.
          await refresh().catch((e: unknown) => {
            // The sentence is deliberate (KV-95), but which failure it is still
            // decides whether the way out is offered, and the original is kept.
            console.error(e)
            setError({
              text: 'The check-in was saved, but the list could not be reloaded.',
              failure: classifyDashboardError(e),
            })
          })
          setAnswering(null)
          setReading(null)
          setSubmitting(false)
        })
        .catch((e: unknown) => {
          setSubmitting(false)
          setSubmitFailure(classifySubmitError(e))
        })
    },
    [answering, readingFor, refresh],
  )

  /**
   * Every way a reading starts — *Take a reading*, and *Try the camera again*
   * for `personId` — so the guards hold for each (review of #203). In order:
   * nobody to take it, or someone not told whose the check-ins are, goes to the
   * setup screen (KV-18); then Windows is asked about the camera, and one
   * turned off since, or a key not there, is said on the setup screen, not by a
   * capture that cannot run; then, with more than one person and nobody chosen,
   * who is taking it. The camera before the names, so a name pressed is never
   * dropped on the setup screen (review of #203). Never the demo.
   */
  const beginReading = (personId: string | null): void => {
    if (people === null) {
      setNotice(
        'Kinvue could not tell whose check-ins these are, so a reading cannot start. ' +
          'Nothing has been changed.',
      )
      return
    }
    if (nameNeeded) {
      setPastSetup(false)
      return
    }
    // More than one person: they say who they are (KV-18), never whoever the
    // dashboard happens to show. With one, nothing is asked.
    const who = personId ?? (readers.length === 1 ? (readers[0]?.id ?? null) : null)
    const next = (): void => (who === null ? setChoosing(true) : readAs(who))
    void askCamera().then(
      (now) => {
        // Known by the time a reading can be asked for: the dashboard is
        // not drawn until it is.
        if (keyStatus !== undefined && setupNeeded(now, keyStatus, false)) setPastSetup(false)
        else next()
      },
      // Not asked: the capture is tried, and says what is wrong if it fails.
      next,
    )
  }
  const takeReading = (): void => beginReading(null)

  /**
   * The capture for `personId`, opened in the same commit that closes the
   * names: in between, the dashboard drew and took focus under whoever it was
   * showing (review of #203).
   */
  const readAs = (personId: string): void => {
    setChoosing(false)
    // Back to the person whose reading it is, so a card a capture leaves on the
    // dashboard is shown with their check-ins, not the demo's or another's.
    // Asked of `wanted`, not `viewedId`: the screen lags a switch still on its
    // way, and asked of it, the reading came back to the demo (review of #203).
    if (wanted.current !== personId) show(personId)
    startCaptureUnchecked(personId)
  }

  if (capturing) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        {/* A capture screen that cannot be drawn takes its Stop button with it,
            and unmounting it does not stop the camera — only `stopCapture`
            does (review of #164). So the failure stops it, as a press would,
            and the dashboard says what happened. */}
        <SectionBoundary
          fallback="The camera screen could not be shown."
          className=""
          onFailure={() => {
            stopCapture()
            setNotice(
              'The camera screen could not be shown, so the camera was stopped and nothing ' +
                'was recorded. Taking the reading again is worth a try.',
            )
          }}
        >
          <CaptureScreen
            failure={captureFailure}
            onCancel={stopCapture}
            captureSeconds={captureSeconds}
            name={readingName}
          />
        </SectionBoundary>
      </main>
    )
  }

  if (answering !== null) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        {/* The reading main holds stays submittable for fifteen minutes, and
            questions that cannot be drawn must not make it unreachable — the
            loss "Not now" below goes out of its way to prevent (review of
            #164). It goes back to the dashboard, where "Answer the questions
            anyway" offers it again. */}
        <SectionBoundary
          fallback="The questions could not be shown."
          className=""
          onFailure={() => {
            setReading(answering)
            setAnswering(null)
            setSubmitFailure(null)
            setNotice(
              'The questions could not be shown. The reading is kept below, and answering ' +
                'them again is worth a try.',
            )
          }}
        >
          <QuestionFlow
            onDone={submit}
            onCancel={() => {
              // Nothing is stored, which is the honest outcome of a check-in
              // someone chose not to finish. But main holds that reading as
              // submittable for another fifteen minutes, so it goes back to the
              // dashboard rather than becoming unreachable — "Not now" sits
              // under the answer buttons on a screen built for an unsteady hand,
              // and a mis-tap there should not cost a good 30-second reading.
              setReading(answering)
              setAnswering(null)
              setSubmitFailure(null)
            }}
            submitting={submitting}
            failure={submitFailure}
            name={readingName}
          />
        </SectionBoundary>
      </main>
    )
  }

  if (choosing) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        {/* Contained like the other screens on the path (KV-163): one that
            cannot be drawn goes back to the dashboard and says so. */}
        <SectionBoundary
          fallback="The names could not be shown."
          className=""
          onFailure={() => {
            setChoosing(false)
            setNotice('The names could not be shown, so no reading was started.')
          }}
        >
          <WhoIsReading
            people={readers}
            onChoose={(person) => readAs(person.id)}
            onCancel={() => setChoosing(false)}
          />
        </SectionBoundary>
      </main>
    )
  }

  // Nothing until Windows has answered — a moment, three registry reads — so
  // the dashboard is never drawn only to be replaced by the setup screen
  // (review of #193). The first state that picks a whole screen, unlike the
  // others above, which feed a line of text.
  if (camera === undefined || keyStatus === undefined || people === undefined) {
    return <main className="mx-auto max-w-3xl px-6 py-10" />
  }

  // Before the first reading (KV-19): a camera Windows keeps Kinvue from, or no
  // key to read it with, is said here, not after a capture fails. Going past it
  // reads the check-ins. The same test as focus's, so the two cannot disagree.
  if (showingSetup) {
    return (
      <SetupScreen
        camera={camera}
        keyStatus={keyStatus}
        nameNeeded={nameNeeded}
        unnamed={unnamed ?? null}
        // Nobody here has taken a reading, by the store's count of every
        // record. A list that could not be read is "next": "first" is never
        // said over a history.
        firstReading={people !== null && !people.checkedIn}
        onCheckAgain={askCamera}
        onKeyKept={setKeyStatus}
        onNamed={() => {
          void refresh().catch((e: unknown) =>
            showFailure(e, 'The name was saved, but the check-ins could not be shown.'),
          )
        }}
        onContinue={() => setPastSetup(true)}
      />
    )
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      {/* Whose check-ins are shown (KV-18): one person at a time, chosen here,
          the demo a person of its own after them. Only when there is a choice.
          The caregiver's view: who takes a reading is asked at the button. */}
      {people !== null && readers.length + (people.demo ? 1 : 0) > 1 && (
        <SectionBoundary
          fallback="Whose check-ins are shown could not be chosen here."
          className="mb-4"
        >
          <nav aria-label="Whose check-ins are shown" className="mb-4 flex flex-wrap gap-2">
            {readers.map((person) => (
              <button
                key={person.id}
                type="button"
                aria-pressed={viewedId === person.id}
                onClick={() => show(person.id)}
                className={`${SWITCH} ${
                  viewedId === person.id ? SWITCH_ON : 'border-(--color-line)'
                }`}
              >
                {person.name ?? UNNAMED}
              </button>
            ))}
            {people.demo && (
              <button
                type="button"
                aria-pressed={demoShown}
                onClick={() => show(DEMO_PERSON_ID)}
                className={`${SWITCH} ${demoShown ? SWITCH_ON : 'border-(--color-line)'}`}
              >
                The demo
              </button>
            )}
          </nav>
        </SectionBoundary>
      )}

      <header className="mb-8">
        <h1 ref={dashboardHeading} tabIndex={-1} className="text-2xl font-semibold">
          {/* One string, so it is read as one name. The demo's says it is the
              demo first: a real person may be called Margaret too, and the
              two must not differ only by a word in brackets (review of #200). */}
          {demoShown
            ? `The demo: ${DEMO_PERSON_NAME}’s invented check-ins`
            : viewedName === null
              ? 'Check-ins'
              : `${viewedName}’s check-ins`}
        </h1>
        <p className="mt-1 text-sm text-(--color-muted)">
          {demoShown
            ? 'Invented days, for seeing the dashboard with a usual behind it. They are ' +
              'nobody’s, and no reading is ever added to them.'
            : 'A daily look at whether today is different from their own usual. Not a ' +
              'diagnosis, and not an emergency alert.'}
        </p>
        {sessions !== null && viewedId !== null && (
          <SectionBoundary
            fallback="Where their usual stands could not be shown."
            className="mt-3"
            resetKey={sessions}
          >
            <BaselineStatus
              sessions={sessions}
              personId={viewedId}
              name={viewedName ?? UNNAMED}
            />
          </SectionBoundary>
        )}
      </header>

      {/* Where the cared-for person's path starts, so sized as the rest of it
          is (KV-20), on a dashboard that is otherwise the caregiver's. */}
      <div className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" onClick={takeReading} className={PERSON_PRIMARY}>
          Take a reading
        </button>
        <span className={PERSON_NOTE}>
          Up to {captureSeconds} seconds in front of the camera.
        </span>
      </div>

      {reading !== null && (
        <ReadingSummary
          result={reading}
          // The same person again: a retake is the reading just tried.
          onRetake={() => beginReading(readingFor)}
          onContinue={() => {
            setAnswering(reading)
            setReading(null)
          }}
        />
      )}

      {error !== null && (
        <div className="mb-6 rounded-lg border border-(--color-line) p-4 text-sm">
          {/* An alert, which is spoken as it appears (review of #196): only the
              sentence, not the way out below it, which is read in its turn. */}
          <p role="alert" className="text-(--color-elevated)">
            {error.text}
          </p>
          {/* Never for a key store that is only out of reach (store-locked): that
              history opens once it is reachable, and setting it aside would move
              a readable history (KV-175, review of #186). */}
          {(error.failure === 'store-unreadable' || error.failure === 'store-undecryptable') && (
            <>
              <p className="mt-2 text-(--color-muted)">
                This sets aside everyone&rsquo;s check-ins on this computer, and their names,
                in the old file, and starts an empty history for everyone. The old file is kept
                as it is, renamed beside it: nothing in it is deleted.
              </p>
              <button
                type="button"
                onClick={() => void startNewHistory()}
                disabled={busy}
                className="mt-3 rounded-lg border border-(--color-line) px-4 py-2 hover:bg-(--color-raised)"
              >
                Start a new history
              </button>
            </>
          )}
        </div>
      )}

      {/* Said as well as shown (review of #196). Several are written for the
          way back from the person's path — the camera stopped, the questions
          that could not be drawn, a check-in saved but not reloaded — and focus
          lands on the heading above them, so unannounced they went unheard.
          The region is always there, so a notice arriving in it is spoken: one
          drawn already holding its text often is not. */}
      <div role="status">
        {notice !== null && (
          <p className="mb-6 rounded-lg border border-(--color-line) p-4 text-sm text-(--color-muted)">
            {notice}
          </p>
        )}
      </div>

      {sessions !== null && sessions.length === 0 && (
        <div className="rounded-xl border border-dashed border-(--color-line) p-8 text-center">
          <p className="text-sm text-(--color-muted)">
            No check-ins yet. Take a reading to start, or seed the demo&rsquo;s history to
            see the dashboard with a baseline behind it. The demo is a person of its own:
            its days never count towards anyone&rsquo;s usual.
          </p>
          <button
            type="button"
            onClick={() => void seed()}
            disabled={busy}
            className="mt-4 rounded-lg border border-(--color-line) px-4 py-2 text-sm hover:bg-(--color-raised)"
          >
            Seed demo history
          </button>
        </div>
      )}

      {/* Each section contained on its own (KV-163): one that cannot be drawn
          leaves a sentence in its place, not an empty window. */}
      {sessions !== null && sessions.length > 0 && viewedId !== null && (
        <SectionBoundary
          fallback={
            'The trend could not be drawn. ' +
            'The check-ins themselves are still saved, and listed below.'
          }
          className={CHART_BOX}
          resetKey={sessions}
        >
          <TrendChart records={sessions} personId={viewedId} />
        </SectionBoundary>
      )}

      <div className="space-y-4">
        {viewedId !== null && newest.map((session) => (
          <SectionBoundary
            key={session.id}
            fallback="This check-in could not be shown. It is still saved, unchanged."
            className={CARD_BOX}
            resetKey={session}
            alreadyFailed={unshown.has(session.id)}
          >
            <SessionCard session={session} presentation={shown.get(session.id) ?? null} />
            {/* Outside the card, which the caregiver's client draws too (KV-34):
                deleting is the person's, at their own device (KV-21). */}
            {deleting === session.id ? (
              <ConfirmRemoval
                sessions={sessions ?? []}
                personId={viewedId}
                name={viewedName}
                which={{ kind: 'one', id: session.id }}
                onExport={exportHistory}
                onCancel={() => setDeleting(null)}
                onFailure={(e) =>
                  showFailure(e, 'The check-in could not be deleted. Nothing has been changed.')
                }
                onDone={async (removed) => {
                  setDeleting(null)
                  await refresh()
                  setNotice(
                    removed === 1 ? 'Deleted 1 check-in.' : `Deleted ${String(removed)} check-ins.`,
                  )
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setDeleting(session.id)}
                className="mt-2 text-xs text-(--color-muted) underline-offset-2 hover:underline"
              >
                Delete this check-in&hellip;
              </button>
            )}
          </SectionBoundary>
        ))}
      </div>

      {sessions !== null && viewedId !== null && (
        // Contained like every other section (KV-163, review of #185).
        <SectionBoundary
          fallback={
            'Exporting, restoring and deleting could not be shown here. ' +
            'The check-ins themselves are unchanged.'
          }
          className="mt-10"
          resetKey={sessions}
        >
          <HistoryPanel
            personId={viewedId}
            name={viewedName}
            sessions={sessions}
            lastExported={lastExported}
            protection={protection}
            onExport={exportHistory}
            onChanged={refresh}
            // Whoever the file went into, which the file decided (KV-18).
            onRestored={async (into) => {
              wanted.current = into.personId
              setChanging(null)
              // Someone added without a name: the dashboard stays, saying what
              // the restore did, and offers to name them, rather than the setup
              // screen in its place with the sentence gone. A reading asks for
              // the name first, as it would anyway (review of #206's shape).
              if (into.added === 'unnamed') setPastSetup(true)
              await refresh()
            }}
            onFailure={showFailure}
          />
        </SectionBoundary>
      )}

      {/* Adding someone, renaming and deleting them (KV-18): the caregiver's, so down
          here with the history, not beside *Take a reading*, which starts the
          cared-for person's path (review of #203). Never the demo: it is
          nobody, and its name is not anyone's to change. Contained like every
          other section (KV-163). */}
      {people !== null && (
        <SectionBoundary
          fallback={
            'Adding, renaming and deleting people could not be shown here. ' +
            'Nobody has been changed.'
          }
          className="mt-10"
        >
          <section
            aria-labelledby="people-heading"
            className="mt-10 border-t border-(--color-line) pt-6 text-sm"
          >
            <h2 id="people-heading" className="text-base font-semibold">
              People on this computer
            </h2>
            <div className="mt-3">
              {changing === null ? (
                <div className="flex flex-wrap gap-4">
                  <button
                    type="button"
                    onClick={() => setChanging({ what: 'add' })}
                    className={LINK}
                  >
                    Add a person&hellip;
                  </button>
                  {viewedId !== null && !demoShown && viewedName === null && (
                    // Someone a restore added without a name, or one this
                    // build could not hold (KV-18): named here as well as on
                    // the setup screen before the next reading.
                    <button
                      type="button"
                      onClick={() => setChanging({ what: 'rename', id: viewedId, name: UNNAMED })}
                      className={LINK}
                    >
                      Name this person&hellip;
                    </button>
                  )}
                  {viewedId !== null && !demoShown && viewedName !== null && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          setChanging({ what: 'rename', id: viewedId, name: viewedName })
                        }
                        className={LINK}
                      >
                        Rename {viewedName}&hellip;
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setChanging({ what: 'delete', id: viewedId, name: viewedName })
                        }
                        className={LINK}
                      >
                        Delete {viewedName}&hellip;
                      </button>
                    </>
                  )}
                </div>
              ) : changing.what === 'delete' ? (
                <ConfirmPersonRemoval
                  person={changing}
                  // The person shown: a deletion closes when another is.
                  checkIns={sessions?.length ?? 0}
                  onExport={exportHistory}
                  onCancel={() => setChanging(null)}
                  onFailure={(e) =>
                    showFailure(
                      e,
                      `${changing.name} could not be deleted. Nothing has been changed.`,
                    )
                  }
                  onDone={async (removed) => {
                    const { id, name } = changing
                    setChanging(null)
                    // A reading held for them can no longer be stored as theirs,
                    // and nobody it is for is on the list (review of #206).
                    if (readingFor === id) {
                      setReading(null)
                      setReadingFor(null)
                    }
                    // Whoever is first on the list now.
                    wanted.current = null
                    // The last one gone: the dashboard stays, empty and saying
                    // so, rather than the first-run screen in its place with no
                    // word of what just happened. A reading asks for a name, as
                    // any would with nobody here (review of #206).
                    if (readers.length === 1) setPastSetup(true)
                    try {
                      await refresh()
                    } catch (e) {
                      showFailure(e, `${name} was deleted, but the list could not be reloaded.`)
                      return
                    }
                    setNotice(
                      removed === 0
                        ? `Deleted ${name}.`
                        : `Deleted ${name} and ${
                            removed === 1 ? 'their one check-in' : `${String(removed)} check-ins`
                          }.`,
                    )
                  }}
                />
              ) : (
                <div className="rounded-lg border border-(--color-line) p-4">
                  {changing.what === 'add' ? (
                    <NameField
                      label="Their name"
                      save={(name) => window.kinvue.addPerson(name)}
                      onNamed={(person) => {
                        setChanging(null)
                        show(person.id)
                      }}
                    />
                  ) : (
                    <NameField
                      // Says whom, since the box outlives the link that named them.
                      label={`New name for ${changing.name}`}
                      save={(name) => window.kinvue.renamePerson(changing.id, name)}
                      onNamed={() => {
                        setChanging(null)
                        void refresh().catch((e: unknown) =>
                          showFailure(e, 'The name was saved, but the list could not be reloaded.'),
                        )
                      }}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => setChanging(null)}
                    className={`mt-3 ${LINK}`}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </section>
        </SectionBoundary>
      )}

      <SectionBoundary
        fallback="The key could not be shown here. Readings are unaffected."
        className="mt-10"
      >
        <KeySettings
          status={keyStatus}
          suspect={keySuspect}
          onKept={(next) => {
            setKeyStatus(next)
            setKeySuspect(false)
          }}
        />
      </SectionBoundary>
    </main>
  )
}
