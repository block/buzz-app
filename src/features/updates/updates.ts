import { invoke, isTauri } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date" }
  | { state: "unavailable" }
  | { state: "available"; version: string }
  | { state: "downloading" }
  | { state: "installing" }
  | { state: "ready" }
  /** Ready, and installs once local agents have been idle for `IDLE_QUIET_MS`. */
  | { state: "scheduled" }
  | { state: "error"; message: string };

/** The subset of the Tauri updater handle this owner uses. */
export type UpdateHandle = {
  version: string;
  download(onEvent: undefined, options: { timeout: number }): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
};

export type UpdatePlatform = {
  desktop: boolean;
  check(): Promise<UpdateHandle | null>;
  relaunch(): Promise<void>;
};

/** Whether local agents are working, which a restart would interrupt. */
export type AgentWork = Readonly<{
  isWorking(): boolean;
  workingCount(): number;
  /** Called whenever `workingCount` changes. */
  subscribeWorking(listener: () => void): () => void;
}>;

export const BACKGROUND_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
// Native request deadlines, so a stalled server cannot pin a check or download.
// The updater does not carry the check timeout over to the download.
export const UPDATE_CHECK_TIMEOUT_MS = 30 * 1000;
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
// Bridges the gap between a turn ending and the follow-up or reply it leads to.
export const IDLE_QUIET_MS = 60 * 1000;
const BACKGROUND_BLOCKED_STATES = new Set<UpdateStatus["state"]>([
  "checking",
  "available",
  "downloading",
  "installing",
  "ready",
  "scheduled",
]);

const tauriPlatform: UpdatePlatform = {
  desktop: isTauri(),
  check: () =>
    check({
      headers: { "Cache-Control": "no-cache" },
      timeout: UPDATE_CHECK_TIMEOUT_MS,
    }),
  // Restarts only after agent shutdown is confirmed, like Quit.
  relaunch: () => invoke("update_restart"),
};

const toErrorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// Builds without updater configuration do not register the native plugin.
const isUpdaterUnavailable = (message: string) =>
  message.includes("plugin updater not found") ||
  message.includes("not initialized");

/** App-wide update lifecycle: background checks, download, install and relaunch.
 * Without `agentWork`, installing once agents are idle is not offered. */
