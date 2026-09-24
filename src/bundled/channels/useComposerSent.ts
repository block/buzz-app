import { useCallback, type Dispatch, type SetStateAction } from "react";

/** Keep the mounted composer's callback stable while unrelated workspace data moves. */
export function useComposerSent(
  channelId: string | undefined,
  selectAfterSend: boolean,
  setSent: Dispatch<
    SetStateAction<{ channelId: string; id: string } | undefined>
  >,
  select: (channelId: string) => void,
) {
  return useCallback(
    (id: string) => {
      if (!channelId) return;
      setSent({ channelId, id });
      if (selectAfterSend) select(channelId);
    },
    [channelId, selectAfterSend, setSent, select],
  );
}
