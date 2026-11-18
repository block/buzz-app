/** Owner-only, bounded progress carried by the existing typing heartbeat. */
export type ActivitySnapshot = Readonly<{
  channelId: string;
  threadRootId: string | null;
  turnId: string;
  startedAt: number;
  seq: number;
  active: boolean;
  steps: readonly string[];
}>;

export function workSnapshot(
  send: (snapshot: ActivitySnapshot) => Promise<void>,
  channelId: string,
) {
  const turnId = crypto.randomUUID();
  const startedAt = Date.now();
  const steps: string[] = [];
  let seq = 0;
  let pending = false;
  let stopped = false;
  let lastRoot: string | null | undefined;
  let retirementSent = false;
  const pulse = (threadRootId: string | null) => {
    lastRoot = threadRootId;
    if (pending || (stopped && retirementSent)) return;
    pending = true;
    if (stopped) retirementSent = true;
    void send({
      channelId,
      threadRootId,
      turnId,
      startedAt,
      seq: ++seq,
      active: !stopped,
      steps: [...steps],
    })
      .catch(() => {
        // Live snapshots retry on the next existing heartbeat. A lost final
        // snapshot expires on the receiver with the typing lifetime.
      })
      .finally(() => {
        pending = false;
        if (stopped && !retirementSent && lastRoot !== undefined)
          pulse(lastRoot);
      });
  };
  return {
    step(tool: string) {
      // Only the compact tool label; arguments, paths and outputs stay local.
      const label = tool.trim().slice(0, 80);
      if (!label || stopped) return;
      steps.push(label);
      if (steps.length > 32) steps.shift();
    },
    pulse,
    stop() {
      stopped = true;
      if (lastRoot !== undefined) pulse(lastRoot);
    },
  };
}
