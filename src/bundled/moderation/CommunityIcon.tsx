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

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

const read = async (community: string, signal: AbortSignal) =>
  (await fetchCommunityPresentation(community, signal)).publishedIcon;

/** Center-crop to a square and encode small enough to sign as one relay command. */
async function iconDataUrl(file: Blob) {
  const image = await createImageBitmap(file);
  const side = Math.min(image.width, image.height);
  const canvas = document.createElement("canvas");
  for (const size of [256, 128]) {
    canvas.width = canvas.height = size;
    canvas
      .getContext("2d")
      ?.drawImage(
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
    // WebKit can't encode WebP and falls back to PNG; JPEG keeps photos small.
    for (const type of ["image/webp", "image/png", "image/jpeg"]) {
      const url = canvas.toDataURL(type, 0.85);
      if (
        url.startsWith(`data:${type};`) &&
        url.length <= COMMUNITY_ICON_MAX_DATA_URL
      )
        return url;
    }
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
  const input = useRef<HTMLInputElement>(null);
  const [icon, setIcon] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!community) return;
    const controller = new AbortController();
    setIcon(undefined);
    read(community, controller.signal).then(setIcon, () => {});
    return () => controller.abort();
  }, [community]);

  const save = async (next: () => Promise<string>, done: string) => {
    if (!community) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const value = await next();
      await setCommunityIcon(community, value);
      // Read back what the community now publishes, not what was sent.
      const published = await read(community, AbortSignal.timeout(12_000));
      if (!active()) return;
      setIcon(published);
      setStatus(done);
    } catch (reason) {
      if (active()) setError(message(reason));
    } finally {
      if (active()) setBusy(false);
    }
  };

  const name = communityName ?? "this community";
  return (
    <section aria-labelledby="community-icon-title">
      <Header
        id="community-icon-title"
        title="Community icon"
        subtitle={`The picture everyone sees for ${name} in the community list.`}
      />
      {community ? (
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
              title={icon ? "Icon set" : "No icon"}
              subtitle={
                error ? (
                  <span role="alert">{error}</span>
                ) : (
                  <span role="status">
                    {status ||
                      "Square images work best. Buzz resizes them to fit."}
                  </span>
                )
              }
              trailing={
                <>
                  {icon && (
                    <Button
                      size="xs"
                      disabled={busy}
                      onClick={() => void save(async () => "", "Icon removed.")}
                    >
                      Remove icon
                    </Button>
                  )}
                  <Button
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
      ) : (
        <p role="status">Choose a connected community to change its icon.</p>
      )}
    </section>
  );
}
