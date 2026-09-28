import { useEffect, useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import type { UserStatus } from "../relay/user-status";

export function useStatusEditor(
  session: RelaySession | undefined,
  viewer: string | undefined,
) {
  const [editor, setEditor] = useState<{
    session: RelaySession;
    current: UserStatus | undefined;
  }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing account or community invalidates pending editor work and drafts.
  useEffect(() => {
    setEditor(undefined);
    setLoading(false);
    setError("");
    return () => {
      generation.current++;
    };
  }, [session, viewer]);
  async function open() {
    if (!session || !viewer || loading) return;
    const request = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const current = await session.statuses.current(viewer);
      if (request === generation.current) {
        setEditor({ session, current });
        return true;
      }
    } catch {
      if (request === generation.current)
        setError("Couldn’t load your current status. Please try again.");
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }
  return {
    editor: editor?.session === session ? editor : undefined,
    loading,
    error,
    open,
    cancelOpening() {
      generation.current++;
      setLoading(false);
      setError("");
    },
    close: () => setEditor(undefined),
  };
}
