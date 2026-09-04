import {
  Button,
  Checkbox,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Slider,
} from "@/shared/components";
import { usePersistedState, useStore } from "@/shared/hooks";
import { getRunStatsEvents, getRunTrace } from "@/shared/lib/api";
import { Spline } from "lucide-react";
import type { MousePoint, RunRecord, RunStatsEvent } from "@/shared/types/ipc";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { decodeTrace } from "../../lib/decodeTrace";
import { computeMouseTraceAnalysis } from "../../lib/mouseAnalysis";
import { STORE_AUTO_SELECT } from "../../lib/autoSelectReplay";
import { registerReplayPlayer } from "../../lib/replayPlayback";
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
  findShotTimes,
  FUTURE_WINDOW_MS,
  nextShotAfter,
  TraceLookup,
  TRAIL_WINDOW_MS,
} from "../../lib/trailGeometry";
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

/**
 * Which halves of the trail are drawn, and how strongly, kept per viewer
 * rather than per run: it is a way of looking at replays, not a property of
 * any one of them.
 *
 * The two behave quite differently and are worth having independently. The
 * path already taken streams out behind the crosshair and moves with the
 * aim. The path about to be taken is anchored in the world, so it appears
 * to stand still while the crosshair travels along it.
 *
 * Defaults show the past trail solid, with the upcoming path off but its
 * opacity preset to what reads well underneath it.
 */
const STORE_PAST_ON = "refleks.trail.past.enabled";
const STORE_PAST_ALPHA = "refleks.trail.past.opacity";
const STORE_FUTURE_ON = "refleks.trail.future.enabled";
const STORE_FUTURE_ALPHA = "refleks.trail.future.opacity";
const STORE_COLOURS = "refleks.trail.classificationColours";
const STORE_PAST_WINDOW = "refleks.trail.past.windowMs";
const STORE_FUTURE_WINDOW = "refleks.trail.future.windowMs";

/**
 * How much movement each half of the trail covers, in milliseconds.
 *
 * Kept apart for the two sides because they answer different questions: how
 * far back is worth seeing is a matter of taste, while how far forward is
 * bounded by the shot in front of it anyway.
 */
const WINDOW_MIN_MS = 50;
const WINDOW_MAX_MS = 1000;
const WINDOW_STEP_MS = 25;

/**
 * One frame at the default capture rate. A flick's span ends at the kill's
 * exact millisecond while video frames land on their own grid, so the frame
 * showing the kill can sit just past that end and would otherwise lose its
 * colour at the moment it matters most. Erring generous only ever extends a
 * flick's colour by about a frame.
 */
const FLICK_END_TOLERANCE_MS = 1000 / 30;

/**
 * Below this many shots there is no shooting rhythm to bound the trail
 * against, so the plain window is used instead.
 */
