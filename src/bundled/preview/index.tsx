import { useId, useState, type FormEvent } from "react";
import type {
  PanelProps,
  ChannelLauncherProps,
} from "../../features/panels/service";
import type { PluginModule } from "../../plugins/api";
import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  SidebarRightIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import pigeon from "./pigeon-ascii.txt?raw";
import styles from "./Preview.module.css";

const startTarget = "buzz:preview";
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
const bareLoopback = /^(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/?#]|$)/i;

function localUrl(target: string): URL | null {
  if (!/^https?:\/\/[^/]/i.test(target) || /[\s\\]/.test(target)) return null;
  try {
    const url = new URL(target);
    return loopback.has(url.hostname) && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

function PreviewLauncher({
  context,
  toggle,
  pressed,
  available,
}: ChannelLauncherProps) {
  const channel = CSS.escape(context.channelId);
  // Inactive conversation tabs can remain mounted under an inert ancestor.
  const panel = `[data-local-preview-panel="${channel}"]:not(:is([hidden], [inert], [aria-hidden="true"]) *)`;
  return (
    <>
      <style>{`:root:has(${panel}) [data-local-preview-launcher="${channel}"] { display: none; }`}</style>
      <IconButton
        size="toolbar"
        icon={<SidebarRightIcon size={16} />}
        aria-label="Preview"
        title="Preview"
        aria-expanded={pressed}
        data-channel-panel-toggle=""
        data-local-preview-launcher={context.channelId}
        onClick={(event) => {
          event.currentTarget.focus();
          if (available()) toggle(startTarget);
        }}
      />
    </>
  );
}

function PreviewStart({ context }: PanelProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const errorId = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = draft.trim();
    const url = localUrl(bareLoopback.test(value) ? `http://${value}` : value);
    if (!url) {
      setError(
        value
          ? "Enter an HTTP or HTTPS URL for localhost, 127.0.0.1, or [::1] without credentials."
          : "Enter a local URL.",
      );
      return;
    }
    if (!context?.push?.(url.href)) {
      setError("Couldn’t open the preview. Try again.");
      return;
    }
    setDraft("");
    setError("");
  }

  return (
    <section
      className={styles.panel}
      data-local-preview-panel={context?.channelId}
      aria-label="Preview start"
    >
      <form
        className={styles.toolbar}
        aria-label="Browser controls"
        onSubmit={submit}
        noValidate
      >
        <IconButton
          size="toolbar"
          variant="quiet"
          type="button"
          aria-label="Back"
          icon={<CaretLeftIcon size={16} />}
          disabled
        />
        <IconButton
          size="toolbar"
          variant="quiet"
          type="button"
          aria-label="Forward"
          icon={<CaretRightIcon size={16} />}
          disabled
        />
        <IconButton
          size="toolbar"
          variant="quiet"
          type="button"
          aria-label="Reload"
          icon={<ArrowsClockwiseIcon size={16} />}
          disabled
        />
        <div className={styles.address}>
          <Input
            type="url"
            aria-label="Local address"
            placeholder="http://localhost:3000"
            autoCapitalize="none"
            spellCheck={false}
            value={draft}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setError("");
            }}
          />
        </div>
        <IconButton
          size="toolbar"
          type="submit"
          aria-label="Open preview"
          title="Open preview"
          icon={<ArrowRightIcon size={16} />}
        />
      </form>
      {error ? (
        <p className={styles.error} id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.empty}>
        <pre className={styles.pigeon} aria-hidden="true">
          {pigeon}
        </pre>
      </div>
    </section>
  );
}

export const inject = ["panels", "browser"];
export const apply: PluginModule["apply"] = (ctx) => {
  const BrowserView = ctx.browser.available ? ctx.browser.View : null;

  ctx.panels.register({
    id: "start",
    title: "Preview",
    matches: (target) => target === startTarget,
    component: PreviewStart,
    channelPlacement: "tab",
    channelLauncher: PreviewLauncher,
    addressable: true,
  });

  ctx.panels.register({
    id: "local-prototype",
    title: "Local prototype",
    matches: (target) => localUrl(target) !== null,
    addressable: true,
    component: ({ target, context }) => {
      const url = localUrl(target);
      if (!url) return null;

      return (
        <section
          className={styles.panel}
          data-local-preview-panel={context?.channelId}
          aria-label="Local prototype"
        >
          {BrowserView ? (
            <BrowserView key={url.href} url={url.href} label={url.hostname} />
          ) : (
            <div className={styles.fallback}>
              <p>Embedded webpages are unavailable on this device.</p>
              <a href={url.href} target="_blank" rel="noopener noreferrer">
                Open prototype in browser
              </a>
            </div>
          )}
        </section>
      );
    },
  });
};
