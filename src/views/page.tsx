import { createElement, useState, type FormEvent } from "react";
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
  const Native = browser?.available ? browser.View : undefined;
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
      ) : Native ? (
        // A new address is a new guest: the host view keeps its first one.
        <Native key={state.url} url={state.url} storage="canvas" />
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
