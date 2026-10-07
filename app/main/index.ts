import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  safeStorage,
  session,
  type IpcMainInvokeEvent,
} from "electron";
import { scoreSession } from "@core/scoring";
import { createJsonSessionStore, type SessionStore } from "@core/session/store";
import { createCheckIn } from "@core/session/checkin";
import type { SessionRecord } from "@core/session/types";
import { parseCheckInAnswers, parsePersonId } from "@core/session/validate";
import { parseRemoval, type RestoreResult, type RestoreStep } from "@core/session/lifecycle";
import {
  isProtected,
  MIN_PASSPHRASE_LENGTH,
  protect,
  unprotect,
  type ProtectedExport,
} from "@core/session/protect";
import { DEMO_PERSON_ID, seedDemoHistory } from "@core/seed/persona";
import { createGuidanceGate } from "@core/capture/guidance";
import { deviceTimeZone } from "./device";
import { createFrameThrottle, toPreview } from "./frames";
import { createInFlightCapture } from "./in-flight";
import {
  captureLengthLogLine,
  captureSeconds,
  resolveCaptureSeconds,
} from "./capture-length";
import { loadDotEnv } from "./env";
import { exportFileName, readExport } from "./history-file";
import { localStateHoldsKey, osCipher, type Protection } from "./cipher";
import { captureVitals } from "./vitals";
import { ERR_ABORTED, loadFailureMessage, showWhenReady } from "./window-show";
import { isAppUrl, isTrustedSender, resolveAppPage } from "./security";
import { toCaptureReply, type CaptureReply } from "../shared/capture-reply";

/**
 * The SmartSpectra key lives in `.env` during development and reaches the SDK
 * from the main process, never from the renderer. This runs before anything
 * *uses* the key — `captureVitals` reads it when a capture starts — rather than
 * before every other module is evaluated, which import order alone cannot give.
 *
 * Development only. A packaged app is started from wherever the shortcut points,
 * so honouring `.env` there would mean the process that owns the camera, the key
 * and the session file loads whatever happens to sit in that directory. Where a
 * packaged install gets its key is KV-19; until then it has no `.env` route at
 * all, which is what the README says.
 */
let envError: unknown = null;
if (!app.isPackaged) {
  try {
    loadDotEnv(resolve(process.cwd(), ".env"));
  } catch (err) {
    // Reported after the app is ready, below: throwing here would exit with no
    // window and no message anywhere but a terminal.
    envError = err;
  }
}

/**
 * Main process: owns the camera, the API key and the session file. The renderer
 * owns none of those and reaches all three over the narrow IPC surface below.
 * The API key in particular never crosses into the renderer.
 */

/**
 * The Electron security baseline (KV-29). Each item is in ARCHITECTURE.md with
 * what it covers and why the rest of Electron's checklist is done or does not
 * apply.
 *
 * Kinvue's own page, the one place the window may be and the only frame IPC
 * answers: the dev server in development, the built `index.html` otherwise.
 * `createWindow` loads `page.url` itself, so what is loaded and what is
 * checked are one string. A dev address that is not one is reported once the
 * app is ready, like a `.env` that cannot be read, rather than throwing here
 * with no window to say why (review of #169).
 */
const { page, problem: pageProblem } = resolveAppPage(
  process.env.ELECTRON_RENDERER_URL,
  pathToFileURL(join(__dirname, "../renderer/index.html")).href,
);

// Every renderer sandboxed, this window's and any other that ever exists: the
// preload needs only `contextBridge` and `ipcRenderer`, which a sandboxed
// preload keeps. Before `ready`, as Electron requires.
app.enableSandbox();

