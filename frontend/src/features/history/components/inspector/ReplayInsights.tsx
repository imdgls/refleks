import { usePersistedState, useStore } from "@/shared/hooks";
import { cn } from "@/shared/lib/utils";
import type { RunRecord } from "@/shared/types/ipc";
import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { KillClassification } from "../../lib/mouseAnalysis";
import { useReplayInsights } from "../../lib/replayInsights";
import type { FlickMarker } from "../../lib/replayInsights";
import { seekReplay, useReplayPlayer } from "../../lib/replayPlayback";
import { CLASSIFICATION_COLORS } from "../../lib/trailClassification";
import { AccuracyMiniChart, TtkMiniChart } from "./ReplayInsightCharts";

/**
 * The panels under a replay: where the flicks are, how the run went, and
 * two charts that double as a way into the footage.
 *
 * Everything here is derived from the run's file path. It reads the player
 * through the shared registry rather than through props, so the replay tab
 * needs only to say where these belong, not to hand them anything.
 *
 * Each section collapses, and remembers, because how much of this a viewer
 * wants open is a lasting preference rather than something to re-choose on
 * every run.
 */

const ORDER: KillClassification[] = [
  "overshoot",
  "undershoot",
  "optimal",
  "unknown",
];

const STORE_SECTION = (name: string) => `refleks.replay.section.${name}`;
const STORE_CLASS_FILTER = "refleks.replay.flicks.classes";

