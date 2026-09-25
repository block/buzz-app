import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AgentControl } from "../../features/agents/control";
import type { RelaySession } from "../../features/relay/session";
import { InfoIcon } from "../../shared/design-system/icons/index";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { ProfileAgentDelete } from "./ProfileAgentDelete";

const noopSubscribe = () => () => {};
const noNativeBusy = () => false;

/** Base Buzz NIP-IA agent archive controls. Consent is a render guard only; the
 * session re-checks it before signing and the relay re-verifies on submit. */
export function ProfileAgentArchive({
  session,
  pubkey,
  control,
  scope,
  onDeleted,
}: {
  session: RelaySession;
  pubkey: string;
  control?: AgentControl | undefined;
  scope?: string | undefined;
  onDeleted(): void;
}) {
  const archives = session.archives;
  useSyncExternalStore(
    archives.subscribe,
    archives.snapshot,
    archives.snapshot,
  );
  const snapshot = archives.snapshot();
  const nativeBusy = useSyncExternalStore(
    control?.subscribe ?? noopSubscribe,
    control ? () => control.snapshot().busy : noNativeBusy,
    control ? () => control.snapshot().busy : noNativeBusy,
  );
  const [consent, setConsent] = useState<
    "pending" | "owner" | "allowed" | "denied" | "error"
  >("pending");
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<"archive" | "unarchive">();
  const [result, setResult] = useState<{ text: string; failed: boolean }>();
  const request = useRef<AbortController>(undefined);
  // Admission is synchronous: Delete must own the slot before its first channel
  // effect, and Archive must not enter while Delete is between relay steps.
  const operation = useRef<"archive" | "delete">(undefined);
  const [busy, setBusy] = useState(false);
  const beginDelete = () => {
    if (operation.current) return false;
    operation.current = "delete";
    setBusy(true);
    return true;
  };
  const endDelete = () => {
    operation.current = undefined;
    setBusy(false);
  };
  const retries = useRef(0);
  // Demand-aware recovery: a disconnect or cache reset returns the shared
  // snapshot to idle while this profile stays mounted.
  useEffect(() => {
    if (snapshot.status === "idle") void archives.ensure();
  }, [archives, snapshot.status]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the consent check.
  useEffect(() => {
    if (!archives.writable) return setConsent("denied");
    const controller = new AbortController();
    setConsent("pending");
    archives.consent(pubkey, controller.signal).then(
      (path) => {
        if (!controller.signal.aborted)
          // Only the verified NIP-OA owner path carries an auth tag.
          setConsent(path?.auth ? "owner" : path ? "allowed" : "denied");
      },
      () => {
        if (!controller.signal.aborted) setConsent("error");
      },
    );
    return () => controller.abort();
  }, [archives, pubkey, attempt]);
  // Base Buzz shows no check-failure copy: failed checks retry in the
  // background (three backoff retries, then again on window focus).
  const failed = consent === "error" || snapshot.status === "error";
  useEffect(() => {
    if (!failed) {
      // Only a settled success resets the budget, not a retry in flight.
      if (consent !== "pending" && snapshot.status !== "loading")
        retries.current = 0;
      return;
    }
    const retry = () => {
      if (consent === "error") setAttempt((value) => value + 1);
      if (snapshot.status === "error") void archives.refresh();
    };
    const focus = () => {
      retries.current = 0;
      retry();
    };
    window.addEventListener("focus", focus);
    const timer =
      retries.current < 3
        ? window.setTimeout(
            () => {
              retries.current += 1;
              retry();
            },
            1000 * 2 ** retries.current,
          )
        : undefined;
    return () => {
      window.removeEventListener("focus", focus);
      window.clearTimeout(timer);
    };
  }, [archives, consent, snapshot.status, failed]);
  useEffect(() => () => request.current?.abort(), []);
  const canArchive = consent === "owner" || consent === "allowed";
  const state = archives.state(pubkey);
  // While a request confirms, keep its source state rather than hiding the row.
  const isArchived = pending ? pending === "unarchive" : state === "archived";
  async function submit(
    action: "archive" | "unarchive",
    owner?: AbortSignal,
  ): Promise<boolean> {
    if (
      request.current ||
      owner?.aborted ||
      (!owner && control?.snapshot().busy)
    )
      return false;
    if (owner ? operation.current !== "delete" : !!operation.current)
      return false;
    if (!owner) {
      operation.current = "archive";
      setBusy(true);
    }
    const controller = new AbortController();
    owner?.addEventListener("abort", () => controller.abort(), { once: true });
    request.current = controller;
    setPending(action);
    setResult(undefined);
    try {
      await archives.request(action, pubkey, controller.signal);
      if (!controller.signal.aborted)
        setResult({
          text:
            action === "archive"
              ? "Archived on this relay"
              : "Unarchived on this relay",
          failed: false,
        });
      return !controller.signal.aborted;
    } catch (reason) {
      if (!controller.signal.aborted)
        setResult({
          text: `${action === "archive" ? "Archive" : "Unarchive"} failed: ${
            reason instanceof Error ? reason.message : String(reason)
          }`,
          failed: true,
        });
      return false;
    } finally {
      request.current = undefined;
      if (!owner) {
        operation.current = undefined;
        setBusy(false);
      }
      if (!controller.signal.aborted) setPending(undefined);
    }
  }
  return (
    <>
      {state === "archived" && (
        <div className="flex items-center gap-2">
          <span className="text-body-sm text-secondary">Visibility</span>
          <span className="text-body-sm">Archived</span>
          <IconButton
            size="sm"
            aria-label="What archived means"
            title="Archived agents do not appear in search, autocomplete, or member-add flows in this space. You can unarchive them at any time."
            icon={<InfoIcon size={16} aria-hidden="true" />}
          />
        </div>
      )}
      {canArchive && (pending || state !== "unknown") && (
        <div>
          <Button
            size="compact"
            loading={!!pending}
            disabled={(busy || nativeBusy) && !pending}
            onClick={() =>
              isArchived ? void submit("unarchive") : setConfirming(true)
            }
          >
            {pending
              ? isArchived
                ? "Unarchiving…"
                : "Archiving…"
              : isArchived
                ? "Unarchive agent"
                : "Archive agent"}
          </Button>
        </div>
      )}
      {consent === "owner" && control && scope && (
        <ProfileAgentDelete
          session={session}
          control={control}
          scope={scope}
          pubkey={pubkey}
          busy={busy}
          beginDelete={beginDelete}
          endDelete={endDelete}
          archive={async (signal) => {
            // The archive cache is not live; Delete needs a read started now.
            await archives.ensure();
            await archives.refresh();
            signal.throwIfAborted();
            return (
              archives.state(pubkey) === "archived" || submit("archive", signal)
            );
          }}
          onDeleted={onDeleted}
        />
      )}
      {result && (
        <p
          role={result.failed ? "alert" : "status"}
          className={
            result.failed ? "text-body-sm text-danger" : "text-body-sm"
          }
        >
          {result.text}
        </p>
      )}
      {confirming && (
        <AlertDialog
          title="Archive this agent?"
          description="Archiving hides this agent from the space."
          onClose={() => setConfirming(false)}
          actions={
            <>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button
                variant="prominent"
                onClick={() => {
                  setConfirming(false);
                  void submit("archive");
                }}
              >
                Archive
              </Button>
            </>
          }
        >
          <ul className="text-body-sm text-secondary">
            <li>
              They won't appear in search, autocomplete, or when adding members
            </li>
            <li>
              This only affects <strong>this space</strong> — not their account
              anywhere else
            </li>
            <li>You can unarchive them at any time to restore them</li>
          </ul>
          <p className="text-body-sm text-secondary">
            You can also delete this agent from the profile settings menu if you
            want to remove the agent instead of hiding it.
          </p>
        </AlertDialog>
      )}
    </>
  );
}
