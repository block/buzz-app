import {
  createElement,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { Browser } from "../host";
import { Button, Input } from "../kit";
import type { CanvasViewProps, CanvasViewType } from "../view";
import { styles } from "../styles";

export type PageState = { url: string };

/** An http(s) address, or "" for a view nobody has pointed anywhere yet. */
export const pageUrl = (input: unknown) => {
  if (input === "") return "";
  if (typeof input !== "string" || input.length > 2048) return;
  try {
    const url = new URL(input);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return;
  }
};
const parse = (input: unknown): PageState | undefined => {
  const url = pageUrl((input as { url?: unknown } | null)?.url);
  return url === undefined ? undefined : { url };
};

/** Where the viewer types the address everyone following is taken to. */
export function AddressBar({
  url,
  label,
  go,
}: {
  url: string;
  label: string;
  go(url: string): void;
}) {
  const [draft, setDraft] = useState(url);
  // A driver or an agent moved the view: show where it is now.
  const [shown, setShown] = useState(url);
  if (shown !== url) {
    setShown(url);
    setDraft(url);
  }
  const [invalid, setInvalid] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const typed = draft.trim();
    const next = pageUrl(
      /^[a-z]+:\/\//i.test(typed) ? typed : `https://${typed}`,
    );
    setInvalid(!next);
    if (next) go(next);
  };
  return (
    <form className={styles.address} onSubmit={submit}>
      <Input
        aria-label={label}
        invalid={invalid}
        placeholder="https://"
        value={draft}
        onValueChange={setDraft}
      />
      <Button type="submit">
        Go
      </Button>
    </form>
  );
}

/** How long after a page is opened for this viewer its address changes count
 * as the site redirecting, not as the viewer going somewhere. */
const SETTLE = 4000;

/** The host's own browser view, with its own back, forward and address bar.
 * It doesn't say where its page goes, so this reads the address it shows:
 * where the viewer goes inside the page is then shared like any other change.
 * That reaches into the host's markup and can break with it; the page still
 * shows if it does, but only the address it was opened at is shared. */
function HostPage({
  View,
  state,
  interactive,
  update,
}: CanvasViewProps<PageState> & { View: Browser["View"] }) {
  const frame = useRef<HTMLDivElement>(null);
  // A new address from someone else is a new guest: the host view keeps the
  // address it was opened at.
  const [guest, setGuest] = useState({ url: state.url, opened: 0 });
  // The address this viewer's page last showed.
  const seen = useRef(state.url);
  const quietUntil = useRef(Date.now() + SETTLE);
  const typing = useRef(false);
  const share = useRef({ interactive, update });
  share.current = { interactive, update };
  useEffect(() => {
    if (state.url === seen.current) return;
    seen.current = state.url;
    quietUntil.current = Date.now() + SETTLE;
    setGuest((was: { opened: number }) => ({
      url: state.url,
      opened: was.opened + 1,
    }));
  }, [state.url]);
  useEffect(() => {
    const timer = setInterval(() => {
      const address = frame.current?.querySelector<HTMLInputElement>(
        'input[aria-label="Address"]',
      );
      const url = address && !typing.current && pageUrl(address.value);
      if (!url || url === seen.current) return;
      seen.current = url;
      if (share.current.interactive && Date.now() >= quietUntil.current)
        share.current.update({ url });
    }, 500);
    return () => clearInterval(timer);
  }, []);
  return (
    <div
      ref={frame}
      className={styles.fill}
      onInput={() => {
        typing.current = true;
      }}
      onSubmit={() => {
        // An address the viewer entered is theirs, however soon it comes.
        typing.current = false;
        quietUntil.current = 0;
      }}
      onBlur={() => {
        typing.current = false;
      }}
    >
      <View key={guest.opened} url={guest.url} storage="canvas" />
    </div>
  );
}

function Page({
  state,
  interactive,
  update,
  browser,
  addressable,
}: CanvasViewProps<PageState> & {
  browser?: Browser | undefined;
  addressable: boolean;
}) {
  // Cordis wraps a service's functions on each access: keep one identity, or
  // React would see a new component, and a new page, on every render.
  const [Native] = useState(() =>
    browser?.available ? browser.View : undefined,
  );
  if (Native && state.url)
    return (
      <HostPage
        View={Native}
        state={state}
        interactive={interactive}
        update={update}
      />
    );
  return (
    <div className={styles.fill}>
      {addressable && interactive && (
        <AddressBar
          url={state.url}
          label="Shared address"
          go={(url) => update({ url })}
        />
      )}
      {!state.url ? (
        <p className={styles.hint}>
          {interactive
            ? "Enter an address to show a page here."
            : "No page is open here yet."}
        </p>
      ) : (
        <iframe
          className={styles.frame}
          title={state.url}
          src={state.url}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerPolicy="no-referrer"
        />
      )}
    </div>
  );
}

/** A page people can point somewhere else. Uses the host's own browser view
 * where the platform has one, and a frame elsewhere. */
export const browserView = (browser?: Browser): CanvasViewType<PageState> => ({
  type: "browser",
  title: "Browser",
  initial: { url: "" },
  parse,
  describe: (state) =>
    state.url ? `The web page ${state.url}` : "An empty browser.",
  component: (props) => <Page {...props} browser={browser} addressable />,
});

/** One embedded page with no controls, such as a dashboard or a prototype. */
export const webView: CanvasViewType<PageState> = {
  type: "web",
  title: "Web view",
  parse: (input) => {
    const state = parse(input);
    return state?.url ? state : undefined;
  },
  describe: (state) => `The embedded page ${state.url}`,
  component: (props) => <Page {...props} addressable={false} />,
};