export function ReplayInsights({
  filePath,
  replayUrl,
}: {
  filePath: string;
  replayUrl: string;
}) {
  const sessions = useStore((state) => state.sessions);
  const run = useMemo<RunRecord | null>(() => {
    for (const session of sessions) {
      for (const item of session.items) {
        if (item.filePath === filePath) return item;
      }
    }
    return null;
  }, [sessions, filePath]);

  const insights = useReplayInsights(run, replayUrl);
  const video = useReplayPlayer(filePath);
  const position = usePlaybackPosition(video);
  const duration = useDuration(video, insights.sync);

  const seek = useMemo(() => {
    if (!video) return null;
    return (videoSeconds: number) => seekReplay(video, videoSeconds);
  }, [video]);

  const seekFromChart = useMemo(() => {
    const map = insights.toVideoSeconds;
    if (!map || !seek) return null;
    return (timeSec: number) => seek(map(timeSec));
  }, [insights.toVideoSeconds, seek]);

  // A chart is a few hundred pixels wide for a minute of play, so a step
  // finer than this cannot move the marker a whole pixel. Quantising here
  // keeps the charts from re-rendering several times for the same drawing.
  const chartPlayhead = useMemo(() => {
    const map = insights.fromVideoSeconds;
    if (!map) return null;
    return Math.round(map(position) / 0.15) * 0.15;
  }, [insights.fromVideoSeconds, position]);

  if (insights.loading) return null;

  const hasFlicks = insights.flicks.length > 0;
  const hasTtk = insights.ttk.length > 1;
  const hasAccuracy = insights.accuracy.length > 1;
  if (!hasFlicks && !hasTtk && !hasAccuracy && !insights.summary) return null;

  return (
    <div className="space-y-1.5">
      {hasFlicks && (
        <Section name="flicks" title="Flicks">
          {(headerSlot) => (
            <FlickStrip
              flicks={insights.flicks}
              duration={duration}
              position={position}
              onSeek={seek}
              headerSlot={headerSlot}
            />
          )}
        </Section>
      )}

      {insights.summary && (
        <Section name="summary" title="Summary">
          {() => <SummaryRow summary={insights.summary!} />}
        </Section>
      )}

      {(hasTtk || hasAccuracy) && (
        <Section name="charts" title="Over time">
          {() => (
            /* Side by side where the inspector is wide enough, stacked when
               it is not. Sized by the container rather than the viewport,
               since this pane is nothing like the window's width. */
            <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-3">
              {hasTtk && (
                <Labelled label="TTK">
                  <TtkMiniChart
                    data={insights.ttk}
                    onSeek={seekFromChart}
                    playhead={chartPlayhead}
                  />
                </Labelled>
              )}
              {hasAccuracy && (
                <Labelled label="Accuracy">
                  <AccuracyMiniChart
                    data={insights.accuracy}
                    onSeek={seekFromChart}
                    playhead={chartPlayhead}
                  />
                </Labelled>
              )}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

/* ─── Collapsible section ─── */

function Section({
  name,
  title,
  children,
}: {
  name: string;
  title: string;
  children: (headerSlot: (node: ReactNode) => void) => ReactNode;
}) {
  const [open, setOpen] = usePersistedState(STORE_SECTION(name), true);
  const [slot, setSlot] = useState<ReactNode>(null);
  const body = children(setSlot);

  return (
    <div className="rounded-xl bg-surface-subtle">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-center gap-1 text-[0.6875rem] font-medium uppercase tracking-wider text-surface-muted-foreground hover:text-foreground"
          aria-expanded={open}
        >
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              open ? "" : "-rotate-90",
            )}
          />
          {title}
        </button>
        {open && <div className="ml-auto flex items-center gap-1">{slot}</div>}
      </div>
      {open && <div className="px-2 pb-2">{body}</div>}
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[0.625rem] uppercase tracking-wider text-surface-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

/* ─── Flick strip ─── */

function FlickStrip({
  flicks,
  duration,
  position,
  onSeek,
  headerSlot,
}: {
  flicks: FlickMarker[];
  duration: number;
  position: number;
  onSeek: ((videoSeconds: number) => void) | null;
  headerSlot: (node: ReactNode) => void;
}) {
  const [hidden, setHidden] = usePersistedState<KillClassification[]>(
    STORE_CLASS_FILTER,
    [],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of flicks) c[f.classification] = (c[f.classification] ?? 0) + 1;
    return c;
  }, [flicks]);

  // The filters belong in the section header, which is rendered by the
  // section itself; hand them up rather than growing a second header row.
  useEffect(() => {
    headerSlot(
      <>
        {ORDER.filter((cls) => counts[cls]).map((cls) => {
          const off = hidden.includes(cls);
          return (
            <button
              key={cls}
              type="button"
              title={cls}
              onClick={() =>
                setHidden((prev) =>
                  prev.includes(cls)
                    ? prev.filter((c) => c !== cls)
                    : [...prev, cls],
                )
              }
              className={cn(
                "flex items-center gap-1 rounded px-1 py-0.5 text-[0.625rem] tabular-nums transition-opacity",
                off ? "opacity-30" : "opacity-100",
              )}
            >
              <span
                className="h-2 w-2 rounded-sm"
                style={{ background: CLASSIFICATION_COLORS[cls] }}
              />
              {counts[cls]}
            </button>
          );
        })}
      </>,
    );
    return () => headerSlot(null);
  }, [counts, hidden, headerSlot, setHidden]);

  const span = duration > 0 ? duration : 1;
  const visible = flicks.filter((f) => !hidden.includes(f.classification));

  return (
    <div
      className="relative h-6 w-full overflow-hidden rounded-md bg-surface"
      onClick={(e) => {
        if (!onSeek) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - rect.left) / rect.width) * span);
      }}
      role="presentation"
    >
      {visible.map((f) => (
        <button
          key={f.killIdx}
          type="button"
          title={`#${f.killIdx} ${f.classification}`}
          onClick={(e) => {
            e.stopPropagation();
            onSeek?.(Math.max(0, f.videoSeconds - 0.35));
          }}
          className="absolute top-1 h-4 w-1.5 -translate-x-1/2 rounded-[1px] hover:h-5 hover:top-0.5"
          style={{
            left: `${Math.min(100, Math.max(0, (f.videoSeconds / span) * 100))}%`,
            background: CLASSIFICATION_COLORS[f.classification],
          }}
        />
      ))}
      <div
        className="pointer-events-none absolute inset-y-0 w-px bg-foreground"
        style={{
          left: `${Math.min(100, Math.max(0, (position / span) * 100))}%`,
        }}
      />
    </div>
  );
}

/* ─── Summary ─── */

function SummaryRow({
  summary,
}: {
  summary: NonNullable<ReturnType<typeof useReplayInsights>["summary"]>;
}) {
  const cells: Array<[string, string]> = [
    ["Kills", String(summary.kills)],
    ["Accuracy", `${(summary.finalAcc * 100).toFixed(1)}%`],
    ["Avg TTK", `${summary.avgTTK.toFixed(2)}s`],
    ["Median TTK", `${summary.medianTTK.toFixed(2)}s`],
    ["Avg KPM", summary.meanKPM.toFixed(1)],
    ["TTK σ", `${summary.stdTTK.toFixed(2)}s`],
  ];
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      {cells.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <span className="text-[0.625rem] uppercase tracking-wider text-surface-muted-foreground">
            {label}
          </span>
          <span className="text-sm font-medium tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  );
}

/* ─── Playback position ─── */

/**
 * Follows the player without a subscription in the shared registry: the
 * element is right here, and reading it costs nothing. Updates are held to
 * roughly 20 a second, which is finer than the strip can show and far less
 * than a render per animation frame.
 */
function usePlaybackPosition(video: HTMLVideoElement | null): number {
  const [position, setPosition] = useState(0);
  const last = useRef(0);

  useEffect(() => {
    if (!video) return;
    let handle = 0;
    const tick = () => {
      handle = requestAnimationFrame(tick);
      const t = video.currentTime;
      if (Math.abs(t - last.current) >= 0.05) {
        last.current = t;
        setPosition(t);
      }
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [video]);

  return position;
}

function useDuration(
  video: HTMLVideoElement | null,
  sync: ReturnType<typeof useReplayInsights>["sync"],
): number {
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (!video) return;
    const read = () => {
      if (Number.isFinite(video.duration)) setDuration(video.duration);
    };
    read();
    video.addEventListener("durationchange", read);
    return () => video.removeEventListener("durationchange", read);
  }, [video]);

  if (duration > 0) return duration;
  // Before the element reports one, the sidecar's own window is the same span.
  if (sync) return (sync.replayEndEpochMs - sync.frame0EpochMs) / 1000;
  return 0;
}
