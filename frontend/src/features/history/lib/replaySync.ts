/**
 * Reads the sidecar that says when a replay's first video frame was
 * captured, so video time can be turned into mouse-trace time.
 *
 * A replay does not start when its run started. The trim copies whole
 * capture segments and begins at the keyframe of the segment containing the
 * run start, leaving up to one segment length of pre-roll in front (see
 * internal/runs/replaysync.go). The backend records that first frame's
 * wall-clock time beside the replay; with it the alignment is arithmetic
 * rather than something to be measured back out of the pixels.
 *
 * Replays trimmed before the sidecar existed simply have none. Callers get
 * null and are expected to fall back to aligning by hand, not to guess.
 */

/** Must match ReplaySyncVersion in internal/runs/replaysync.go. */
const SUPPORTED_VERSION = 1;

export type ReplaySync = {
  version: number;
  frame0EpochMs: number;
  runStartEpochMs: number;
  runEndEpochMs: number;
  replayEndEpochMs: number;
  sessionStartEpochMs: number;
  segmentSeconds: number;
};

/**
 * The sidecar sits next to the replay and is served by the same handler, so
 * its URL is the replay's with the suffix added. The content-version query
 * is carried over: a re-trimmed replay gets a new one, which keeps a stale
 * sidecar from being served out of the browser cache alongside a fresh clip.
 */
export function replaySyncUrl(replayUrl: string): string {
  const [path, query] = replayUrl.split("?");
  return `${path}.sync.json${query ? `?${query}` : ""}`;
}

export async function fetchReplaySync(
  replayUrl: string,
): Promise<ReplaySync | null> {
  try {
    const res = await fetch(replaySyncUrl(replayUrl));
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<ReplaySync>;
    if (
      data.version !== SUPPORTED_VERSION ||
      !Number.isFinite(data.frame0EpochMs) ||
      (data.frame0EpochMs ?? 0) <= 0
    ) {
      return null;
    }
    return data as ReplaySync;
  } catch {
    // A missing or unreadable sidecar is an ordinary state, not a failure:
    // the replay still plays, it just cannot carry a trail.
    return null;
  }
}

/** Wall-clock time of a moment in the replay, in mouse-trace units. */
export function videoTimeToTraceEpochMs(
  sync: ReplaySync,
  videoTimeSeconds: number,
  manualOffsetMs = 0,
): number {
  return sync.frame0EpochMs + videoTimeSeconds * 1000 + manualOffsetMs;
}
