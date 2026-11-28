import { type RefObject, useLayoutEffect, useRef } from "react";

/** Which message's video or audio clip a player plays, and whether it is the
 * player of the reader that opens the message whole rather than of its brief
 * in the chat. */
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
  /** A video, or an audio clip: that has no picture, so no poster or still. */
  media: HTMLMediaElement;
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
  still(): HTMLElement | null | undefined;
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

/** The mounted players of one video or clip of one message, oldest first. */
const players = new Map<string, Player[]>();
/** The player of each that holds its playback: the last to start, or the last
 * it was handed to. */
const holders = new Map<string, Player>();
/** The media of every mounted player. */
const joined = new WeakSet<HTMLMediaElement>();

function playbackOf(player: Player): Playback {
  const { media: video, pending } = player;
  return {
    seconds: pending?.seconds ?? video.currentTime,
    playing: !video.paused && !video.ended && !video.error,
    started: pending?.started ?? player.started(),
    volume: video.volume,
    muted: video.muted,
  };
}

/** Lifts a player's still. A video it had sent aside is back at its
 * position. */
function uncover(player: Player) {
  player.cover?.remove();
  delete player.cover;
}

function settle(player: Player) {
  player.pending?.cancel();
  delete player.pending;
  uncover(player);
}

/** The frame `video` shows, drawn no larger than it or `target` draws it. */
function frameOf(video: HTMLMediaElement, target: HTMLMediaElement) {
  if (
    !(video instanceof HTMLVideoElement) ||
    !(target instanceof HTMLVideoElement)
  )
    return undefined;
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

/** How long a paused video whose seek has ended may go without presenting a
 * frame of its position before it is sent there again. */
const unpresentedMs = 250;
/** How far aside that sends it first: to another frame of any clip of ten
 * frames a second or more. */
const asideSeconds = 0.1;
/** How many times, for one position. */
const asideLimit = 3;
/** How far from where a seek took it a video may report itself once the seek
 * has ended: settled, and having played on since. */
const settledSeconds = 0.00001;
const playedOnSeconds = 1;

/** Calls `shown` once `video` presents a frame of its position, having been
 * sent to `seconds`. Nothing else lifts a still: a seek that has ended and
 * data that has loaded say what the video holds, not what it shows.
 *
 * A frame is of the position when it is the last the video has presented by
 * the time the seek has ended, and is from no more than half a second before
 * the position, and not from after it while paused. An older frame is from
 * before the seek, and so is a new video's first, which a browser may present
 * while the seek is under way and report after it. A browser may equally
 * report the frame of the position just before it reports the seek over.
 *
 * WebKit can end a seek on a paused video and present no frame for it: where
 * the video's first frame arrives as the seek to its start position ends,
 * that frame stays, until the video plays or is sent to another frame.
 * Sending it to the same position again does nothing. So a paused video that
 * has presented no frame of its position is sent a little aside and, once it
 * presents a frame there, back. The still covers both.
 *
 * Once a seek the hand-off did not make has moved the video, the still is no
 * picture of where it is, and the first frame presented for that seek lifts
 * it, whatever its media time. */
function whenShown(
  video: HTMLVideoElement,
  seconds: number,
  shown: () => void,
) {
  const reports = typeof video.requestVideoFrameCallback === "function";
  let sent = false;
  let stopped = false;
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The media time of the last frame presented since the video was last
   * sent anywhere. */
  let presented: number | undefined;
  /** Where the hand-off last left the video, as the video reported it
   * straight after. An engine may take a video near where it is sent rather
   * than there, as Chromium does to the whole microsecond before, and it is
   * that place the video reports while the seek is under way. */
  let rest = seconds;
  /** Where the video is while it is sent aside, as it reported it straight
   * after, and where it goes back to. */
  let aside: { at: number; home: number } | undefined;
  let asides = 0;
  /** A frame from here or before is of where the video was sent aside. One
   * from ahead of a paused video's position is never of it. */
  let floor = Number.NEGATIVE_INFINITY;
  /** Whether a seek the hand-off did not make has moved the video. */
  let moved = false;
  const there = () =>
    sent &&
    !video.seeking &&
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  const of = (mediaTime: number, at: number) =>
    mediaTime > at - 0.5 &&
    mediaTime <= at + (video.paused ? 0.001 : 0.5) &&
    (mediaTime > 0 || at <= 0);
  /** Ends a wait, and puts a video sent aside back at its position. */
  const home = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!aside) return;
    const { at, home: to } = aside;
    aside = undefined;
    presented = undefined;
    // A seek made since, whose event is still to come, stands. A video whose
    // seek is under way reports where that seek takes it, which for the
    // hand-off's own is what it reported straight after it was sent. One
    // whose seek has ended may have played on from there, and Chromium's may
    // settle a microsecond off it.
    if (video.seeking && video.currentTime !== at) return;
    video.currentTime = to;
    rest = video.currentTime;
  };
  const sendAside = () => {
    timer = undefined;
    if (aside || !there() || !video.paused) return;
    const at = video.currentTime;
    const ahead = at + asideSeconds;
    // Within the second it is in, where the clip allows: a player's readout
    // follows its video.
    const to =
      at % 1 < asideSeconds && ahead < video.duration
        ? ahead
        : Math.max(0, at - asideSeconds);
    if (to === at) return;
    asides += 1;
    presented = undefined;
    video.currentTime = to;
    aside = { at: video.currentTime, home: at };
    if (to < at) floor = aside.at;
  };
  /** Acts on the last frame presented, once the seek has ended. */
  const judge = () => {
    if (presented === undefined || !there()) return;
    if (aside) {
      if (of(presented, aside.at)) home();
    } else if (moved || (presented > floor && of(presented, video.currentTime)))
      finish();
  };
  function arrived() {
    judge();
    // Not while a seek judging made is under way, nor once the still has lifted.
    if (stopped || !there()) return;
    clearTimeout(timer);
    timer = aside
      ? setTimeout(home, unpresentedMs)
      : reports && asides < asideLimit
        ? setTimeout(sendAside, unpresentedMs)
        : undefined;
  }
  /** A seek the hand-off did not make leaves the video where it went. One it
   * made is going where the video reported straight after it.
   *
   * A seek can end before its event arrives, when the main thread is busy.
   * The video is then where the seek left it: for the hand-off's own, within
   * a microsecond of where it reported, or as far on as it has played. */
  const sought = () => {
    const at = video.currentTime;
    const off = at - (aside ? aside.at : rest);
    if (!off) return;
    if (
      !video.seeking &&
      off > -settledSeconds &&
      off < (video.paused ? settledSeconds : playedOnSeconds)
    )
      return;
    aside = undefined;
    presented = undefined;
    rest = at;
    asides = 0;
    floor = Number.NEGATIVE_INFINITY;
    moved = true;
  };
  /** A browser that reports no frames: its position moving on, by playing or
   * by a seek, is the one sign that it shows something newer. */
  const progressed = () => {
    if (!reports && there() && (moved || video.currentTime !== rest)) finish();
  };
  const listeners = [
    ["seeked", arrived],
    ["loadeddata", arrived],
    ["seeking", sought],
    // It plays on from its position, not from where it was sent aside.
    ["play", home],
    ["timeupdate", progressed],
  ] as const;
  const stop = () => {
    stopped = true;
    for (const [name, listener] of listeners)
      video.removeEventListener(name, listener);
    if (frame !== undefined) video.cancelVideoFrameCallback(frame);
    frame = undefined;
    home();
  };
  function finish() {
    stop();
    shown();
  }
  const watch = () => {
    frame = video.requestVideoFrameCallback?.((_now, { mediaTime }) => {
      frame = undefined;
      presented = mediaTime;
      judge();
      if (!stopped) watch();
    });
  };
  for (const [name, listener] of listeners)
    video.addEventListener(name, listener);
  watch();
  return {
    /** The video has been sent to the position. */
    sent() {
      sent = true;
      rest = video.currentTime;
      arrived();
    },
    stop,
  };
}

