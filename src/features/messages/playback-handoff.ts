import { type RefObject, useLayoutEffect, useRef } from "react";

/** Which message's video a player shows, and whether it is the player of the
 * reader that opens the message whole rather than of its brief in the chat. */
export type PlaybackHandoff = Readonly<{
  messageId: string;
  reader?: boolean;
}>;

type Playback = Readonly<{
  seconds: number;
  playing: boolean;
  started: boolean;
  volume: number;
  muted: boolean;
}>;

type Player = {
  video: HTMLVideoElement;
  reader: boolean;
  /** Whether its presentation is on screen. A hidden player neither takes
   * playback over nor is handed it. */
  active(): boolean;
  /** Whether the player has left its poster for the video's own frames. */
  started(): boolean;
  /** Counts as started: it was handed a video that has. With `posterless`
   * it leaves its poster for good too. */
  start(posterless: boolean): void;
  /** Where a still of a frame it was handed lies over its video. */
  still(): HTMLElement | null;
  /** Tells a brief whether a reader holds the playback it took from it. */
  onLent?: ((lent: boolean) => void) | undefined;
  lent?: boolean;
  /** The position and frame it was handed, until its metadata loads and the
   * video can be asked for them. */
  pending?: { seconds: number; started: boolean; cancel(): void };
  /** The still of the frame it was handed, which covers its video until the
   * video shows that frame itself. */
  cover?: { still: HTMLCanvasElement; remove(): void };
  /** The brief a reader took over from. */
  from?: Player;
};

/** The mounted players of one video of one message, oldest first. */
const players = new Map<string, Player[]>();
/** The player of each video that holds its playback: the last to start, or the
 * last it was handed to. */
const holders = new Map<string, Player>();

function playbackOf(player: Player): Playback {
  const { video, pending } = player;
  return {
    seconds: pending?.seconds ?? video.currentTime,
    playing: !video.paused && !video.ended && !video.error,
    started: pending?.started ?? player.started(),
    volume: video.volume,
    muted: video.muted,
  };
}

function settle(player: Player) {
  player.pending?.cancel();
  delete player.pending;
  player.cover?.remove();
  delete player.cover;
}

/** The frame `video` shows, drawn no larger than it or `target` draws it. */
function frameOf(video: HTMLVideoElement, target: HTMLVideoElement) {
  const { videoWidth, videoHeight } = video;
  if (
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    !videoWidth ||
    !videoHeight
  )
    return undefined;
  const drawn = Math.max(
    ...[video, target].map((element) =>
      Math.min(
        element.clientWidth / videoWidth,
        element.clientHeight / videoHeight,
      ),
    ),
  );
  const scale = drawn > 0 ? Math.min(1, drawn * (devicePixelRatio || 1)) : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(videoWidth * scale));
  canvas.height = Math.max(1, Math.round(videoHeight * scale));
  // Opaque, so a frame the browser will not draw leaves the still dark
  // rather than clear over whatever the video shows meanwhile.
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return undefined;
  try {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch {
    return undefined;
  }
  return canvas;
}

/** How long a video whose seek has ended may go without reporting a frame of
 * its position before its still is lifted anyway. A browser reports none for
 * a video off screen, and some report none at all. */
const unreportedFrameMs = 250;

/** Calls `shown` once `video` shows a frame of the position, `seconds`, it
 * was sent to: one it presents once that seek has ended, from no more than
 * half a second before the position. An older frame is from before the seek,
 * and so is a new video's first, which a browser may present while the seek
 * is under way and report after it. */
function whenShown(
  video: HTMLVideoElement,
  seconds: number,
  shown: () => void,
) {
  let sent = false;
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const there = () =>
    sent &&
    !video.seeking &&
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  const stop = () => {
    for (const name of ["seeked", "loadeddata"])
      video.removeEventListener(name, arrived);
    if (frame !== undefined) video.cancelVideoFrameCallback(frame);
    clearTimeout(timer);
  };
  const finish = () => {
    stop();
    shown();
  };
  const watch = () => {
    frame = video.requestVideoFrameCallback?.((_now, { mediaTime }) =>
      there() && mediaTime > seconds - 0.5 && (mediaTime > 0 || seconds <= 0)
        ? finish()
        : watch(),
    );
  };
  function arrived() {
    if (there()) timer ??= setTimeout(finish, unreportedFrameMs);
  }
  for (const name of ["seeked", "loadeddata"])
    video.addEventListener(name, arrived);
  watch();
  return {
    /** The video has been sent to the position. */
    sent() {
      sent = true;
      arrived();
    },
    stop,
  };
}

/** Lays `still` over a player's video until the video shows the frame it was
 * sent to. */
function cover(
  player: Player,
  still: HTMLCanvasElement | undefined,
  seconds: number,
) {
  const slot = player.still();
  if (!still || !slot) return undefined;
  const lift = () => {
    if (player.cover?.still !== still) return;
    player.cover.remove();
    delete player.cover;
  };
  const watch = whenShown(player.video, seconds, lift);
  slot.replaceChildren(still);
  player.cover = {
    still,
    remove() {
      watch.stop();
      still.remove();
    },
  };
  return watch;
}

function lend(brief: Player | undefined, lent: boolean) {
  if (!brief || !!brief.lent === lent) return;
  brief.lent = lent;
  brief.onLent?.(lent);
}

/** Records who holds a video's playback. While a reader does, the brief it
 * took it from is lent, so its row stays to take it back. */
