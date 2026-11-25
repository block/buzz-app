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
  start(): void;
  /** Tells a brief whether a reader holds the playback it took from it. */
  onLent?: ((lent: boolean) => void) | undefined;
  lent?: boolean;
  /** The position and frame it was handed and cannot show until its metadata
   * loads. */
  pending?: { seconds: number; started: boolean; cancel(): void };
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
 * saved preference every player follows. */
function hand(from: Player, to: Player) {
  const playback = playbackOf(from);
  settle(from);
  from.video.pause();
  settle(to);
  const { video } = to;
  video.volume = playback.volume;
  video.muted = playback.muted;
  const seek = () => {
    delete to.pending;
    if (video.currentTime !== playback.seconds) {
      video.currentTime = playback.seconds;
      // A paused player reports its position too.
      video.dispatchEvent(new Event("timeupdate"));
    }
    if (playback.started) to.start();
  };
  // A position set before the metadata does not hold.
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
  else {
    video.addEventListener("loadedmetadata", seek, { once: true });
    to.pending = {
      seconds: playback.seconds,
      started: playback.started,
      cancel: () => video.removeEventListener("loadedmetadata", seek),
    };
  }
  // Started now, in the commit of the press that opened or closed the reader,
  // not when the video loads: a browser may refuse sound that starts later,
  // away from the press. One it refuses stays paused at the position.
  if (playback.playing) void video.play().catch(() => {});
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
    setStarted,
    onLent,
  }: {
    reader: boolean;
    active: boolean;
    started: boolean;
    setStarted(started: boolean): void;
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
      start: () => setStarted(true),
      onLent,
    });
  }, [video, key, reader, setStarted, onLent]);
}