const MIN_SHOTS_TO_CLAMP = 5;

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
  zoom = 1,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  filePath: string;
  replayUrl: string;
  manualOffsetMs?: number;
  /**
   * Magnification of the picture about its centre. Applied to the drawing
   * rather than to the canvas element: scaling a raster would soften the
   * line, while scaling the projection keeps it drawn at full resolution.
   */
  zoom?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pastOn, setPastOn] = usePersistedState(STORE_PAST_ON, true);
  const [pastAlpha, setPastAlpha] = usePersistedState(STORE_PAST_ALPHA, 1);
  const [futureOn, setFutureOn] = usePersistedState(STORE_FUTURE_ON, false);
  const [futureAlpha, setFutureAlpha] = usePersistedState(
    STORE_FUTURE_ALPHA,
    0.33,
  );
  const [pastWindow, setPastWindow] = usePersistedState(
    STORE_PAST_WINDOW,
    TRAIL_WINDOW_MS,
  );
  const [futureWindow, setFutureWindow] = usePersistedState(
    STORE_FUTURE_WINDOW,
    FUTURE_WINDOW_MS,
  );
  const [coloursOn, setColoursOn] = usePersistedState(STORE_COLOURS, true);
  const [autoSelect, setAutoSelect] = usePersistedState(STORE_AUTO_SELECT, true);
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

  // Shots bound the upcoming trail. A run with no discrete shooting - a
  // tracking scenario, or a beam weapon held down - yields none, and the
  // plain window stands, since there is no arrival to stop at either.
  const shots = useMemo(() => {
    const found = points ? findShotTimes(points) : [];
    return found.length >= MIN_SHOTS_TO_CLAMP ? found : null;
  }, [points]);

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

    let lastMediaTime = Number.NaN;
    let lastWidth = 0;
    let lastHeight = 0;
    let model: ScreenModel | null = null;

    /**
     * time is the media timestamp of the frame being shown, not the
     * element's playback position. The two are not the same thing:
     * currentTime advances continuously with the media clock, so drawing
     * from it moves the trail on while the picture is still holding the
     * previous frame. That is invisible at full speed, where both change
     * together, and reads as stutter as soon as playback is slowed down.
     */
    const draw = (time: number) => {
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
        model = screenModelFromSummary(run?.stats?.summary, width, height);
        lastWidth = width;
        lastHeight = height;
      }

      lastMediaTime = time;

      // Clear in device pixels, before any zoom is applied, so the whole
      // canvas is wiped however far the drawing is magnified.
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Magnify about the centre of the frame, which is where the crosshair
      // sits and what the video element scales around.
      const z = zoom > 0 ? zoom : 1;
      ctx.setTransform(
        dpr * z,
        0,
        0,
        dpr * z,
        (dpr * width * (1 - z)) / 2,
        (dpr * height * (1 - z)) / 2,
      );
      if (!model) return;

      const traceMs = videoTimeToTraceEpochMs(sync, time, manualOffsetMs);
      if (!trace.inRange(traceMs)) return;

      // The whole trail takes one colour: the flick its head is in. A trail
      // spanning a boundary is coloured by the flick currently being flown,
      // not split part-way along its length.
      const colour = coloursOn
        ? (colourMap?.colourAt(traceMs) ?? NEUTRAL_TRAIL_COLOR)
        : NEUTRAL_TRAIL_COLOR;

      // End the "about to happen" trail at the next shot: the moment the
      // player judged themselves on target. Past it the window is drawing
      // the start of the next flick.
      const flickEnd = shots ? nextShotAfter(shots, traceMs) : undefined;

      // The upcoming path goes down first so the path already taken wins
      // where the two meet at the crosshair.
      if (futureOn && futureAlpha > 0) {
        drawSegments(
          ctx,
          buildFutureSegments(trace, traceMs, model, futureWindow, flickEnd),
          colour,
          TRAIL_LINE_WIDTH,
          futureAlpha,
        );
      }
      if (pastOn && pastAlpha > 0) {
        drawSegments(
          ctx,
          buildPastSegments(trace, traceMs, model, pastWindow),
          colour,
          TRAIL_LINE_WIDTH,
          pastAlpha,
        );
      }
    };

    // requestVideoFrameCallback fires once per frame the compositor actually
    // presents, and hands over that frame's own media timestamp. Where it is
    // missing, an animation frame loop reading currentTime is the best
    // available approximation - the behaviour this replaced.
    let vfcHandle = 0;
    let rafHandle = 0;
    if (typeof video.requestVideoFrameCallback === "function") {
      const onPresented: VideoFrameRequestCallback = (_now, metadata) => {
        draw(metadata.mediaTime);
        vfcHandle = video.requestVideoFrameCallback(onPresented);
      };
      vfcHandle = video.requestVideoFrameCallback(onPresented);
    } else {
      const tick = () => {
        rafHandle = requestAnimationFrame(tick);
        const time = video.currentTime;
        if (time !== lastMediaTime) draw(time);
      };
      rafHandle = requestAnimationFrame(tick);
    }

    // Paint at once so a paused replay is not blank until the next frame is
    // presented, and repaint on a resize, which presents no new frame at all.
    draw(video.currentTime);
    const observer = new ResizeObserver(() => {
      draw(Number.isFinite(lastMediaTime) ? lastMediaTime : video.currentTime);
    });
    observer.observe(video);

    return () => {
      if (vfcHandle) video.cancelVideoFrameCallback?.(vfcHandle);
      if (rafHandle) cancelAnimationFrame(rafHandle);
      observer.disconnect();
    };
  }, [
    trace,
    sync,
    run,
    videoRef,
    manualOffsetMs,
    colourMap,
    shots,
    pastOn,
    pastAlpha,
    futureOn,
    futureAlpha,
    pastWindow,
    futureWindow,
    coloursOn,
    zoom,
  ]);

  // Share the element with the panels drawn under the replay. Registered
  // whatever the trail can do, since they need the player even for a run
  // this overlay cannot draw on.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !filePath) return;
    return registerReplayPlayer(filePath, video);
  }, [videoRef, filePath]);

  if (!trace || !sync) return null;

  return (
    <>
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden
      />
      <div className="absolute right-2 top-2 z-20">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              title="Trail"
              className="h-7 w-7 bg-black/50 text-white/80 hover:bg-black/70 hover:text-white"
            >
              <Spline className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 space-y-3 p-3">
            <TrailToggle
              label="Past trail"
              hint="Streams out behind the crosshair"
              enabled={pastOn}
              onEnabled={setPastOn}
              opacity={pastAlpha}
              onOpacity={setPastAlpha}
              windowMs={pastWindow}
              onWindowMs={setPastWindow}
            />
            <TrailToggle
              label="Upcoming path"
              hint="Anchored where the aim is heading"
              enabled={futureOn}
              onEnabled={setFutureOn}
              opacity={futureAlpha}
              onOpacity={setFutureAlpha}
              windowMs={futureWindow}
              onWindowMs={setFutureWindow}
            />
            <label className="flex items-center gap-2 border-t border-surface-border pt-3 text-sm">
              <Checkbox
                checked={coloursOn}
                onCheckedChange={(v) => setColoursOn(v === true)}
              />
              <span>Classification colours</span>
            </label>
            <div className="space-y-1 border-t border-surface-border pt-3">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={autoSelect}
                  onCheckedChange={(v) => setAutoSelect(v === true)}
                />
                <span>Open new replays</span>
              </label>
              <p className="pl-6 text-[0.6875rem] leading-tight text-surface-muted-foreground">
                Selects a run once its replay is ready, but only while this
                window is in the background.
              </p>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </>
  );
}