// Whatever web contents exist, created now or later: the window stays on
// Kinvue's own page, opens nothing new, and embeds nothing. A redirect is a
// navigation too, and so is a subframe's: `will-navigate` is the main frame's
// alone, and a subframe is the cheapest way to reach another page without
// disturbing it (review of #169). Nothing here navigates or opens windows on
// purpose, so a refusal is only ever something going wrong.
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (details) => {
    if (!isAppUrl(details.url, page)) details.preventDefault();
  });
  contents.on("will-frame-navigate", (details) => {
    if (!isAppUrl(details.url, page)) details.preventDefault();
  });
  contents.on("will-redirect", (details) => {
    if (!isAppUrl(details.url, page)) details.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

/**
 * `ipcMain.handle`, answered only for Kinvue's own page. Every handler goes
 * through this; `tests/security.test.ts` fails if one is registered directly.
 * The renderer holds no key and no history, and reaches the camera, the key's
 * use and the store only through these calls, so a frame that is not ours —
 * a subframe, or a window that navigated away — is refused before any of it.
 */
function handle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  // The one registration the IPC guard allows: this is the check (KV-29).
  // eslint-disable-next-line no-restricted-syntax
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    // The main frame by identity, as Electron advises, not inferred from
    // having no parent — which is true of any web contents' main frame.
    const frame = event.senderFrame;
    const sender =
      frame === null
        ? null
        : { url: frame.url, isMainFrame: frame === event.sender.mainFrame };
    if (!isTrustedSender(sender, page)) {
      throw new Error(`${channel} refused: the call did not come from Kinvue's own page.`);
    }
    return listener(event, ...args);
  });
}

// Under Electron's userData, so real check-ins live outside the repo. The
// repo's .gitignore also covers sessions/ for anyone who points this at ./.
const storePath = (): string =>
  join(app.getPath("userData"), "sessions", "sessions.json");

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    show: false,
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Shown on `ready-to-show`, or shortly after the page loads, or after a
  // bounded wait — never left hidden on one event that can be lost (KV-139).
  showWhenReady({
    isDestroyed: () => window.isDestroyed(),
    isVisible: () => window.isVisible(),
    show: () => window.show(),
    onReadyToShow: (listener) => window.once("ready-to-show", listener),
    onFinishLoad: (listener) =>
      window.webContents.once("did-finish-load", listener),
    // Main frame only, and not a navigation that was merely replaced: a
    // subframe or a superseded load is not the page failing.
    onFailLoad: (listener) =>
      window.webContents.on(
        "did-fail-load",
        (_event, errorCode, _description, _url, isMainFrame) => {
          if (isMainFrame && errorCode !== ERR_ABORTED) listener();
        },
      ),
  });

  // A page that cannot load says so, rather than leaving an empty window with
  // no message (KV-139 review) — the way a `.env` that cannot be read does.
  // The resolved page's own URL, not `loadFile`: the checks compare against
  // exactly this string, so the two cannot be built differently (review of #169).
  const loading = window.loadURL(page.url);
  loading.catch((err: unknown) => {
    const message = loadFailureMessage(err);
    if (message !== null && !window.isDestroyed()) {
      dialog.showErrorBox("Kinvue could not load", message);
    }
  });

  return window;
}

