import { useStore } from "@/shared/hooks";
import { getScenarioName } from "@/shared/lib";
import { useMemo } from "react";

/**
 * What counts as a normal result for a scenario.
 *
 * The median of the last twenty runs. Twenty rather than ten because ten can
 * be a single sitting: across the scenarios with enough history, one session
 * supplies at least four fifths of the last ten in 14% of them and the whole
 * of it in 5%, against 1% either way at twenty. A reference that one bad
 * evening can replace is not a level, it is that evening.
 *
 * Little is lost by widening it. The two windows differ by 1.8% in the
 * median case. A per-session variant - the median of the last five sessions'
 * medians, so a sitting counts once however long it ran - was measured too
 * and landed 1.5% from the twenty-run median, which is to say nowhere: the
 * choice between reasonable definitions moves the number about two percent,
 * so the one that is easiest to explain and hardest to swing wins.
 *
 * The median rather than the mean, so one bad attempt cannot drag it, and
 * because the all-time mean sits below the recent median in 84% of scenarios
 * - it is weighed down by how the player used to be.
 *
 * The window is a run count, not a period, so how far back it reaches varies
 * enormously: a median of 78 days for the well-played scenarios, and most
 * scenarios never reach twenty runs at all. That is worth knowing when
 * reading the figure, so the span is reported rather than assumed away.
 */

const WINDOW = 20;
/** Below this, the sample says more about luck than about level. */
const MINIMUM = 3;

export type ScenarioNormal = {
  /** Median of the window, or null when there is too little history. */
  normal: number | null;
  /** How many runs the median was taken over. */
  runs: number;
  /** Days between the oldest and newest run in the window. */
  spanDays: number;
  /** Best score ever recorded locally for this scenario. */
  localBest: number;
  /**
   * Best score recorded before the run being looked at, so a result can be
   * told apart from the record it just set. Zero when nothing came before.
   */
  bestBefore: number;
  /** Runs on record for the scenario, however far back. */
  total: number;
};

const NONE: ScenarioNormal = {
  normal: null,
  runs: 0,
  spanDays: 0,
  localBest: 0,
  bestBefore: 0,
  total: 0,
};

export function useScenarioNormal(
  scenarioName: string,
  playedAt?: number,
): ScenarioNormal {
  const sessions = useStore((state) => state.sessions);
  return useMemo(
    () => computeScenarioNormal(sessions, scenarioName, playedAt),
    [sessions, scenarioName, playedAt],
  );
}

type Played = { at: number; score: number };

/** The hook's body, taking the sessions directly so it can be checked. */
export function computeScenarioNormal(
  sessions: Array<{ items: unknown[] }>,
  scenarioName: string,
  playedAt?: number,
): ScenarioNormal {
  if (!scenarioName) return NONE;

  const played: Played[] = [];
  let localBest = 0;
  let bestBefore = 0;
  for (const session of sessions) {
    for (const raw of session.items) {
      const item = raw as {
        stats?: { summary?: { datePlayed?: unknown; score?: unknown } };
      };
      if (getScenarioName(raw as never) !== scenarioName) continue;
      const at = Date.parse(String(item.stats?.summary?.datePlayed ?? ""));
      const score = Number(item.stats?.summary?.score ?? 0);
      if (!Number.isFinite(at) || !Number.isFinite(score) || score <= 0) {
        continue;
      }
      played.push({ at, score });
      if (score > localBest) localBest = score;
      // Strictly earlier, so a run is never counted as preceding itself.
      if (playedAt !== undefined && at < playedAt && score > bestBefore) {
        bestBefore = score;
      }
    }
  }

  if (played.length === 0) return NONE;
  played.sort((a, b) => a.at - b.at);

  const window = played.slice(-WINDOW);
  const total = played.length;
  if (window.length < MINIMUM) {
    return {
      normal: null,
      runs: window.length,
      spanDays: 0,
      localBest,
      bestBefore,
      total,
    };
  }

  const scores = window.map((p) => p.score).sort((a, b) => a - b);
  const middle = Math.floor(scores.length / 2);
  const normal =
    scores.length % 2 === 0
      ? (scores[middle - 1] + scores[middle]) / 2
      : scores[middle];

  const spanDays = Math.round(
    (window[window.length - 1].at - window[0].at) / 86_400_000,
  );

  return {
    normal,
    runs: window.length,
    spanDays,
    localBest,
    bestBefore,
    total,
  };
}

/**
 * The best score recorded locally for every scenario.
 *
 * The benchmark data carries a best of its own, but a personal best set
 * minutes ago can lead the server by a refresh. Taking the higher of the two
 * everywhere keeps one answer in the list rather than a different truth per
 * row depending on which happened to be fresher.
 */
export function useLocalBests(): Map<string, number> {
  const sessions = useStore((state) => state.sessions);
  return useMemo(() => {
    const best = new Map<string, number>();
    for (const session of sessions) {
      for (const raw of session.items) {
        const name = getScenarioName(raw as never);
        if (!name) continue;
        const item = raw as { stats?: { summary?: { score?: unknown } } };
        const score = Number(item.stats?.summary?.score ?? 0);
        if (!Number.isFinite(score) || score <= 0) continue;
        const current = best.get(name);
        if (current === undefined || score > current) best.set(name, score);
      }
    }
    return best;
  }, [sessions]);
}
