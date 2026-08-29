import type { MousePoint } from "@/shared/types/ipc";
import type { ScreenModel, ScreenPoint } from "./trailProjection";

/**
 * Builds the polylines that make up a crosshair trail on a replay frame.
 *
 * The newest point of a past trail is always the crosshair itself (offset
 * zero) with the trail streaming out behind it; a future trail starts at
 * the crosshair and runs outward into the movement that is about to happen.
 * Both use exactly the same projection: for a past sample it answers "where
 * on screen now is the point I was aiming at then", and run forward the
 * same formula answers "where on screen now is the point I am about to be
 * aiming at" - the shape of a flick before it happens.
 *
 * A trail is a list of polylines rather than one, because a point more than
 * 90 degrees from the current view direction cannot be projected at all.
 * Breaking the line there is honest; drawing straight across the gap would
 * invent a movement that never happened.
 */

export type TrailMode = "past" | "past+future" | "future";

export const TRAIL_WINDOW_MS = 300;
export const FUTURE_WINDOW_MS = 300;

export type TrailSegment = ScreenPoint[];

/** Indexed access to a trace, by wall-clock timestamp. */
export class TraceLookup {
  private readonly ts: Float64Array;
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  readonly t0: number;
  readonly t1: number;
  readonly length: number;

  constructor(points: MousePoint[]) {
    this.length = points.length;
    this.ts = new Float64Array(points.length);
    this.xs = new Float64Array(points.length);
    this.ys = new Float64Array(points.length);
    for (let i = 0; i < points.length; i++) {
      this.ts[i] = points[i].ts;
      this.xs[i] = points[i].x;
      this.ys[i] = points[i].y;
    }
    this.t0 = points.length ? this.ts[0] : 0;
    this.t1 = points.length ? this.ts[points.length - 1] : 0;
  }

  inRange(t: number): boolean {
    return this.length > 1 && t >= this.t0 && t <= this.t1;
  }