function registerIpc(store: SessionStore, protection: () => Protection): void {
  // Holds each capture until its answers arrive; the rules live in core so they
  // are tested. Everything the renderer sends is validated here first.
  const checkIn = createCheckIn({
    store,
    score: scoreSession,
    now: () => new Date(),
    newId: randomUUID,
    // Where the check-in device is, read fresh each capture: a laptop travels.
    // Undefined when the device cannot establish its zone — see device.ts.
    timeZone: deviceTimeZone,
  });

  handle(
    "sessions:list",
    async (_e, personId: unknown): Promise<SessionRecord[]> => {
      const id = parsePersonId(personId);
      if (id === null) throw new Error("sessions:list needs a person id.");
      return await store.list(id);
    },
  );

  // The capture currently running, so it can be abandoned. One at a time is
  // already enforced in core/session/checkin.ts, and the slot is claimed only
  // once that lock is taken — see `in-flight.ts` for why the order matters.
  const inFlight = createInFlightCapture();

  handle("checkin:cancel", (): void => {
    inFlight.abort();
  });

  // The renderer counts down and promises a length in its own words, and both
  // have to be the length main will actually run (#63). One number, asked for
  // rather than duplicated.
  handle("capture:seconds", (): number => captureSeconds(process.env));

  // Said once, at startup, rather than per capture: a setting that was not
  // honoured is a fact about this run, and the only other evidence of it is a
  // mismatch between `.env` and a countdown.
  const lengthNotice = captureLengthLogLine(resolveCaptureSeconds(process.env));
  if (lengthNotice !== null) console.warn(lengthNotice);

  handle(
    "checkin:capture",
    async (event, personId: unknown): Promise<CaptureReply> => {
      const id = parsePersonId(personId);
      if (id === null) throw new Error("checkin:capture needs a person id.");
      // One gate per capture, so nothing carries over from the last one.
      const guidance = createGuidanceGate();
      const sendFrame = createFrameThrottle();
      // Sent once, the first time a frame cannot be converted, so the screen can
      // say the picture is unavailable rather than sit on "starting the camera"
      // for the whole capture.
      let toldNoPreview = false;

      const controller = new AbortController();

      try {
        const capture = checkIn.capture(id, () => {
          // Claimed here, not before the call: `checkIn.capture` refuses a
          // second capture while one is running, and claiming first took the
          // slot from the capture doing the refusing — leaving the running one
          // with nothing able to abort it and the camera on for its full run
          // (KV-76). This callback only runs once the lock is held.
          inFlight.claim(controller);
          return captureVitals({
            durationSec: captureSeconds(process.env),
            signal: controller.signal,
            onProgress: (elapsedSec) => {
              // Progress is best-effort: a closed window must not fail the capture.
              if (!event.sender.isDestroyed()) {
                event.sender.send("checkin:progress", elapsedSec);
              }
            },
            // The mitigation for the likeliest capture failure: bad framing the
            // person cannot see. Best-effort for the same reason as progress.
            onSettling: () => {
              if (!event.sender.isDestroyed()) {
                event.sender.send("checkin:settling");
              }
            },
            onGuidance: (advice) => {
              // Checked before the gate is consulted, not after: offering advice
              // records it as shown, so asking a dead window afterwards would let
              // the gate believe a line reached a screen that had gone.
              if (event.sender.isDestroyed()) return;
              // performance.now() rather than Date.now(): a wall clock stepped by
              // NTP mid-capture would mute guidance or let the settling burst out.
              const update = guidance.offer(advice, performance.now());
              if (update === null) return;
              event.sender.send(
                "checkin:guidance",
                "show" in update ? update.show : null,
              );
            },
            // The self-view. Encoded here rather than in the renderer because
            // Electron's own nativeImage does it with no dependency, and because a
            // JPEG a tenth the size of raw pixels is what makes this affordable on
            // a bridge that also carries the check-in itself.
            onFrame: (frame) => {
              if (event.sender.isDestroyed()) return;
              if (!sendFrame(performance.now())) return;

              const preview = toPreview(frame);
              // A format this cannot convert costs the preview and nothing else —
              // but the screen is told, or it waits for a picture that never comes.
              if (preview === null) {
                if (!toldNoPreview) {
                  toldNoPreview = true;
                  event.sender.send("checkin:frame", null);
                }
                return;
              }

              const jpeg = nativeImage
                // A view of the bytes rather than a copy of them: this runs ten
                // times a second beside everything else the loop is doing.
                .createFromBitmap(
                  Buffer.from(
                    preview.data.buffer,
                    preview.data.byteOffset,
                    preview.data.byteLength,
                  ),
                  { width: preview.width, height: preview.height },
                )
                .toJPEG(55);
              // An encoder that produced nothing would render as a broken picture.
              if (jpeg.length === 0) return;
              event.sender.send("checkin:frame", jpeg);
            },
          });
        });
        // A stop resolves as a reply rather than rejecting: Electron logs every
        // handler rejection as a fault, and pressing Stop is not one (KV-89).
        // The preload turns it back into the rejection the screen reads.
        return await toCaptureReply(capture);
      } finally {
        // Only when it is still ours: a refused capture must not release the
        // slot belonging to the capture that refused it.
        inFlight.release(controller);
      }
    },
  );

  handle(
    "checkin:submit",
    async (
      _e,
      personId: unknown,
      captureId: unknown,
      answers: unknown,
    ): Promise<SessionRecord> => {
      const id = parsePersonId(personId);
      if (id === null) throw new Error("checkin:submit needs a person id.");
      if (typeof captureId !== "string")
        throw new Error("checkin:submit needs a capture id.");
      const parsed = parseCheckInAnswers(answers);
      if (parsed === null)
        throw new Error("checkin:submit received malformed answers.");
      return await checkIn.submit(id, captureId, parsed);
    },
  );

  // KV-98. Only ever on a press, and the store re-checks before it moves
  // anything: a history it can read is left where it is and null comes back.
  handle(
    "sessions:startNewHistory",
    async (): Promise<string | null> => await store.startNewHistory(),
  );

  // KV-21. What a person may do with their own history at their own device:
  // export it, restore it, delete from it. Each is one store write, or none,
  // and every argument is checked here — a path never comes from the renderer,
  // only from a dialog the person answered.
  const historyFilter = { name: "Kinvue check-in history", extensions: ["json"] };
  const personFor = (channel: string, personId: unknown): string => {
    const id = parsePersonId(personId);
    if (id === null) throw new Error(`${channel} needs a person id.`);
    return id;
  };
  // A passphrase is checked here as well as on screen: it is the whole defence
  // of a protected export (KV-175), so main does not take the renderer's word.
  const passphraseFor = (channel: string, passphrase: unknown): string => {
    if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new Error(
        `${channel} needs a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`,
      );
    }
    return passphrase;
  };
  // A protected export waiting for its passphrase (KV-175): held here, so the
  // renderer is never handed the file, and dropped once restored or cancelled.
  let waiting: { personId: string; file: ProtectedExport } | null = null;

  // KV-175. Where the history's protection stands, for the line that says so:
  // encrypted, waiting for the key to reach the disk, or no key store at all.
  handle("store:protection", (): Protection => protection());

  handle(
    "history:lastExported",
    async (_e, personId: unknown): Promise<string | null> =>
      await store.lastExported(personFor("history:lastExported", personId)),
  );

  handle(
    "history:export",
    async (
      event,
      personId: unknown,
      passphrase: unknown,
    ): Promise<{ count: number; protected: boolean } | null> => {
      const id = personFor("history:export", personId);
      // None given: a plain export, as the person chose. One given: protected.
      const secret =
        passphrase === undefined || passphrase === null
          ? null
          : passphraseFor("history:export", passphrase);
      const options = {
        title: "Export check-in history",
        // A suggestion, from when the dialog opened; the person can change it.
        defaultPath: exportFileName(new Date()),
        filters: [historyFilter],
      };
      const window = BrowserWindow.fromWebContents(event.sender);
      const chosen =
        window === null
          ? await dialog.showSaveDialog(options)
          : await dialog.showSaveDialog(window, options);
      if (chosen.canceled || chosen.filePath === undefined) return null;
      // The clock after the dialog, not before (review of #185): opened at 23:58
      // and saved at 00:03, the export is from the day it was saved, and so is
      // the line beside the control. Read then too, so it holds what is there now.
      const now = new Date();
      const file = await store.exportFor(id, now);
      const written = secret === null ? file : await protect(file, secret);
      await writeFile(chosen.filePath, JSON.stringify(written, null, 2), "utf8");
      // Only once the file is written: the line beside the control must not
      // claim an export that did not happen.
      await store.markExported(id, now);
      return { count: file.records.length, protected: secret !== null };
    },
  );

  handle(
    "history:restore",
    async (event, personId: unknown): Promise<RestoreStep | null> => {
      const id = personFor("history:restore", personId);
      const options = {
        title: "Restore check-in history",
        properties: ["openFile" as const],
        filters: [historyFilter],
      };
      const window = BrowserWindow.fromWebContents(event.sender);
      const chosen =
        window === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(window, options);
      const path = chosen.filePaths[0];
      if (chosen.canceled || path === undefined) return null;
      const file = await readExport(path);
      if (file.kind === "not-an-export") return { ok: false, refusal: { kind: "not-an-export" } };
      if (file.kind === "unopenable") {
        return { ok: false, refusal: { kind: "unopenable", code: file.code } };
      }
      if (isProtected(file.contents)) {
        waiting = { personId: id, file: file.contents };
        return { needsPassphrase: true };
      }
      waiting = null;
      const plan = await store.restore(id, file.contents);
      // The outcome, not the merged history: the screen reads the history the
      // way it always does.
      return plan.ok ? { ok: true, outcome: plan.outcome } : { ok: false, refusal: plan.refusal };
    },
  );

  handle(
    "history:restoreProtected",
    async (_e, personId: unknown, passphrase: unknown): Promise<RestoreResult> => {
      const id = personFor("history:restoreProtected", personId);
      if (typeof passphrase !== "string") {
        throw new Error("history:restoreProtected needs a passphrase.");
      }
      if (waiting === null || waiting.personId !== id) {
        throw new Error("history:restoreProtected has no protected file waiting.");
      }
      const opened = await unprotect(waiting.file, passphrase);
      if (!opened.ok) {
        // A wrong passphrase keeps the file waiting for another try.
        if (opened.why === "wrong-passphrase") {
          return { ok: false, refusal: { kind: "wrong-passphrase" } };
        }
        waiting = null;
        return { ok: false, refusal: { kind: "unreadable", why: opened.detail } };
      }
      waiting = null;
      const plan = await store.restore(id, opened.contents);
      return plan.ok ? { ok: true, outcome: plan.outcome } : { ok: false, refusal: plan.refusal };
    },
  );

  handle("history:cancelRestore", (): void => {
    waiting = null;
  });

  handle(
    "history:remove",
    async (_e, personId: unknown, which: unknown): Promise<number> => {
      const id = personFor("history:remove", personId);
      const removal = parseRemoval(which);
      if (removal === null) throw new Error("history:remove received a malformed request.");
      return await store.remove(id, removal, new Date());
    },
  );

  // KV-8. Opt-in, and every record it writes is marked `seeded: true`.
  handle("demo:seed", async (): Promise<number> => {
    const existing = await store.list(DEMO_PERSON_ID);
    if (existing.length > 0) return 0;
    const seeded = seedDemoHistory();
    for (const record of seeded) await store.append(record);
    return seeded.length;
  });
}

