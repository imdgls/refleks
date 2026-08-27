import type { RunStatsEvent } from "@/shared/types/ipc";
import type {
  KillAnalysis,
  KillClassification,
  MouseTraceAnalysis,
} from "./mouseAnalysis";

/**
 * Colours the trail by the app's own kill classification, so a line on the
 * replay means exactly what the same label means in the trace tab.
 *
 * The analysis itself is not reimplemented here - computeMouseTraceAnalysis
 * does that work. This only decides which colour a moment of the replay
 * takes, and whether colouring says anything at all for the scenario.
 */

/**
 * The trace tab's CLASSIFICATION_STYLES highlight colours, at full opacity.
 * Those are declared locally in TraceTab.tsx rather than exported; mirroring
 * the values keeps this change out of that file. They are Tailwind's
 * red-400, amber-400, emerald-400 and slate-400.
 *
 * The trace tab draws them as a translucent band behind a plotted path; a
 * line drawn over game footage has to hold its own against whatever is
 * behind it, so the alpha is dropped here.
 */
export const CLASSIFICATION_COLORS: Record<KillClassification, string> = {
  overshoot: "#ef4444",
  undershoot: "#f59e0b",
  optimal: "#10b981",
  unknown: "#94a3b8",
};

/** The neutral colour for any moment that is not part of an analysed flick. */
export const NEUTRAL_TRAIL_COLOR = "#ffffff";

/**
 * Below this many analysable kills the counts say nothing about the run.
 * Matches the standalone renderer's threshold.
 */
const MIN_KILLS = 5;

/**
 * A click-to-kill scenario needs about one shot per kill. Well above that
 * means a sustained-fire weapon, where the logged "kill" is the moment a
 * target's health ran out rather than a trigger pull. Observed medians:
 * static 1, dynamic clicking 1, DotTS Speed (beam) 32 - so this separates
 * cleanly rather than being a borderline judgement.
 */
const MAX_SHOTS_PER_KILL = 5;

/** Why colouring is switched off. Mapped to display text by the caller. */
export type ClassificationOffReason =
  | "no-kill-events"
  | "not-analysable"
  | "too-few-kills"
  | "sustained-fire";

export type ClassificationVerdict =
  | { ok: true }
  | { ok: false; reason: ClassificationOffReason };

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Whether overshoot/undershoot labelling means anything for this run.
 *
 * The classifier is built around discrete flicks: move to a target, stop,
 * shoot. Tracking scenarios are scored on time-on-target and log no kills
 * at all, so it does not invent flicks there - it simply produces nothing.
 * Rather than let that fall through as a silently colourless overlay, the
 * decision is made explicit so the caller can say so and turn colouring off
 * deliberately.
 */
export function classificationIsMeaningful(
  analysis: MouseTraceAnalysis | null,
  events: RunStatsEvent[],
): ClassificationVerdict {
  if (events.length === 0) return { ok: false, reason: "no-kill-events" };
  if (!analysis) return { ok: false, reason: "not-analysable" };
  if (analysis.analyzedKillCount < MIN_KILLS) {
    return { ok: false, reason: "too-few-kills" };
  }

  const shots = events
    .map((event) => event.shots)
    .filter((value) => Number.isFinite(value));
  if (median(shots) >= MAX_SHOTS_PER_KILL) {
    return { ok: false, reason: "sustained-fire" };
  }
  return { ok: true };
}

/**
 * The start of the flick span a kill highlights. Mirrors getFlickStartTs in
 * TraceTab.tsx, which is likewise local to that file.
 */
export function flickStartTs(kill: KillAnalysis): number {
  return Math.max(kill.startMs, kill.movementOnsetMs - 40);
}

type FlickSpan = {
  start: number;
  end: number;
  classification: KillClassification;
};

/**
 * Maps a trace timestamp to the colour of the flick it belongs to.
 *
 * A flick spans [flickStartTs(kill), kill.endMs] - the same span the trace
 * tab highlights when a kill is selected - so a moment only takes a
 * classification colour while it is part of an analysed flick. Anything
 * between flicks stays neutral rather than borrowing a nearby verdict.
 */
export class KillColourMap {
  private readonly spans: FlickSpan[];
  private readonly starts: number[];
  private readonly ends: number[];
  private readonly toleranceMs: number;

  /**
   * toleranceMs extends each span's end by one video frame. A flick ends at
   * the kill's exact millisecond, but video frames land on their own grid,
   * so the frame showing the kill can sit a few ms past that end and would
   * otherwise read as "between flicks" at the very moment the
   * classification matters most.
   */
  constructor(analysis: MouseTraceAnalysis | null, toleranceMs = 0) {
    this.toleranceMs = Math.max(0, toleranceMs);
    this.spans = (analysis?.kills ?? [])
      .map((kill) => ({
        start: flickStartTs(kill),
        end: kill.endMs,
        classification: kill.classification,
      }))
      .sort((a, b) => a.start - b.start);
    this.starts = this.spans.map((span) => span.start);
    this.ends = this.spans.map((span) => span.end).sort((a, b) => a - b);
  }

  get isEmpty(): boolean {
    return this.spans.length === 0;
  }

  /** The flick covering ts, or null when the moment falls between flicks. */
  classificationAt(ts: number): KillClassification | null {
    // Last span whose start is at or before ts.
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.starts[mid] <= ts) lo = mid + 1;
      else hi = mid;
    }

    for (let i = lo - 1; i >= 0; i--) {
      const span = this.spans[i];
      if (ts >= span.start && ts <= span.end + this.toleranceMs) {
        return span.classification;
      }
      // Spans are short; stop once an earlier one cannot reach ts.
      if (span.start < ts - 5000) break;
    }
    return null;
  }

  colourAt(ts: number, fallback = NEUTRAL_TRAIL_COLOR): string {
    const classification = this.classificationAt(ts);
    return classification ? CLASSIFICATION_COLORS[classification] : fallback;
  }

  /**
   * When the flick in progress at ts ends, i.e. the next kill at or after
   * it. Null once the last kill has passed.
   *
   * This is what bounds the "about to happen" trail. A fixed window keeps
   * running past the target and into the beginning of the next flick, which
   * draws as the line sailing past the target the player is actually about
   * to hit - real mouse movement, but movement belonging to the next kill.
   * On a 480 ms kill cadence a 300 ms window reached 1.5x to 2.3x beyond
   * the target; ending it at the kill lands the line on it exactly.
   */
  nextKillEndMs(ts: number): number | null {
    let lo = 0;
    let hi = this.ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ends[mid] < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.ends.length ? this.ends[lo] : null;
  }
}
