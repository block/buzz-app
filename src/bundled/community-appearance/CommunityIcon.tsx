import { useEffect, useRef, useState } from "react";
import { COMMUNITY_ICON_MAX_DATA_URL } from "../../features/communities/admin-protocol";
import { fetchCommunityPresentation } from "../../features/communities/community-icon";
import { communityFromScope } from "../../features/relay/gifs";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Header } from "../../shared/design-system/ui/Header";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { setCommunityIcon } from "./api";

const read = async (community: string, signal: AbortSignal) =>
  (await fetchCommunityPresentation(community, signal)).publishedIcon;

/** Center-crop to a square and encode small enough to sign as one relay command. */
async function iconDataUrl(file: Blob) {
  const image = await createImageBitmap(file);
  const side = Math.min(image.width, image.height);
  const canvas = document.createElement("canvas");
  // Alpha-capable formats come first at every size; WebKit can't encode WebP
  // and falls back to PNG. JPEG keeps photos small but has no alpha.
  for (const type of ["image/webp", "image/png", "image/jpeg"])
    for (const size of [256, 128]) {
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) break;
      if (type === "image/jpeg") {
        context.fillStyle = "#fff";
        context.fillRect(0, 0, size, size);
      }
      context.drawImage(
        image,
        (image.width - side) / 2,
        (image.height - side) / 2,
        side,
        side,
        0,
        0,
        size,
        size,
      );
      const url = canvas.toDataURL(type, 0.85);
      if (
        url.startsWith(`data:${type};`) &&
        url.length <= COMMUNITY_ICON_MAX_DATA_URL
      )
        return url;
    }
  throw new Error("This image is too detailed to use as the community icon");
}

export function CommunityIcon({
  relay,
  communityName,
  active,
}: {
  relay: RelayData;
  communityName?: string | undefined;
  active(): boolean;
}) {
  const connection = useRelayConnection(relay);
  const community =
    connection.status === "ready" && connection.scope
      ? communityFromScope(connection.scope)
      : null;
  const name = communityName ?? "this community";
  return (
    <section aria-labelledby="community-icon-title">
      <Header
        id="community-icon-title"
        title="Community icon"
        subtitle={`The picture everyone sees for ${name} in the community list.`}
      />
      {community ? (
        // A new community or connection starts with fresh state.
        <IconEditor
          key={`${connection.scope}:${connection.generation}`}
          community={community}
          communityName={communityName}
          active={active}
        />
      ) : (
        <p role="status">Choose a connected community to change its icon.</p>
      )}
    </section>
  );
}

function IconEditor({
  community,
  communityName,
  active,
}: {
  community: string;
  communityName?: string | undefined;
  active(): boolean;
}) {
  const choose = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const initialRead = useRef<AbortController>(null);
  const [icon, setIcon] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt retries the read.
  useEffect(() => {
    const controller = new AbortController();
    initialRead.current = controller;
    setIcon(undefined);
    setLoaded(false);
    read(community, controller.signal).then(
      (published) => {
        if (controller.signal.aborted) return;
        setIcon(published);
        setLoaded(true);
      },
      () => {
        if (!controller.signal.aborted)
          setError("Couldn't load the current icon.");
      },
    );
    return () => controller.abort();
  }, [community, attempt]);

  const save = async (next: () => Promise<string>, done: string) => {
    // A save supersedes a slower initial read.
    initialRead.current?.abort();
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const value = await next();
      if (!active()) return;
      await setCommunityIcon(community, value);
      // Read back what the community now publishes; the relay accepted the
      // change, so a failed readback falls back to what was sent.
      const published = await read(
        community,
        AbortSignal.timeout(12_000),
      ).catch(() => value || undefined);
      if (!active()) return;
      setIcon(published);
      setLoaded(true);
      setStatus(done);
    } catch (reason) {
      if (!active()) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      // The save cancelled the initial read; read the icon again.
      if (!loaded) setAttempt((n) => n + 1);
    } finally {
      if (active()) setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-label="Community icon image"
        accept="image/gif,image/png,image/jpeg,image/webp"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void save(() => iconDataUrl(file), "Icon updated.");
        }}
      />
      <SettingsGroup>
        <PreferenceRow
          icon={
            <Avatar
              src={icon}
              alt=""
              fallback={communityName ?? "?"}
              size="large"
              shape="squircle"
            />
          }
          title={!loaded ? "Icon unknown" : icon ? "Icon set" : "No icon"}
          subtitle={
            error ? (
              <span role="alert">{error}</span>
            ) : (
              <span role="status">
                {status || "Square images work best. Buzz resizes them to fit."}
              </span>
            )
          }
          trailing={
            <>
              {!loaded && error && (
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() => {
                    choose.current?.focus();
                    setError("");
                    setAttempt((n) => n + 1);
                  }}
                >
                  Retry
                </Button>
              )}
              {icon && (
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() => {
                    choose.current?.focus();
                    void save(async () => "", "Icon removed.");
                  }}
                >
                  Remove icon
                </Button>
              )}
              <Button
                ref={choose}
                size="xs"
                loading={busy}
                onClick={() => input.current?.click()}
              >
                Choose image…
              </Button>
            </>
          }
        />
      </SettingsGroup>
    </>
  );
}
