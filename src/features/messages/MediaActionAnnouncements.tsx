import {
  createContext,
  useMemo,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { notifyDownloadSaved } from "./DownloadNotice";

const ViewerFeedback = createContext<{
  announce(text: string): void;
  onDownloadSaved(): void;
} | null>(null);

export function MediaActionAnnouncements({
  children,
  onDownloadSaved,
}: {
  onDownloadSaved: () => void;
  children: ReactNode;
}) {
  const [notice, setNotice] = useState({ text: "", sequence: 0 });
  const feedback = useMemo(
    () => ({
      announce(text: string) {
        setNotice((previous) => ({ text, sequence: previous.sequence + 1 }));
      },
      onDownloadSaved,
    }),
    [onDownloadSaved],
  );
  return (
    <ViewerFeedback value={feedback}>
      {children}
      {/* The modal hides the toast host from assistive technology. Keep the
          live region mounted and explicit so nested menus leave it exposed. */}
      <span
        className="sr-only"
        role="status"
        aria-label="Media actions"
        aria-live="polite"
      >
        {notice.text && <span key={notice.sequence}>{notice.text}</span>}
      </span>
    </ViewerFeedback>
  );
}

export function useMediaActionNotifications() {
  const notify = useToastNotification();
  const viewer = useContext(ViewerFeedback);
  const notifyAction: typeof notify = (title, tone, action) => {
    viewer?.announce(title);
    return notify(title, tone, action);
  };
  return {
    notify: notifyAction,
    downloadSaved: () =>
      notifyDownloadSaved(notifyAction, viewer?.onDownloadSaved),
  };
}
