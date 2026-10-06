import { useEffect, useRef, useState } from "react";
import type { ChannelLifecycleCapability } from "../../features/relay/channel-lifecycle";
import { ChannelLifecycleUnconfirmed } from "../../features/relay/channel-lifecycle";
import { Button } from "../../shared/design-system/ui/Button";

/** A public preview offers Join; the membership roster, not this notice, enables the composer.
 * Confirmed membership can unmount this notice before its run settles, so the
 * page records the join intent when the run starts, not when it resolves. */
export function ChannelJoinNotice({
  channelId,
  lifecycle,
  joinable,
  onJoin,
}: {
  channelId: string;
  lifecycle?: ChannelLifecycleCapability | undefined;
  joinable: boolean;
  onJoin(): void;
}) {
  const [state, setState] = useState<{ channelId: string; error?: string }>();
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const pending = state?.channelId === channelId && state.error === undefined;
  const error = state?.channelId === channelId ? state.error : undefined;
  const join = () => {
    if (!lifecycle || pending) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState({ channelId });
    onJoin();
    lifecycle.run("join", channelId, current.signal).then(
      () => {
        if (!current.signal.aborted) setState(undefined);
      },
      (reason: unknown) => {
        if (current.signal.aborted) return;
        setState({
          channelId,
          error:
            reason instanceof ChannelLifecycleUnconfirmed
              ? "Join may have taken effect, but it is not confirmed yet. Try again to check."
              : reason instanceof Error
                ? reason.message
                : "Couldn’t join this channel.",
        });
      },
    );
  };
  const canJoin = joinable && !!lifecycle?.available;
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-body-sm text-subtle">
      <p>Read-only preview · You haven’t joined this conversation.</p>
      {canJoin && (
        <Button size="sm" loading={pending} onClick={join}>
          Join channel
        </Button>
      )}
      {canJoin && error && <p role="alert">{error}</p>}
    </div>
  );
}
