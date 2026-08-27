import { useStore } from "@/shared/hooks";
import { getRunStatsEvents, getRunTrace } from "@/shared/lib/api";
import type { MousePoint, RunRecord, RunStatsEvent } from "@/shared/types/ipc";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { decodeTrace } from "../../lib/decodeTrace";
import { computeMouseTraceAnalysis } from "../../lib/mouseAnalysis";
import { fetchReplaySync, videoTimeToTraceEpochMs } from "../../lib/replaySync";
import type { ReplaySync } from "../../lib/replaySync";
import {
  classificationIsMeaningful,
  KillColourMap,
  NEUTRAL_TRAIL_COLOR,
} from "../../lib/trailClassification";
import {
  buildFutureSegments,
  buildPastSegments,
  drawSegments,
  FUTURE_WINDOW_MS,
  TraceLookup,
} from "../../lib/trailGeometry";
import type { TrailMode } from "../../lib/trailGeometry";
import { screenModelFromSummary } from "../../lib/trailProjection";
import type { ScreenModel } from "../../lib/trailProjection";

/**
 * Draws the crosshair trail on top of a replay, coloured by the app's own
 * kill classification.
 *
 * Everything needed is derived from the run's file path, so this hangs off
 * the existing player without threading state through it: the run comes
 * from the store, its trace and kill events from the same lazy loaders the
 * trace tab uses, and the video/trace alignment from the sidecar written
 * when the replay was trimmed.
 *
 * The overlay draws nothing at all - rather than something approximate -
 * whenever it cannot place the trail honestly: no sidecar (a replay from
 * before the fork recorded one), no trace, no usable sensitivity, or a
 * moment of video that falls outside the recorded mouse data. That last
 * case is normal at the start of every replay, which opens with up to one
 * capture segment of pre-roll from before the run began.
 */

const TRAIL_LINE_WIDTH = 2;
const FUTURE_ALPHA = 0.33;

/**
 * Matches the mode the standalone renderer settled on: the path the aim is
 * about to take reads far better on a flick than the path it already took.
 * Slow motion and a control for this arrive in later steps.
 */
const TRAIL_MODE: TrailMode = "future";

/**
 * One frame at the default capture rate. A flick's span ends at the kill's
 * exact millisecond while video frames land on their own grid, so the frame
 * showing the kill can sit just past that end and would otherwise lose its
 * colour at the moment it matters most. Erring generous only ever extends a
 * flick's colour by about a frame.
 */
const FLICK_END_TOLERANCE_MS = 1000 / 30;

function findRunByFilePath(
  sessions: { items: RunRecord[] }[],
  filePath: string,
): RunRecord | null {
  for (const session of sessions) {
    for (const item of session.items) {
      if (item.filePath === filePath) return item;
    }
  }
  return null;
}