function hold(key: string, player: Player | undefined) {
  const previous = holders.get(key);
  if (previous === player) return;
  lend(previous?.from, false);
  if (player) holders.set(key, player);
  else holders.delete(key);
  lend(player?.from, true);
}

/** Moves playback as opening a video fullscreen does: the player left behind
 * pauses, and the other starts from its position. Fullscreen always plays;
 * here the play state and the sound move too. Speed needs no move: it is one
 * saved preference every player follows.
 *
 * The player taking over never shows or plays anything from before the
 * position. Its poster goes at once, where the other player has a frame or a
 * position to give. A still of the frame the other player shows lies over
 * its video until the video shows that frame itself, however long it takes
 * to load. And a video still to load is given the position as its start,
 * which the browser seeks to as the metadata loads, before it presents a
 * frame or plays. */
function hand(from: Player, to: Player) {
  const playback = playbackOf(from);
  // A player still under its own still passes that on: its video has yet to
  // show the frame.
  const still = playback.started
    ? (from.cover?.still ?? frameOf(from.video, to.video))
    : undefined;
  settle(from);
  from.video.pause();
  settle(to);
  const { video } = to;
  video.volume = playback.volume;
  video.muted = playback.muted;
  // The poster goes only for something better: the frame, or a position the
  // poster is no picture of. A video started at 0:00 with no frame yet keeps
  // it, as the player it comes from does, rather than load dark.
  if (playback.started) to.start(!!still || playback.seconds > 0);
  // Started now, in the commit of the press that opened or closed the reader,
  // not when the video loads: a browser may refuse sound that starts later,
  // away from the press. One it refuses stays paused at the position.
  const play = () => {
    if (playback.playing) void video.play().catch(() => {});
  };
  const seek = () => {
    if (video.currentTime !== playback.seconds)
      video.currentTime = playback.seconds;
    // A paused player reports its position too.
    video.dispatchEvent(new Event("timeupdate"));
  };
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    if (video.currentTime !== playback.seconds) {
      const shown = cover(to, still, playback.seconds);
      seek();
      shown?.sent();
    }
    play();
    return;
  }
  const shown = cover(to, still, playback.seconds);
  const loaded = () => {
    delete to.pending;
    // Only where the browser did not start there itself.
    seek();
    shown?.sent();
  };
  video.addEventListener("loadedmetadata", loaded, { once: true });
  to.pending = {
    seconds: playback.seconds,
    started: playback.started,
    cancel: () => video.removeEventListener("loadedmetadata", loaded),
  };
  // Before the position: Chromium otherwise records the stretch from 0:00 to
  // the position as played, though it plays none of it.
  play();
  // With no metadata this sets where the browser starts, and what the player
  // reports as its position meanwhile.
  seek();
}

/** The briefs on screen, oldest first. */
const briefsOf = (group: readonly Player[]) =>
  group.filter((other) => !other.reader && other.active());

function join(key: string, player: Player) {
  const group = players.get(key) ?? [];
  players.set(key, group);
  const holder = holders.get(key);
  const briefs = briefsOf(group);
  group.push(player);
  // A second reader of the video leaves it with the reader that has it.
  if (player.reader && player.active() && !holder?.reader) {
    // The brief that is playing, else the last to hold playback, else the
    // newest.
    const from =
      briefs.find((brief) => playbackOf(brief).playing) ??
      (holder && briefs.includes(holder) ? holder : briefs.at(-1));
    if (from) {
      player.from = from;
      hand(from, player);
      hold(key, player);
    }
  }
  const played = () => {
    // A hand-off has paused it since: React replays a mount in development,
    // and that hands playback back and takes it again before this event of
    // the hand back arrives.
    if (player.video.paused) return;
    hold(key, player);
    // One video never sounds from two players.
    for (const other of group)
      if (other !== player && !other.video.paused) other.video.pause();
  };
  player.video.addEventListener("play", played);
  return () => {
    player.video.removeEventListener("play", played);
    group.splice(group.indexOf(player), 1);
    if (!group.length) players.delete(key);
    if (holders.get(key) === player) {
      // A reader hands back what it still holds. A brief that started since
      // keeps its own playback.
      const rest = player.reader ? briefsOf(group) : [];
      const to =
        player.from && rest.includes(player.from) ? player.from : rest.at(-1);
      if (to) hand(player, to);
      hold(key, to);
    }
    settle(player);
    lend(player, false);
    for (const other of group) if (other.from === player) delete other.from;
  };
}

/** Joins a video player to the others showing the same video of the same
 * message. A reader's player takes playback over from the brief's when it
 * mounts, and hands it back when it unmounts if it still holds it: position,
 * play state, volume and mute. */
export function usePlaybackHandoff(
  video: RefObject<HTMLVideoElement | null>,
  /** Undefined while the player draws no video. */
  key: string | undefined,
  {
    reader,
    active,
    started,
    start,
    still,
    onLent,
  }: {
    reader: boolean;
    active: boolean;
    started: boolean;
    /** Must be stable. */
    start(posterless: boolean): void;
    still: RefObject<HTMLElement | null>;
    onLent?: ((lent: boolean) => void) | undefined;
  },
) {
  const latest = useRef({ active, started });
  useLayoutEffect(() => {
    latest.current = { active, started };
  }, [active, started]);
  useLayoutEffect(() => {
    const element = video.current;
    if (!key || !element) return;
    return join(key, {
      video: element,
      reader,
      active: () => latest.current.active,
      started: () => latest.current.started,
      start,
      still: () => still.current,
      onLent,
    });
  }, [video, key, reader, start, still, onLent]);
}