/** Lays `still` over a player's video until the video presents the frame it
 * was sent to, however long that takes. */
function cover(
  player: Player,
  still: HTMLCanvasElement | undefined,
  seconds: number,
) {
  const slot = player.still();
  const { media: video } = player;
  if (!still || !slot || !(video instanceof HTMLVideoElement)) return undefined;
  const lift = () => {
    if (player.cover?.still !== still) return;
    player.cover.remove();
    delete player.cover;
  };
  const watch = whenShown(video, seconds, lift);
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
 * its video until the video presents that frame itself, however long that
 * takes, so the still never lifts onto anything else. And a video still to
 * load is given the position as its start,
 * which the browser seeks to as the metadata loads, before it presents a
 * frame or plays. */
function hand(from: Player, to: Player) {
  // A player still under its own still passes that on: its video has yet to
  // show the frame. Lifted before its position is read, which is then the
  // one it was handed.
  const held = from.cover?.still;
  uncover(from);
  const playback = playbackOf(from);
  const still = playback.started
    ? (held ?? frameOf(from.media, to.media))
    : undefined;
  settle(from);
  from.media.pause();
  settle(to);
  const { media: video } = to;
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
  // A paused player reports its position too.
  const report = () => video.dispatchEvent(new Event("timeupdate"));
  const seek = () => {
    if (video.currentTime !== playback.seconds)
      video.currentTime = playback.seconds;
    report();
    // Again once the commit this runs in is over. A closing reader hands
    // back while React removes it, when React passes no event on, so a
    // player that follows its media through React would keep the position
    // it had before.
    queueMicrotask(report);
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
  joined.add(player.media);
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
    if (player.media.paused) return;
    hold(key, player);
    // One video never sounds from two players.
    for (const other of group)
      if (other !== player && !other.media.paused) other.media.pause();
  };
  player.media.addEventListener("play", played);
  return () => {
    player.media.removeEventListener("play", played);
    joined.delete(player.media);
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

const noStart = () => {};

/** Joins a player to the others playing the same video or audio clip of the
 * same message. A reader's player takes playback over from the brief's when
 * it mounts, and hands it back when it unmounts if it still holds it:
 * position, play state, volume and mute. An audio clip has no picture, so it
 * passes no `started`, `start` or `still`. */
export function usePlaybackHandoff(
  media: RefObject<HTMLMediaElement | null>,
  /** Undefined while the player draws no video or clip. */
  key: string | undefined,
  {
    reader,
    active,
    started = false,
    start = noStart,
    still,
    onLent,
  }: {
    reader: boolean;
    active: boolean;
    started?: boolean;
    /** Must be stable. */
    start?(posterless: boolean): void;
    still?: RefObject<HTMLElement | null>;
    onLent?: ((lent: boolean) => void) | undefined;
  },
) {
  const latest = useRef({ active, started });
  useLayoutEffect(() => {
    latest.current = { active, started };
  }, [active, started]);
  useLayoutEffect(() => {
    const element = media.current;
    if (!key || !element) return;
    return join(key, {
      media: element,
      reader,
      active: () => latest.current.active,
      started: () => latest.current.started,
      start,
      still: () => still?.current,
      onLent,
    });
  }, [media, key, reader, start, still, onLent]);
}

/** Marks the list of a brief's attachments with its message, for
 * `quietBriefs` to find. */
export const briefOf = "data-brief-of";

/** Pauses what plays in a message's briefs outside the hand-off, for a reader
 * on screen. A player a plugin draws is its own: it hands nothing over and
 * the reader's copy of it starts afresh, so the one in the chat must not
 * sound on under it. */
export function quietBriefs(messageId: string) {
  for (const list of document.querySelectorAll(`[${briefOf}]`)) {
    if (list.getAttribute(briefOf) !== messageId) continue;
    for (const media of list.querySelectorAll<HTMLMediaElement>("audio, video"))
      if (!joined.has(media) && !media.paused) media.pause();
  }
}