export function ReplayTrailOverlay({
  videoRef,
  filePath,
  replayUrl,
  manualOffsetMs = 0,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  filePath: string;
  replayUrl: string;
  manualOffsetMs?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessions = useStore((state) => state.sessions);
  const run = useMemo(
    () => findRunByFilePath(sessions, filePath),
    [sessions, filePath],
  );

  const [points, setPoints] = useState<MousePoint[] | null>(null);
  const [events, setEvents] = useState<RunStatsEvent[] | null>(null);
  const [sync, setSync] = useState<ReplaySync | null>(null);

  // Trace and kill events use the same lazy fetches as the trace tab, so a
  // run already inspected there is served from the backend's cache.
  useEffect(() => {
    let cancelled = false;
    setPoints(null);
    setEvents(null);
    if (!filePath) return;

    getRunTrace(filePath)
      .then((encoded) => {
        if (cancelled) return;
        setPoints(encoded ? decodeTrace(encoded) : []);
      })
      .catch(() => {
        if (!cancelled) setPoints([]);
      });

    getRunStatsEvents(filePath)
      .then((loaded) => {
        if (!cancelled) setEvents(loaded ?? []);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  useEffect(() => {
    let cancelled = false;
    setSync(null);
    if (!replayUrl) return;

    fetchReplaySync(replayUrl).then((result) => {
      if (!cancelled) setSync(result);
    });

    return () => {
      cancelled = true;
    };
  }, [replayUrl]);

  const trace = useMemo(
    () => (points && points.length > 1 ? new TraceLookup(points) : null),
    [points],
  );

  // The classification is the app's own, not a second implementation of it,
  // so a colour here means exactly what the same label means in the trace tab.
  const analysis = useMemo(() => {
    if (!run?.stats?.summary || !points || !events) return null;
    return computeMouseTraceAnalysis(
      run.stats.summary,
      events,
      points,
      run.performances?.header,
    );
  }, [run, points, events]);

  // Colouring is switched off deliberately where overshoot/undershoot would
  // be meaningless - a tracking scenario that logs no kills, or a
  // sustained-fire weapon whose "kill" is not a trigger pull - rather than
  // being left to fall through as a silently colourless trail.
  const colourMap = useMemo(() => {
    if (!events) return null;
    if (!classificationIsMeaningful(analysis, events).ok) return null;
    return new KillColourMap(analysis, FLICK_END_TOLERANCE_MS);
  }, [analysis, events]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || !trace || !sync) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    let lastTime = Number.NaN;
    let lastWidth = 0;
    let lastHeight = 0;
    let model: ScreenModel | null = null;

    const draw = () => {
      frame = requestAnimationFrame(draw);

      const width = video.clientWidth;
      const height = video.clientHeight;
      if (width <= 0 || height <= 0) return;

      const resized = width !== lastWidth || height !== lastHeight;
      if (resized) {
        // The projection is built at the size the replay is actually drawn
        // at, not the source resolution: horizontal FOV spans the full
        // width either way, so a scaled image needs no separate correction.
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        model = screenModelFromSummary(run?.stats?.summary, width, height);
        lastWidth = width;
        lastHeight = height;
      }

      const time = video.currentTime;
      if (!resized && time === lastTime) return;
      lastTime = time;

      ctx.clearRect(0, 0, width, height);
      if (!model) return;

      const traceMs = videoTimeToTraceEpochMs(sync, time, manualOffsetMs);
      if (!trace.inRange(traceMs)) return;

      // The whole trail takes one colour: the flick its head is in. A trail
      // spanning a boundary is coloured by the flick currently being flown,
      // not split part-way along its length.
      const colour = colourMap?.colourAt(traceMs) ?? NEUTRAL_TRAIL_COLOR;

      // End the "about to happen" trail at the flick in progress rather than
      // letting a fixed window run on into the next one. Where there are no
      // flicks to speak of - a tracking scenario, a beam weapon - there is
      // nothing to clip against and the plain window is the honest answer.
      const flickEnd = colourMap?.nextKillEndMs(traceMs) ?? undefined;

      if (TRAIL_MODE === "past" || TRAIL_MODE === "past+future") {
        if (TRAIL_MODE === "past+future") {
          drawSegments(
            ctx,
            buildFutureSegments(
              trace,
              traceMs,
              model,
              FUTURE_WINDOW_MS,
              flickEnd,
            ),
            colour,
            TRAIL_LINE_WIDTH,
            FUTURE_ALPHA,
          );
        }
        drawSegments(
          ctx,
          buildPastSegments(trace, traceMs, model),
          colour,
          TRAIL_LINE_WIDTH,
        );
      } else {
        drawSegments(
          ctx,
          buildFutureSegments(trace, traceMs, model, FUTURE_WINDOW_MS, flickEnd),
          colour,
          TRAIL_LINE_WIDTH,
        );
      }
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [trace, sync, run, videoRef, manualOffsetMs, colourMap]);

  if (!trace || !sync) return null;

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden
    />
  );
}
