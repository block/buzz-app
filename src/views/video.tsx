import { createElement, useEffect, useRef } from "react";
import type { CanvasViewProps, CanvasViewType } from "../view";
import { AddressBar, pageUrl } from "./page";
import { styles } from "../styles";

export type VideoState = {
  url: string;
  /** Where the video was, in seconds, at `at`. */
  time: number;
  playing: boolean;
  /** When `time` was true, in milliseconds since 1970. */
  at?: number;
};

/** How far apart, in seconds, two players may drift before one is moved. */
const DRIFT = 1.5;

function parse(input: unknown): VideoState | undefined {
  const value = input as {
    url?: unknown;
    time?: unknown;
    playing?: unknown;
    at?: unknown;
  } | null;
  const url = pageUrl(value?.url);
  const time = value?.time ?? 0;
  if (
    url === undefined ||
    typeof time !== "number" ||
    !(time >= 0 && time <= 86_400) ||
    (value?.at !== undefined &&
      !(typeof value.at === "number" && Number.isFinite(value.at)))
  )
    return;
  return {
    url,
    time,
    playing: value?.playing === true,
    ...(typeof value?.at === "number" ? { at: value.at } : {}),
  };
}

/** Where a video is now: it has kept playing since its state was saved. This
 * trusts both people's clocks to agree to within the allowed drift. */
export const positionNow = (
  state: Pick<VideoState, "time" | "playing"> & { at?: number | undefined },
  now = Date.now(),
) =>
  state.playing && state.at !== undefined
    ? state.time + Math.max(0, now - state.at) / 1000
    : state.time;

function Video({ state, interactive, update }: CanvasViewProps<VideoState>) {
  const player = useRef<HTMLVideoElement>(null);
  // Set while this view moves the player itself, so that isn't reported back
  // as something the viewer did.
  const applying = useRef(false);
  const { url, time, playing, at } = state;
  useEffect(() => {
    const video = player.current;
    if (!video || !url) return;
    applying.current = true;
    const target = positionNow({ time, playing, at });
    if (Math.abs(video.currentTime - target) > DRIFT)
      video.currentTime = target;
    // Playback can be refused until the viewer has clicked in the app.
    if (playing) void video.play().catch(() => {});
    else video.pause();
    const done = setTimeout(() => {
      applying.current = false;
    }, 250);
    return () => clearTimeout(done);
  }, [url, time, playing, at]);
  const report = () => {
    const video = player.current;
    if (!video || !interactive || applying.current) return;
    const next = {
      url,
      time: video.currentTime,
      playing: !video.paused,
      at: Date.now(),
    };
    if (
      next.playing !== playing ||
      Math.abs(next.time - positionNow(state)) > DRIFT
    )
      update(next);
  };
  return (
    <div className={styles.fill}>
      {interactive && (
        <AddressBar
          url={url}
          label="Video address"
          go={(next) => update({ url: next, time: 0, playing: false })}
        />
      )}
      {url ? (
        // biome-ignore lint/a11y/useMediaCaption: the address is the viewer's own; no captions exist to offer.
        <video
          ref={player}
          className={styles.video}
          src={url}
          controls={interactive}
          playsInline
          onPlay={report}
          onPause={report}
          onSeeked={report}
        />
      ) : (
        <p className={styles.hint}>
          {interactive
            ? "Enter the address of a video file to watch it together."
            : "No video is open here yet."}
        </p>
      )}
    </div>
  );
}

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** A video file everyone watches together: play, pause and seek are shared. */
export const videoView: CanvasViewType<VideoState> = {
  type: "video",
  title: "Video",
  initial: { url: "", time: 0, playing: false },
  parse,
  describe: (state) =>
    state.url
      ? `The video ${state.url}, ${state.playing ? "playing" : "paused"} at ${clock(positionNow(state))}.`
      : "An empty video player.",
  component: Video,
};