function TrailToggle({
  label,
  hint,
  enabled,
  onEnabled,
  opacity,
  onOpacity,
  windowMs,
  onWindowMs,
}: {
  label: string;
  hint: string;
  enabled: boolean;
  onEnabled: (value: boolean) => void;
  opacity: number;
  onOpacity: (value: number) => void;
  windowMs: number;
  onWindowMs: (value: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={enabled}
          onCheckedChange={(v) => onEnabled(v === true)}
        />
        <span className="font-medium">{label}</span>
      </label>
      <p className="pl-6 text-[0.6875rem] leading-tight text-surface-muted-foreground">
        {hint}
      </p>
      <TrailSlider
        name="Length"
        value={windowMs}
        onChange={onWindowMs}
        min={WINDOW_MIN_MS}
        max={WINDOW_MAX_MS}
        step={WINDOW_STEP_MS}
        enabled={enabled}
        format={(v) => `${v} ms`}
      />
      <TrailSlider
        name="Opacity"
        value={opacity}
        onChange={onOpacity}
        min={0.05}
        max={1}
        step={0.05}
        enabled={enabled}
        format={(v) => `${Math.round(v * 100)}%`}
      />
    </div>
  );
}

function TrailSlider({
  name,
  value,
  onChange,
  min,
  max,
  step,
  enabled,
  format,
}: {
  name: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  enabled: boolean;
  format: (value: number) => string;
}) {
  return (
    <div className="flex items-center gap-2 pl-6">
      <span className="w-12 shrink-0 text-[0.6875rem] text-surface-muted-foreground">
        {name}
      </span>
      <Slider
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        min={min}
        max={max}
        step={step}
        disabled={!enabled}
        className={enabled ? undefined : "opacity-40"}
      />
      <span className="w-12 shrink-0 text-right text-[0.6875rem] tabular-nums text-surface-muted-foreground">
        {format(value)}
      </span>
    </div>
  );
}
