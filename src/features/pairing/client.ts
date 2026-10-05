import { invoke, isTauri } from "@tauri-apps/api/core";
export type PairingStatus =
  | {
      phase:
        | "uncertain"
        | "expired"
        | "idle"
        | "connecting"
        | "transferring"
        | "complete"
        | "cancelled";
    }
  | { phase: "qr"; svg: string }
  | { phase: "code"; code: string; codeEntry: boolean }
  | { phase: "error"; message: string };
export type PairingNative = {
  account(): Promise<string>;
  start(id: string, viewer: string, community: string): Promise<void>;
  status(id: string): Promise<PairingStatus>;
  confirm(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
};
export const nativePairing: PairingNative = {
  account: () => invoke("pairing_account"),
  start: (id, viewer, community) =>
    invoke("pairing_start", { id, viewer, community }),
  status: (id) => invoke("pairing_status", { id }),
  confirm: (id) => invoke("pairing_confirm", { id }),
  cancel: (id) => invoke("pairing_cancel", { id }),
};
export const pairingAvailable = isTauri;

export function createPairingClient(native: PairingNative = nativePairing) {
  let state: PairingStatus = { phase: "idle" };
  const listeners = new Set<() => void>();
  let generation = 0;
  let active:
    | {
        id: string;
        started: Promise<void>;
        confirming?: boolean;
        timer?: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let cleanup = Promise.resolve();
  function update(next: PairingStatus) {
    state = next;
    for (const listener of listeners) listener();
  }
  function stop() {
    const previous = active;
    active = undefined;
    if (previous) {
      clearTimeout(previous.timer);
      // A late start must finish registering before cancellation. Cleanup failures
      // remain visible and block a replacement instead of abandoning a live session.
      cleanup = previous.started
        .catch(() => {})
        .then(() => native.cancel(previous.id));
    }
    return cleanup;
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start(viewer: string, community: string) {
      const attempt = ++generation;
      update({ phase: "connecting" });
      try {
        await stop();
        if (attempt !== generation) return;
        const id = crypto.randomUUID();
        const session: NonNullable<typeof active> = {
          id,
          started: native.start(id, viewer, community),
        };
        active = session;
        await session.started;
        const poll = async () => {
          try {
            const status = await native.status(id);
            if (active !== session || attempt !== generation) return;
            if (!(session.confirming && status.phase === "code"))
              update(status);
            if (
              ["connecting", "qr", "code", "transferring"].includes(
                status.phase,
              )
            )
              active.timer = setTimeout(() => void poll(), 400);
          } catch {
            if (active !== session) return;
            const cancelledGeneration = generation + 1;
            await this.cancel();
            if (generation !== cancelledGeneration || state.phase === "error")
              return;
            update({
              phase: "error",
              message: "Couldn’t check pairing. Try again.",
            });
          }
        };
        if (active === session && attempt === generation) await poll();
      } catch (error) {
        if (attempt === generation)
          update({ phase: "error", message: String(error) });
      }
    },
    async confirm() {
      const session = active;
      if (!session || state.phase !== "code" || state.codeEntry) return;
      if (session.confirming) return;
      session.confirming = true;
      update({ phase: "transferring" });
      try {
        await native.confirm(session.id);
      } catch (error) {
        if (active === session)
          update({ phase: "error", message: String(error) });
      }
    },
    async cancel() {
      const attempt = ++generation;
      update({ phase: "cancelled" });
      try {
        await stop();
      } catch {
        if (attempt === generation)
          update({
            phase: "error",
            message:
              "Couldn’t cancel pairing. Close this window before trying again.",
          });
      }
    },
  };
}
