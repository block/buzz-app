import { useLayoutEffect, useSyncExternalStore } from "react";
import {
  IconHeadphones,
  IconMicrophone,
  IconMicrophoneOff,
  IconPhoneOff,
} from "@tabler/icons-react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import type { BestieCall } from "./call";

export function Bestie({
  call,
  available,
}: {
  call: BestieCall;
  available: boolean;
}) {
  const state = useSyncExternalStore(
    call.subscribe,
    call.snapshot,
    call.snapshot,
  );
  useLayoutEffect(() => call.attach(), [call]);
  const permission = state.permission;
  const connected = state.phase === "listening" || state.phase === "speaking";
  const busy =
    connected || state.phase === "connecting" || state.phase === "stopping";
  return (
    <section
      className="flex min-h-full flex-col gap-4 p-4"
      aria-label="Bestie conversation"
    >
      <div className="flex items-center gap-3">
        <img src="/bestie.png" alt="" className="size-12 object-contain" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Your Bestie</h2>
          <p className="truncate text-xs text-muted">
            {state.community
              ? new URL(state.community).host
              : "Choose a community"}
          </p>
        </div>
        <IconButton
          icon={
            busy ? <IconPhoneOff size={20} /> : <IconHeadphones size={20} />
          }
          variant={busy ? "tint" : "solid"}
          shape="round"
          aria-label={
            busy ? "End Bestie conversation" : "Start Bestie voice conversation"
          }
          disabled={
            !available || !state.community || state.phase === "stopping"
          }
          onClick={() => {
            if (busy) void call.end();
            else void call.start();
          }}
        />
      </div>
      {!available ? (
        <p className="text-sm text-muted">
          Voice is available in the live development app when
          BUZZ_REALTIME_ENDPOINT is configured.
        </p>
      ) : (
        <>
          <p role="status" className="text-sm text-muted">
            {state.message}
          </p>
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs text-muted">
              Thinking
              <select
                aria-label="Bestie thinking level"
                value={state.thinking}
                disabled={busy}
                onChange={(e) => call.setThinking(e.target.value)}
                className="rounded border border-subtle bg-surface px-2 py-1 text-fg"
              >
                <option value="none">Off</option>
                <option value="minimal">Minimal</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            {connected && (
              <IconButton
                icon={
                  state.muted ? (
                    <IconMicrophoneOff size={18} />
                  ) : (
                    <IconMicrophone size={18} />
                  )
                }
                aria-label={
                  state.muted
                    ? "Unmute Bestie microphone"
                    : "Mute Bestie microphone"
                }
                aria-pressed={state.muted}
                onClick={call.mute}
              />
            )}
          </div>
          <label className="flex items-center justify-between gap-2 text-xs text-muted">
            Tool approval
            <select
              aria-label="Bestie tool approval mode"
              value={state.approval}
              disabled={busy}
              onChange={(e) => call.setApproval(e.target.value)}
              className="rounded border border-subtle bg-surface px-2 py-1 text-fg"
            >
              <option value="auto">Automatically approve</option>
              <option value="ask">Ask each time</option>
            </select>
          </label>
          <p className="text-xs text-muted">
            Bestie uses its own identity in this community. Closing this panel
            ends the call.
          </p>
        </>
      )}
      <div
        className="flex flex-col gap-3"
        role="log"
        aria-label="Bestie transcript"
        aria-live="polite"
      >
        {state.messages.map((message) => (
          <div key={message.id} className="rounded-lg border border-subtle p-3">
            <p className="mb-1 text-xs font-medium text-muted">
              {message.role === "user" ? "You" : "Bestie"}
            </p>
            <p className="whitespace-pre-wrap break-words text-sm">
              {message.text}
            </p>
          </div>
        ))}
      </div>
      {permission && (
        <section
          className="rounded-lg border border-subtle p-3"
          aria-label="Bestie tool approval"
        >
          <h3 className="text-sm font-semibold">
            {permission.title || "Approve tool call?"}
          </h3>
          <pre className="my-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs">
            {JSON.stringify(permission.rawInput ?? permission, null, 2)}
          </pre>
          <div className="flex gap-2">
            <Button
              onClick={() => {
                void call.decide(false, permission.request);
              }}
            >
              Deny
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                void call.decide(true, permission.request);
              }}
            >
              Allow once
            </Button>
          </div>
        </section>
      )}
    </section>
  );
}
