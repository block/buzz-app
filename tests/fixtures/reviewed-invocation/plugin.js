// Installed and loaded by the real Manager/PluginRuntime, never a fabricated Caller.
export const inject = ["host", "conversation"];
let pending;
export function result() {
  return pending;
}
export function apply(ctx) {
  // Stable across page reload and re-enable in this disposable app process.
  const callId = "abcdefab-1234-4234-8234-123456789abc";
  ctx.conversation.registerMessage({
    id: "synthetic",
    title: "Synthetic operation",
    matches: (message) => message.id === "synthetic-message",
    reviewedInvocation: () => callId, // Locator only; no approval callback.
    component: () =>
      "Installed synthetic plugin draft. Buzz owns the exact review and action below.",
  });
  pending = ctx.host.reviewAndInvokeOnce(
    {
      operation: "synthetic",
      body: "Synthetic request A. No provider call, network, media, or credential enrollment.",
      destination: {
        community: "fixture-community",
        viewer: "fixture-viewer",
        channel: "fixture-channel",
      },
    },
    { callId },
  );
  void pending.catch(() => {}); // No retry or activation wait on approval.
}
