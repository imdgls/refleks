import { getRunPerformanceEvents, getRunStatsEvents, getRunTrace } from "@/shared/lib/api";
import type {
  MousePoint,
  RunPerformanceEvent,
  RunRecord,
  RunStatsEvent,
} from "@/shared/types/ipc";
import { useEffect, useMemo, useState } from "react";
import { buildAnalysisChartData } from "./analysisChart";
import { decodeTrace } from "./decodeTrace";
import { computeMouseTraceAnalysis } from "./mouseAnalysis";
import type { KillClassification } from "./mouseAnalysis";
import { fetchReplaySync } from "./replaySync";
import type { ReplaySync } from "./replaySync";
import { computeScenarioAnalysis } from "./scenarioAnalysis";
import type { AnalysisSummary } from "./scenarioAnalysis";

/**
 * Everything the panels under a replay need, expressed in the one unit they
 * all have to agree on: seconds into the video.
 *
 * Two different clocks meet here. The kill analysis works in absolute epoch
 * milliseconds, which the sidecar converts to video time directly. The
 * charts work in seconds elapsed from the challenge start, which needs an
 * anchor before it means anything on the video's timeline.
 *
 * The anchor comes from the performances header where it exists, and is
 * checked against a kill whose absolute time is known independently. When
 * the two disagree, or the header is missing, the anchor is derived from
 * the kills instead. A run that can supply neither gets no clickable charts
 * rather than charts that seek to the wrong place.
 */

export type FlickMarker = {
  killIdx: number;
  classification: KillClassification;
  /**
   * Seconds elapsed into the run, the same axis the charts use.
   *
   * Deliberately not video time. Placing flicks on the run puts all three
   * panels on one axis so they line up with each other, and it means the
   * strip needs no replay - it can be shown while the clip is still being
   * cut, with only seeking held back until there is something to seek.
   */
  runSeconds: number;
};

export type TimedPoint = { timeSec: number; videoSeconds: number };

export type ReplayInsights = {
  loading: boolean;
  /** Null until the sidecar is read; without it nothing can be placed. */
  sync: ReplaySync | null;
  summary: AnalysisSummary | null;
  flicks: FlickMarker[];
  ttk: Array<Record<string, unknown>>;
  accuracy: Array<{ timeSec: number; accOverTime: number }>;
  /** Converts a chart's elapsed seconds to seconds into the video. */
  toVideoSeconds: ((timeSec: number) => number) | null;
  /** The same mapping the other way, for placing playback on a chart. */
  fromVideoSeconds: ((videoSeconds: number) => number) | null;
  runDurationSeconds: number;
};

const EMPTY: ReplayInsights = {
  loading: true,
  sync: null,
  summary: null,
  flicks: [],
  ttk: [],
  accuracy: [],
  toVideoSeconds: null,
  fromVideoSeconds: null,
  runDurationSeconds: 0,
};

/** Epoch milliseconds are only plausible as an anchor above roughly 1973. */
const EPOCH_FLOOR_MS = 100_000_000_000;
/** How far the header's anchor may sit from a kill's own time before it is distrusted. */
const ANCHOR_TOLERANCE_MS = 1500;

