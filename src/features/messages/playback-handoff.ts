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
  /** Whether the player has left its poster for the video's own frames. */
  started(): boolean;
  start(): void;
  /** What it was handed and cannot hold until its metadata loads. */
  pending?: { playback: Playback; cancel(): void };
  /** The brief a reader took over from. */
  from?: Player;
};

/** The mounted players of one video of one message, oldest first. */
const players = new Map<string, Player[]>();
/** The player of each video that held its playback last. */
const holders = new Map<string, Player>();

function playbackOf(player: Player): Playback {
  const { video } = player;
  return (
    player.pending?.playback ?? {
      seconds: video.currentTime,
      playing: !video.paused && !video.ended && !video.error,
      started: player.started(),
      volume: video.volume,
      muted: video.muted,
    }
  );
}

/** Moves playback as opening a video fullscreen does: the player left behind
 * pauses, and the other starts from its position. Fullscreen always plays;
 * here the play state and the sound move too. Speed needs no move: it is one
 * saved preference every player follows. */
function hand(from: Player, to: Player) {
  const playback = playbackOf(from);
  from.pending?.cancel();
  delete from.pending;
  from.video.pause();
  to.pending?.cancel();
  delete to.pending;
  const { video } = to;
  video.volume = playback.volume;
  video.muted = playback.muted;
  const apply = () => {
    delete to.pending;
    if (video.currentTime !== playback.seconds) {
      video.currentTime = playback.seconds;
      // A paused player reports its position too.
      video.dispatchEvent(new Event("timeupdate"));
    }
    if (playback.started) to.start();
    if (playback.playing) void video.play().catch(() => {});
  };
  // A position set before the metadata does not hold.
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
  else {
    video.addEventListener("loadedmetadata", apply, { once: true });
    to.pending = {
      playback,
      cancel: () => video.removeEventListener("loadedmetadata", apply),
    };
  }
}

function join(key: string, player: Player) {
  const group = players.get(key) ?? [];
  players.set(key, group);
  const briefs = group.filter((other) => !other.reader);
  group.push(player);
  if (player.reader) {
    // The brief that is playing, else the last to hold playback, else the
    // newest.
    const holder = holders.get(key);
    const from =
      briefs.find((brief) => playbackOf(brief).playing) ??
      (holder && briefs.includes(holder) ? holder : briefs.at(-1));
    if (from) {
      player.from = from;
      hand(from, player);
    }
  }
  // One video never sounds from two players.
  const played = () => {
    holders.set(key, player);
    for (const other of group) {
      if (other === player) continue;
      if (other.pending)
        other.pending = {
          ...other.pending,
          playback: { ...other.pending.playback, playing: false },
        };
      if (!other.video.paused) other.video.pause();
    }
  };
  player.video.addEventListener("play", played);
  return () => {
    player.video.removeEventListener("play", played);
    group.splice(group.indexOf(player), 1);
    if (holders.get(key) === player) holders.delete(key);
    if (player.reader) {
      const rest = group.filter((other) => !other.reader);
      const to =
        player.from && rest.includes(player.from) ? player.from : rest.at(-1);
      if (to) {
        hand(player, to);
        holders.set(key, to);
      }
    }
    player.pending?.cancel();
    if (!group.length) players.delete(key);
  };
}

/** Joins a video player to the others showing the same video of the same
 * message. A reader's player takes playback over from the brief's when it
 * mounts, and hands it back when it unmounts: position, play state, volume
 * and mute. */
export function usePlaybackHandoff(
  video: RefObject<HTMLVideoElement | null>,
  /** Undefined while the player draws no video. */
  key: string | undefined,
  reader: boolean,
  started: boolean,
  setStarted: (started: boolean) => void,
) {
  const latest = useRef(started);
  useLayoutEffect(() => {
    latest.current = started;
  }, [started]);
  useLayoutEffect(() => {
    const element = video.current;
    if (!key || !element) return;
    return join(key, {
      video: element,
      reader,
      started: () => latest.current,
      start: () => setStarted(true),
    });
  }, [video, key, reader, setStarted]);
}
