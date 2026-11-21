import type { RelaySession } from "../../features/relay/session";
import { parseNoteUrl, type NoteAddress } from "./model";
import { usePagesUi } from "./ui";
import readerStyles from "./NotesPage.module.css";

export function NoteMarkdown({
  text,
  community,
  onOpen,
  session,
  openLink,
}: {
  text: string;
  community: string;
  onOpen(address: NoteAddress): void;
  session?: RelaySession | undefined;
  openLink?: ((url: string) => boolean) | undefined;
}) {
  const SafeMarkdown = usePagesUi().conversation.Markdown;
  return (
    <div className={readerStyles.markdown}>
      <SafeMarkdown
        content={text}
        scale="document"
        session={session}
        openLink={(url) => {
          const note = parseNoteUrl(url);
          if (note?.community === community) {
            onOpen(note);
            return true;
          }
          return openLink?.(url) ?? false;
        }}
      />
    </div>
  );
}