export function useReplayInsights(
  run: RunRecord | null,
  replayUrl: string,
): ReplayInsights {
  const filePath = run?.filePath ?? "";
  const [points, setPoints] = useState<MousePoint[] | null>(null);
  const [events, setEvents] = useState<RunStatsEvent[] | null>(null);
  const [perf, setPerf] = useState<RunPerformanceEvent[] | null>(null);
  const [sync, setSync] = useState<ReplaySync | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPoints(null);
    setEvents(null);
    setPerf(null);
    if (!filePath) return;

    getRunTrace(filePath)
      .then((raw) => !cancelled && setPoints(raw ? decodeTrace(raw) : []))
      .catch(() => !cancelled && setPoints([]));
    getRunStatsEvents(filePath)
      .then((list) => !cancelled && setEvents(list ?? []))
      .catch(() => !cancelled && setEvents([]));
    getRunPerformanceEvents(filePath)
      .then((list) => !cancelled && setPerf(list ?? []))
      .catch(() => !cancelled && setPerf([]));

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  useEffect(() => {
    let cancelled = false;
    setSync(null);
    if (!replayUrl) return;
    fetchReplaySync(replayUrl).then((r) => !cancelled && setSync(r));
    return () => {
      cancelled = true;
    };
  }, [replayUrl]);

  return useMemo(() => {
    if (!run || !points || !events || !perf) return EMPTY;
    const summaryStats = run.stats?.summary;
    if (!summaryStats) return { ...EMPTY, loading: false };

    const scenario = events.length
      ? computeScenarioAnalysis(summaryStats, events)
      : null;
    const charts = scenario
      ? buildAnalysisChartData(
          scenario,
          summaryStats,
          events,
          perf,
          run.performances?.header?.challengeProfile?.timeLimit ?? 0,
        )
      : null;
    const mouse = points.length
      ? computeMouseTraceAnalysis(
          summaryStats,
          events,
          points,
          run.performances?.header,
        )
      : null;

    const frame0 = sync?.frame0EpochMs ?? 0;

    // Placed from the chart's own timeline, so the strip needs neither a
    // replay nor a sidecar to be drawn.
    const flicks: FlickMarker[] = [];
    if (mouse && scenario) {
      for (const kill of mouse.kills) {
        const runSeconds = scenario.timeSec[kill.killIdx - 1];
        if (typeof runSeconds !== "number" || !Number.isFinite(runSeconds)) {
          continue;
        }
        flicks.push({
          killIdx: kill.killIdx,
          classification: kill.classification,
          runSeconds,
        });
      }
    }

    // Anchor for the charts' elapsed-seconds axis.
    let anchorMs: number | null = null;
    if (sync) {
      const header = run.performances?.header?.challengeStartUtc;
      const fromKills = deriveAnchorFromKills(mouse, scenario);
      if (
        typeof header === "number" &&
        header > EPOCH_FLOOR_MS &&
        (fromKills === null || Math.abs(header - fromKills) <= ANCHOR_TOLERANCE_MS)
      ) {
        anchorMs = header;
      } else if (fromKills !== null) {
        anchorMs = fromKills;
      }
    }

    const toVideoSeconds =
      anchorMs !== null
        ? (timeSec: number) => (anchorMs + timeSec * 1000 - frame0) / 1000
        : null;
    const fromVideoSeconds =
      anchorMs !== null
        ? (videoSeconds: number) =>
            (videoSeconds * 1000 + frame0 - anchorMs) / 1000
        : null;

    const accuracy = (charts?.events ?? [])
      .filter((p): p is typeof p & { accOverTime: number } =>
        typeof p.accOverTime === "number",
      )
      .map((p) => ({ timeSec: p.timeSec, accOverTime: p.accOverTime }));

    return {
      loading: false,
      sync,
      summary: scenario?.summary ?? null,
      flicks,
      ttk: charts?.ttk ?? [],
      accuracy,
      toVideoSeconds,
      fromVideoSeconds,
      runDurationSeconds: charts?.eventsDomainMax ?? 0,
    };
  }, [run, points, events, perf, sync]);
}

/**
 * Reads the anchor back out of the data: a kill's absolute time, less the
 * elapsed seconds the charts give the same kill. The median across kills
 * shrugs off any single one whose two timestamps disagree.
 */
function deriveAnchorFromKills(
  mouse: ReturnType<typeof computeMouseTraceAnalysis>,
  scenario: ReturnType<typeof computeScenarioAnalysis> | null,
): number | null {
  if (!mouse || !scenario) return null;
  const anchors: number[] = [];
  for (const kill of mouse.kills) {
    const timeSec = scenario.timeSec[kill.killIdx - 1];
    if (typeof timeSec !== "number" || !Number.isFinite(timeSec)) continue;
    anchors.push(kill.endMs - timeSec * 1000);
  }
  if (anchors.length === 0) return null;
  anchors.sort((a, b) => a - b);
  return anchors[anchors.length >> 1];
}
