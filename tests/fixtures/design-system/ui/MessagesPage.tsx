import { useEffect, useRef, useState } from "react";
import { useColorScheme } from "../../../../src/shared/design-system/theme/useColorScheme";

export function MessagesPage() {
  const { scheme } = useColorScheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(900);
  const source = `./message-gallery.html?theme=${scheme}`;
  useEffect(() => {
    const resize = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== frame.current?.contentWindow
      )
        return;
      if (
        event.data?.type === "message-gallery-height" &&
        Number.isFinite(event.data.height) &&
        event.data.height > 0
      ) {
        setHeight(Math.ceil(event.data.height));
      }
    };
    window.addEventListener("message", resize);
    return () => window.removeEventListener("message", resize);
  }, []);
  return (
    <>
      <header className="component-page-heading">
        <h1 className="text-title text-primary">Messages</h1>
        <p className="text-body text-tertiary">
          Current message layouts and states, rendered by the app’s components
          with sample data.
        </p>
      </header>
      <iframe
        ref={frame}
        title="Message types and states"
        src={source}
        style={{ width: "100%", height, border: 0, display: "block" }}
      />
    </>
  );
}