void app.whenReady().then(async () => {
  if (envError !== null) {
    // The app still runs — the dashboard reads stored history without a key —
    // but capture will fail, and this says why while the .env is still the
    // obvious suspect.
    dialog.showErrorBox(
      "Could not read .env",
      `${String(envError)}\n\nKinvue will start, but a capture cannot run until the ` +
        "SmartSpectra API key can be read.",
    );
  }

  if (pageProblem !== null) {
    dialog.showErrorBox("Kinvue could not use its dev server address", pageProblem);
  }

  // No permission is ever granted: the camera runs here, in main, through the
  // SDK, and the self-view reaches the page as pictures over IPC, so the page
  // needs no camera, microphone, location or anything else (KV-29). The
  // default session only: a partitioned session made later starts with no
  // handlers at all, and must be given these too.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);

  // KV-175. The history encrypted with the operating system's key, where it
  // holds one — asked here, after `ready`, when `safeStorage` can answer. A
  // plain history is sealed now, before any handler can write, so the sealing
  // write cannot race a check-in's; not on the next check-in, so an install
  // only read from does not stay plain. A failure is logged and the app goes
  // on: the dashboard's first read says what is wrong, in the store's words.
  //
  // Never with a key that is not on disk yet: on Windows the key lives in this
  // app's own `Local State`, which Chromium writes seconds after the key is made,
  // and a history sealed in that gap is lost to a crash. So the key is made now
  // — `safeStorage` makes it on first use — and the seal waits until it is
  // written down; until then writes stay plain. See `osCipher`.
  const keyOnDisk =
    process.platform === "win32"
      ? localStateHoldsKey(join(app.getPath("userData"), "Local State"))
      : (): boolean => true;
  const cipher = osCipher(safeStorage, process.platform, keyOnDisk);
  const store = createJsonSessionStore(storePath(), undefined, cipher);
  const seal = (): Promise<void> =>
    store.encryptAtRest().then(
      () => undefined,
      (err: unknown) => console.error("The history could not be encrypted.", err),
    );
  if (cipher.protection() === "waiting-for-key") {
    try {
      safeStorage.encryptString("kinvue");
    } catch (err) {
      console.error("The key store would not make a key.", err);
    }
    // Asked every two seconds, for two minutes: Chromium writes the file within
    // a quarter of that, and a key that never lands leaves the history plain,
    // which the dashboard says.
    let tries = 0;
    const waiting = setInterval(() => {
      tries += 1;
      if (cipher.protection() === "encrypted") {
        clearInterval(waiting);
        void seal();
      } else if (tries >= 60) {
        clearInterval(waiting);
      }
    }, 2000);
  }
  await seal();

  registerIpc(store, cipher.protection);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