  /** First index with ts >= target. */
  private lowerBound(target: number): number {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ts[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Cumulative counts at an arbitrary moment, linearly interpolated between
   * the samples either side. Video frames do not land on trace samples, and
   * snapping to the nearest one would make the trail head jitter around the
   * crosshair instead of sitting on it.
   */
  interpXY(t: number): { x: number; y: number } {
    if (this.length === 0) return { x: 0, y: 0 };
    const i = this.lowerBound(t);
    if (i === 0) return { x: this.xs[0], y: this.ys[0] };
    if (i >= this.length) {
      return { x: this.xs[this.length - 1], y: this.ys[this.length - 1] };
    }
    const span = this.ts[i] - this.ts[i - 1];
    const u = span > 0 ? (t - this.ts[i - 1]) / span : 0;
    return {
      x: this.xs[i - 1] + (this.xs[i] - this.xs[i - 1]) * u,
      y: this.ys[i - 1] + (this.ys[i] - this.ys[i - 1]) * u,
    };
  }

  /** Half-open sample range covering [startMs, endMs]. */
  range(startMs: number, endMs: number): { from: number; to: number } {
    const from = this.lowerBound(startMs);
    let to = this.lowerBound(endMs);
    while (to < this.length && this.ts[to] <= endMs) to++;
    return { from, to };
  }

  xAt(i: number): number {
    return this.xs[i];
  }

  yAt(i: number): number {
    return this.ys[i];
  }
}

function pushSegment(segments: TrailSegment[], current: TrailSegment) {
  if (current.length > 1) segments.push(current);
}

/** The path the aim took over the window ending at tNow. */
export function buildPastSegments(
  trace: TraceLookup,
  tNow: number,
  model: ScreenModel,
  windowMs = TRAIL_WINDOW_MS,
): TrailSegment[] {
  const now = trace.interpXY(tNow);
  const { from, to } = trace.range(Math.max(trace.t0, tNow - windowMs), tNow);

  const segments: TrailSegment[] = [];
  let current: TrailSegment = [];
  for (let i = from; i < to; i++) {
    const pt = model.project(now.x - trace.xAt(i), now.y - trace.yAt(i));
    if (pt === null) {
      pushSegment(segments, current);
      current = [];
    } else {
      current.push(pt);
    }
  }
  // The trail tip is exactly the crosshair.
  current.push({ x: model.cx, y: model.cy });
  pushSegment(segments, current);
  return segments;
}

/**
 * Rising edges of the left mouse button: the moments shots were fired.
 *
 * This is the one boundary in the data that needs no threshold and no
 * inference. It is also the moment the player judged themselves on target,
 * which is exactly where the "about to happen" trail should stop - a window
 * that runs on past it is drawing the beginning of the next flick.
 *
 * Kill events are not usable for this. Measured against the shots on a
 * 116-kill run, a kill is logged a median 122 ms after the trigger pull and
 * anywhere from 43 to 246 ms after it, so clipping there variously cuts a
 * flick short or lets the next one leak in.
 */
export function findShotTimes(points: MousePoint[]): number[] {
  const shots: number[] = [];
  let wasDown = false;
  for (const point of points) {
    const down = ((point.buttons ?? 0) & 1) !== 0;
    if (down && !wasDown) shots.push(point.ts);
    wasDown = down;
  }
  return shots;
}

/** The first shot at or after ts, or undefined once shooting has finished. */
export function nextShotAfter(
  shots: number[],
  ts: number,
): number | undefined {
  let lo = 0;
  let hi = shots.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (shots[mid] < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo < shots.length ? shots[lo] : undefined;
}

/**
 * The path the aim is about to take over the window starting at tNow.
 *
 * clampEndMs ends the window early - at the next shot. Without it the
 * window keeps running past the target and into the start of the next
 * flick, drawing real mouse movement that belongs to the next kill as
 * though it were part of the current approach.
 */
export function buildFutureSegments(
  trace: TraceLookup,
  tNow: number,
  model: ScreenModel,
  windowMs = FUTURE_WINDOW_MS,
  clampEndMs?: number,
): TrailSegment[] {
  const now = trace.interpXY(tNow);
  const windowEnd = Math.min(
    tNow + windowMs,
    clampEndMs ?? Number.POSITIVE_INFINITY,
  );
  const { from, to } = trace.range(tNow, Math.min(trace.t1, windowEnd));

  const segments: TrailSegment[] = [];
  let current: TrailSegment = [{ x: model.cx, y: model.cy }];
  for (let i = from; i < to; i++) {
    const pt = model.project(now.x - trace.xAt(i), now.y - trace.yAt(i));
    if (pt === null) {
      pushSegment(segments, current);
      current = [];
    } else {
      current.push(pt);
    }
  }
  pushSegment(segments, current);
  return segments;
}

/**
 * Centripetal Catmull-Rom, as the exponent on the distance between knots.
 * At 0.5 the spline cannot form a cusp or a loop however unevenly the
 * samples are spaced, which matters here: the trace is sampled about every
 * 8 ms, so at flick speed consecutive points can be 45 px apart while
 * during a dwell they pile up on top of each other.
 */
const SMOOTHING_ALPHA = 0.5;
const SMOOTHING_EPSILON = 1e-6;

function knotSpacing(a: ScreenPoint, b: ScreenPoint): number {
  return Math.pow(Math.hypot(b.x - a.x, b.y - a.y), SMOOTHING_ALPHA);
}

/**
 * The two cubic control points for the span p1..p2, given its neighbours.
 *
 * The curve passes exactly through every sample: this rounds the corners
 * between measured points, it does not move them or add motion between
 * them. What it removes is the faceting that comes of joining samples 45 px
 * apart with straight lines, which is invisible at full speed and obvious
 * slowed down.
 */
function splineControls(
  p0: ScreenPoint,
  p1: ScreenPoint,
  p2: ScreenPoint,
  p3: ScreenPoint,
): [ScreenPoint, ScreenPoint] {
  const d1 = knotSpacing(p0, p1);
  const d2 = knotSpacing(p1, p2);
  const d3 = knotSpacing(p2, p3);

  let c1 = p1;
  if (d1 > SMOOTHING_EPSILON && d1 + d2 > SMOOTHING_EPSILON) {
    const n = 3 * d1 * (d1 + d2);
    const w = 2 * d1 * d1 + 3 * d1 * d2 + d2 * d2;
    c1 = {
      x: (d1 * d1 * p2.x - d2 * d2 * p0.x + w * p1.x) / n,
      y: (d1 * d1 * p2.y - d2 * d2 * p0.y + w * p1.y) / n,
    };
  }

  let c2 = p2;
  if (d3 > SMOOTHING_EPSILON && d3 + d2 > SMOOTHING_EPSILON) {
    const n = 3 * d3 * (d3 + d2);
    const w = 2 * d3 * d3 + 3 * d3 * d2 + d2 * d2;
    c2 = {
      x: (d3 * d3 * p1.x - d2 * d2 * p3.x + w * p2.x) / n,
      y: (d3 * d3 * p1.y - d2 * d2 * p3.y + w * p2.y) / n,
    };
  }

  return [c1, c2];
}

export function drawSegments(
  ctx: CanvasRenderingContext2D,
  segments: TrailSegment[],
  color: string,
  lineWidth: number,
  alpha = 1,
) {
  if (segments.length === 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const segment of segments) {
    if (segment.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(segment[0].x, segment[0].y);
    if (segment.length === 2) {
      ctx.lineTo(segment[1].x, segment[1].y);
    } else {
      for (let i = 0; i < segment.length - 1; i++) {
        const p0 = i > 0 ? segment[i - 1] : segment[i];
        const p1 = segment[i];
        const p2 = segment[i + 1];
        const p3 = i + 2 < segment.length ? segment[i + 2] : p2;
        const [c1, c2] = splineControls(p0, p1, p2, p3);
        ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p2.x, p2.y);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}
