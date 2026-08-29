import { useEffect, useState } from "react";

/**
 * Shares the replay's <video> element with the panels drawn underneath it.
 *
 * The player keeps its position and its seek function as local state inside
 * VideoPlayer, and passes neither upward. Anything below the video that
 * wants to show where playback is, or move it, therefore has nothing to
 * work with.
 *
 * Rather than thread that state up through two component layers - which
 * would mean rewriting a file this fork otherwise barely touches - the
 * overlay, which already sits inside the player and holds its ref, puts the
 * element here for the panels to find. Keyed by the run's file path so a
 * compare view cannot cross the two players over.
 *
 * Only the element is shared. Whoever wants the current time reads it from
 * the element itself, which keeps this free of a ticking subscription that
 * every consumer would pay for whether it needed it or not.
 */

const players = new Map<string, HTMLVideoElement>();
const listeners = new Map<string, Set<(video: HTMLVideoElement | null) => void>>();

function notify(filePath: string) {
  const video = players.get(filePath) ?? null;
  for (const listener of listeners.get(filePath) ?? []) listener(video);
}

/** Publishes a player. Returns the function that withdraws it again. */
export function registerReplayPlayer(
  filePath: string,
  video: HTMLVideoElement,
): () => void {
  players.set(filePath, video);
  notify(filePath);
  return () => {
    if (players.get(filePath) === video) {
      players.delete(filePath);
      notify(filePath);
    }
  };
}

export function useReplayPlayer(filePath: string): HTMLVideoElement | null {
  const [video, setVideo] = useState<HTMLVideoElement | null>(
    () => players.get(filePath) ?? null,
  );

  useEffect(() => {
    setVideo(players.get(filePath) ?? null);
    let set = listeners.get(filePath);
    if (!set) {
      set = new Set();
      listeners.set(filePath, set);
    }
    const listener = (next: HTMLVideoElement | null) => setVideo(next);
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) listeners.delete(filePath);
    };
  }, [filePath]);

  return video;
}

const pending = new WeakMap<HTMLVideoElement, number | null>();

/**
 * Seeks, coalescing requests that arrive while the previous one is still
 * being served.
 *
 * Clicking along a marker strip issues seeks far faster than they complete -
 * one measured at 19 to 93 ms - and letting each one start its own
 * decode-from-keyframe stacks that work up. Holding only the newest target
 * keeps the wait bounded to a single seek, which is the same protection the
 * player applies to its own scrubber.
 */
export function seekReplay(video: HTMLVideoElement, seconds: number) {
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const clamped = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);

  if (video.seeking) {
    pending.set(video, clamped);
    if (!video.dataset.trailSeekHooked) {
      video.dataset.trailSeekHooked = "1";
      video.addEventListener("seeked", () => {
        const next = pending.get(video);
        pending.set(video, null);
        if (next !== null && next !== undefined) {
          video.currentTime = next;
        }
      });
    }
    return;
  }
  video.currentTime = clamped;
}
