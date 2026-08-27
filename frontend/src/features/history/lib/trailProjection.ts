import type { RunStatsSummary } from "@/shared/types/ipc";

/**
 * Turns raw mouse-trace counts into positions on a replay frame.
 *
 * Two conversions, chained.
 *
 * 1. counts -> degrees of view rotation.
 *    A run's stats carry sensitivity as a physical, DPI-anchored number
 *    ("Sens Scale: cm/360" with "Horiz Sens: 50" meaning 50 cm of mouse
 *    movement per full turn), which is independent of engine convention:
 *
 *      counts per 360 = (cm360 / 2.54) * dpi
 *      degrees per count = 360 / countsPer360
 *
 * 2. degrees -> pixels, by perspective projection rather than one constant
 *    pixels-per-count factor. KovaaK's pins the crosshair at screen centre
 *    and rotates the world, so a point the crosshair sat on `dt` ago is the
 *    old forward axis carried through the rotation since:
 *
 *      A = yaw   = (xNow - xPast) * degreesPerCount
 *      B = pitch = (yNow - yPast) * degreesPerCount
 *      v = Rpitch(B) . Ryaw(A) . (0,0,1) = (-sinA, cosA sinB, cosA cosB)
 *
 *    projected through focal length f = (width/2) / tan(hfov/2).
 *
 * A single constant is only correct at the exact centre of the screen: in a
 * perspective camera the pixels-per-degree grows away from centre, so a
 * trail tail far from the crosshair would be drawn too close in. Near
 * centre this reduces to that same constant, which was confirmed
 * empirically (0.309 px/count measured against 0.305 predicted).
 *
 * This assumes the run's FOV is a true horizontal FOV at the recorded
 * aspect ratio ("hor+"), the Unreal Engine default that KovaaK's is built
 * on. That is an engine-specific assumption rather than a certainty -
 * RefleK's own mouseAnalysis.ts deliberately never converts trace units to
 * pixels for exactly this reason - so it is stated plainly here rather than
 * presented as exact.
 */

/** A point at or behind the camera plane cannot be projected at all. */
const MIN_Z = 1e-6;

/** Guards against absurd coordinates for points barely in front of the camera. */
const COORD_LIMIT = 20000;

const CM_PER_INCH = 2.54;

export type ScreenPoint = { x: number; y: number };

export function degreesPerCount(cm360: number, dpi: number): number {
  const countsPer360 = (cm360 / CM_PER_INCH) * dpi;
  return 360 / countsPer360;
}

export function focalLengthPx(fovDeg: number, widthPx: number): number {
  return widthPx / 2 / Math.tan((fovDeg * Math.PI) / 180 / 2);
}

export class ScreenModel {
  readonly dpc: number;
  readonly f: number;
  readonly cx: number;
  readonly cy: number;
  /** The equivalent single constant at screen centre, for reporting. */
  readonly ppcCenter: number;

  constructor(
    degreesPerCountValue: number,
    fovDeg: number,
    widthPx: number,
    heightPx: number,
  ) {
    this.dpc = degreesPerCountValue;
    this.f = focalLengthPx(fovDeg, widthPx);
    this.cx = widthPx / 2;
    this.cy = heightPx / 2;
    this.ppcCenter = this.f * ((degreesPerCountValue * Math.PI) / 180);
  }

  /**
   * countDx/countDy are (now - past) accumulated counts. Returns null when
   * the point is more than 90 degrees from the current view direction and
   * therefore not projectable.
   */
  project(countDx: number, countDy: number): ScreenPoint | null {
    const A = ((countDx * this.dpc) * Math.PI) / 180;
    const B = ((countDy * this.dpc) * Math.PI) / 180;

    const vx = -Math.sin(A);
    const vy = Math.cos(A) * Math.sin(B);
    const vz = Math.cos(A) * Math.cos(B);
    if (vz <= MIN_Z) return null;

    const x = this.cx + (this.f * vx) / vz;
    const y = this.cy - (this.f * vy) / vz;
    if (!(Math.abs(x) < COORD_LIMIT && Math.abs(y) < COORD_LIMIT)) return null;
    return { x, y };
  }
}

/**
 * Reads cm/360 out of a run's stats summary.
 *
 * "Sens Increment" is deliberately not used: it is tied to the separate
 * FOVScale setting rather than being degrees-per-count, and taking it as
 * such gives a value roughly 14x too large.
 */
export function cm360FromSummary(summary: RunStatsSummary): number | null {
  const scale = (summary.sensScale ?? "").trim();
  const horiz = summary.horizSens;

  if (Number.isFinite(horiz) && horiz > 0) {
    if (scale === "cm/360") return horiz;
    if (scale === "in/360") return horiz * CM_PER_INCH;
  }
  // Some runs carry the derived value directly; fall back to it rather than
  // refusing to draw over a sensitivity scale this does not recognise.
  if (Number.isFinite(summary.cm360) && summary.cm360 > 0) return summary.cm360;
  return null;
}

/**
 * Builds the projection for a run at the size the replay is being drawn at.
 * Returns null when the run lacks the numbers to place a trail honestly -
 * the caller draws nothing rather than a plausible-looking wrong trail.
 */
export function screenModelFromSummary(
  summary: RunStatsSummary | undefined,
  widthPx: number,
  heightPx: number,
): ScreenModel | null {
  if (!summary || widthPx <= 0 || heightPx <= 0) return null;

  const cm360 = cm360FromSummary(summary);
  const { dpi, fov } = summary;
  if (
    cm360 === null ||
    !Number.isFinite(dpi) ||
    dpi <= 0 ||
    !Number.isFinite(fov) ||
    fov <= 0 ||
    fov >= 180
  ) {
    return null;
  }

  return new ScreenModel(degreesPerCount(cm360, dpi), fov, widthPx, heightPx);
}
