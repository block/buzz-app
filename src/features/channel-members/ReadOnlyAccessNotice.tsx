/** Explain personal access without implying that designated writers cannot post. */
export function ReadOnlyAccessNotice() {
  return (
    <div className="space-y-1">
      <p className="text-body-sm">You have read-only access to this channel.</p>
      <p className="text-caption text-subtle">
        You can read messages and threads. To contribute or add people, ask a
        channel owner or admin.
      </p>
    </div>
  );
}