export function createUpdates(
  platform: UpdatePlatform = tauriPlatform,
  agentWork?: AgentWork,
) {
  let status: UpdateStatus = { state: "idle" };
  let update: UpdateHandle | null = null;
  let checkInFlight = false;
  let downloadInFlight = false;
  let installInFlight = false;
  let manualResultRequested = false;
  let inlineViews = 0;
  let noticeDismissed = false;
  let noticeRecovery = false;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const setStatus = (next: UpdateStatus) => {
    status = next;
    if (next.state !== "scheduled") clearTimeout(quietTimer);
    if (next.state === "ready") noticeRecovery = false;
    if (
      next.state !== "ready" &&
      next.state !== "installing" &&
      next.state !== "scheduled"
    )
      noticeDismissed = false;
    notify();
  };

  /** Starts the quiet period over, or holds it while agents work. */
  const waitForQuiet = () => {
    clearTimeout(quietTimer);
    if (!agentWork || agentWork.isWorking()) return;
    quietTimer = setTimeout(() => {
      if (status.state !== "scheduled") return;
      // Work reports clear this timer, so this guards only a report that
      // never arrived; the next idle report starts the quiet period again.
      if (agentWork.isWorking()) {
        console.info("Update deferred: agents are working");
        return;
      }
      console.info("Installing the scheduled update: agents are idle");
      void installAndRelaunch();
    }, IDLE_QUIET_MS);
  };
  const stopWork = agentWork?.subscribeWorking(() => {
    if (status.state === "scheduled") waitForQuiet();
    notify();
  });

  const closeUpdate = async () => {
    if (downloadInFlight || installInFlight || !update) return;
    const current = update;
    update = null;
    await current.close();
  };

  const download = async () => {
    const current = update;
    if (downloadInFlight || !current) return;
    downloadInFlight = true;
    try {
      setStatus({ state: "downloading" });
      await current.download(undefined, {
        timeout: UPDATE_DOWNLOAD_TIMEOUT_MS,
      });
      setStatus({ state: "ready" });
    } catch (err) {
      setStatus({ state: "error", message: toErrorMessage(err) });
    } finally {
      downloadInFlight = false;
    }
  };

  const installAndRelaunch = async () => {
    const current = update;
    if (installInFlight || !current) return;
    installInFlight = true;
    try {
      setStatus({ state: "installing" });
      await current.install();
      update = null;
      await platform.relaunch();
    } catch (err) {
      noticeRecovery = true;
      setStatus({ state: "error", message: toErrorMessage(err) });
    } finally {
      installInFlight = false;
    }
  };

  const runCheck = async (background: boolean) => {
    if (!platform.desktop) {
      if (!background) setStatus({ state: "unavailable" });
      return;
    }
    if (checkInFlight) {
      if (!background) {
        manualResultRequested = true;
        setStatus({ state: "checking" });
      }
      return;
    }
    if (background && BACKGROUND_BLOCKED_STATES.has(status.state)) return;

    checkInFlight = true;
    manualResultRequested = false;
    try {
      await closeUpdate();
      if (!background) setStatus({ state: "checking" });
      const found = await platform.check();
      if (found) {
        update = found;
        setStatus({ state: "available", version: found.version });
        void download();
      } else if (!background || manualResultRequested) {
        setStatus({ state: "up-to-date" });
      }
    } catch (err) {
      const message = toErrorMessage(err);
      if (!background || manualResultRequested)
        setStatus(
          isUpdaterUnavailable(message)
            ? { state: "unavailable" }
            : { state: "error", message },
        );
    } finally {
      manualResultRequested = false;
      checkInFlight = false;
    }
  };

  void runCheck(true);
  const interval = setInterval(
    () => void runCheck(true),
    BACKGROUND_UPDATE_CHECK_INTERVAL_MS,
  );

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => status,
    /** Settings shows the same action inline; the toast yields while it is on screen. */
    showInline() {
      inlineViews++;
      notify();
      return () => {
        inlineViews--;
        notify();
      };
    },
    inlineVisible: () => inlineViews > 0,
    /** The ready notice stays dismissed across remounts until the update resolves. */
    dismissNotice() {
      noticeDismissed = true;
      noticeRecovery = false;
      notify();
    },
    noticeDismissed: () => noticeDismissed,
    /** Keep failed installs and their retry results reachable outside Settings. */
    noticeRecovery: () => noticeRecovery,
    checkForUpdate: () => runCheck(false),
    installAndRelaunch,
    /** Whether `installWhenIdle` is offered: this app runs agents. */
    idleOptionAvailable: () => agentWork !== undefined,
    /** Local agents working now, which installing would interrupt. */
    workingCount: () => agentWork?.workingCount() ?? 0,
    /** Installs a ready update once agents have been idle for `IDLE_QUIET_MS`. */
    installWhenIdle() {
      if (!agentWork || status.state !== "ready") return;
      console.info(
        `Update scheduled for when agents are idle; ${agentWork.workingCount()} working`,
      );
      setStatus({ state: "scheduled" });
      waitForQuiet();
    },
    cancelScheduled() {
      if (status.state !== "scheduled") return;
      console.info(
        `Scheduled update cancelled; ${agentWork?.workingCount() ?? 0} working`,
      );
      setStatus({ state: "ready" });
    },
    dispose() {
      clearInterval(interval);
      clearTimeout(quietTimer);
      stopWork?.();
      void closeUpdate();
    },
  };
}

export type Updates = ReturnType<typeof createUpdates>;
