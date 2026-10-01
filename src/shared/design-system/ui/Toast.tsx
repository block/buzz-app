import { Toast as BaseToast } from "@base-ui/react/toast";
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { XIcon } from "../icons";
import { behindActiveModal } from "../modalLayer";
import { IconButton } from "./IconButton";

type NoticeData = {
  actions?: ReactNode;
  dismissible: boolean;
  closeLabel: string;
};

/** One host-owned stack. Base UI owns announcements, focus and expiry. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <BaseToast.Provider limit={Infinity}>
      {children}
      <ToastViewport />
    </BaseToast.Provider>
  );
}

function ToastViewport() {
  const { toasts } = BaseToast.useToastManager<NoticeData>();
  const viewport = useRef<HTMLDivElement>(null);
  const hasToasts = toasts.length > 0;
  useEffect(() => {
    if (!hasToasts) return;
    // Base UI keeps live regions available during modals, but its global F6
    // shortcut must not focus recovery controls behind the modal backdrop.
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "F6" &&
        viewport.current &&
        behindActiveModal(viewport.current)
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [hasToasts]);
  return (
    <BaseToast.Portal>
      <BaseToast.Viewport
        ref={viewport}
        data-buzz-ui=""
        className="buzz-toast-viewport"
        aria-label="App notifications"
      >
        {toasts.map((toast) => (
          <BaseToast.Root
            key={toast.id}
            toast={toast}
            inert={toast.transitionStatus === "ending"}
            aria-hidden={toast.transitionStatus === "ending" || undefined}
            data-buzz-ui=""
            className="buzz-toast floating-surface"
            swipeDirection={toast.data?.dismissible ? ["right"] : []}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !toast.data?.dismissible)
                event.preventBaseUIHandler();
            }}
          >
            <div className="buzz-toast-heading">
              <BaseToast.Title className="text-label-sm">
                {toast.title}
              </BaseToast.Title>
              {toast.data?.dismissible && (
                <BaseToast.Close
                  // This stack is always visually expanded, including before hover/focus.
                  aria-hidden={false}
                  render={
                    <IconButton
                      size="sm"
                      aria-label={toast.data.closeLabel}
                      icon={<XIcon size={16} aria-hidden="true" />}
                    />
                  }
                />
              )}
            </div>
            {toast.description && (
              <BaseToast.Description className="text-body-sm">
                {toast.description}
              </BaseToast.Description>
            )}
            {toast.data?.actions && (
              <div className="buzz-toast-actions">{toast.data.actions}</div>
            )}
          </BaseToast.Root>
        ))}
      </BaseToast.Viewport>
    </BaseToast.Portal>
  );
}

/** A notice lives with its source; removing it clears its floating presentation. */
export function ToastNotice({
  title,
  description,
  children,
  onDismiss,
  closeLabel = "Dismiss notification",
  timeout = 0,
  tone = "error",
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  onDismiss?: () => void;
  closeLabel?: string;
  /** Zero keeps recovery visible until its source resolves or explicitly dismisses. */
  timeout?: number;
  tone?: "error" | "warning" | "info" | "success";
}) {
  const id = useId();
  const { add, update, close } = BaseToast.useToastManager<NoticeData>();
  const dismissed = useEffectEvent(() => onDismiss?.());
  const options = useEffectEvent(() => ({
    title,
    description,
    type: tone,
    timeout,
    data: {
      actions: children,
      dismissible: timeout > 0 || !!onDismiss,
      closeLabel,
    },
  }));
  useEffect(() => {
    let active = true;
    add({
      id,
      ...options(),
      onClose: () => {
        if (active) dismissed();
      },
    });
    return () => {
      active = false;
      close(id);
    };
  }, [id, add, close]);
  useEffect(() => {
    update(id, {
      title,
      description,
      type: tone,
      data: {
        actions: children,
        dismissible: timeout > 0 || !!onDismiss,
        closeLabel,
      },
    });
  }, [
    id,
    update,
    title,
    description,
    tone,
    children,
    timeout,
    onDismiss,
    closeLabel,
  ]);
  useEffect(() => {
    update(id, { timeout });
  }, [id, update, timeout]);
  return null;
}

/** Completed actions belong to the host stack, not the originating row's lifetime. */
export function useToastNotification() {
  const { add } = BaseToast.useToastManager<NoticeData>();
  return (title: string, tone: "success" | "error" | "info") =>
    add({
      title,
      type: tone,
      timeout: 4000,
      data: { dismissible: true, closeLabel: "Dismiss notification" },
    });
}
