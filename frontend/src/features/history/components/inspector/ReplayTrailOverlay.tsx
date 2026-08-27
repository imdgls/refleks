import { useStore } from "@/shared/hooks";
import { getRunTrace } from "@/shared/lib/api";
import type { MousePoint, RunRecord } from "@/shared/types/ipc";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { decodeTrace } from "../../lib/decodeTrace";
import { fetchReplaySync, videoTimeToTraceEpochMs } from "../../lib/replaySync";
import type { ReplaySync } from "../../lib/replaySync";
import {
  buildFutureSegments,
  buildPastSegments,
  drawSegments,
  TraceLookup,
} from "../../lib/trailGeometry";
import type { TrailMode } from "../../lib/trailGeometry";
import { screenModelFromSummary } from "../../lib/trailProjection";
import type { ScreenModel } from "../../lib/trailProjection";

/**
 * Draws the crosshair trail on top of a replay.
 *
 * Everything needed is derived from the run's file path, so this hangs off
 * the existing player without threading state through it: the run comes
 * from the store, its trace from the same lazy loader the trace tab uses,
 * and the video/trace alignment from the sidecar written when the replay
 * was trimmed.
 *
 * The overlay draws nothing at all - rather than something approximate -
 * whenever it cannot place the trail honestly: no sidecar (a replay from
 * before the fork recorded one), no trace, no usable sensitivity, or a
 * moment of video that falls outside the recorded mouse data. That last
 * case is normal at the start of every replay, which opens with up to one
 * capture segment of pre-roll from before the run began.
 */

const TRAIL_COLOR = "#ffffff";
const TRAIL_LINE_WIDTH = 2;
const FUTURE_ALPHA = 0.33;

/**
 * Matches the mode the standalone renderer settled on: the path the aim is
 * about to take reads far better on a flick than the path it already took.
 * Colours, slow motion, and a control for this arrive in later steps.
 */
const TRAIL_MODE: TrailMode = "future";

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
  const [sync, setSync] = useState<ReplaySync | null>(null);

  // Load the trace for this run. Same lazy fetch the trace tab uses, so a
  // run that has already been inspected is served from the backend's cache.
  useEffect(() => {
    let cancelled = false;
    setPoints(null);
    if (!filePath) return;

    getRunTrace(filePath)
      .then((encoded) => {
        if (cancelled) return;
        setPoints(encoded ? decodeTrace(encoded) : []);
      })
      .catch(() => {
        if (!cancelled) setPoints([]);
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

      if (TRAIL_MODE === "past" || TRAIL_MODE === "past+future") {
        if (TRAIL_MODE === "past+future") {
          drawSegments(
            ctx,
            buildFutureSegments(trace, traceMs, model),
            TRAIL_COLOR,
            TRAIL_LINE_WIDTH,
            FUTURE_ALPHA,
          );
        }
        drawSegments(
          ctx,
          buildPastSegments(trace, traceMs, model),
          TRAIL_COLOR,
          TRAIL_LINE_WIDTH,
        );
      } else {
        drawSegments(
          ctx,
          buildFutureSegments(trace, traceMs, model),
          TRAIL_COLOR,
          TRAIL_LINE_WIDTH,
        );
      }
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [trace, sync, run, videoRef, manualOffsetMs]);

  if (!trace || !sync) return null;

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-hidden
    />
  );
}
