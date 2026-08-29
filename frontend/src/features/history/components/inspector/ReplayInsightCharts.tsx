import type { ChartConfig } from "@/shared/components/ui/chart";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/shared/components/ui/chart";
import { CHART_SERIES_COLORS, CHART_STYLE, useI18n } from "@/shared/lib";
import { memo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Slimmer siblings of the analysis tab's charts, sized for the space under
 * a replay and wired to seek it.
 *
 * Deliberately not the analysis tab's own components: those are laid out for
 * a full tab and take no click handler, so reusing them would mean reshaping
 * a file this fork otherwise leaves alone. The data behind both comes from
 * the same exported builders, so the two cannot disagree about what they
 * show - only about how much room they take. Series colours, labels and line
 * weights are the app's own, so they read as the same charts.
 */

const HEIGHT = "h-[110px]";

function seekHandler(onSeek: ((timeSec: number) => void) | null) {
  if (!onSeek) return {};
  return {
    onClick: (state: { activeLabel?: string | number }) => {
      const label = Number(state?.activeLabel);
      if (Number.isFinite(label)) onSeek(label);
    },
    className: "cursor-pointer",
  };
}

function timeTick(value: number): string {
  const m = Math.floor(value / 60);
  const s = Math.floor(value % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const AXIS = {
  tickLine: false,
  axisLine: false,
  tickMargin: 6,
} as const;

/**
 * Where the playback marker belongs, or null if it does not belong here.
 *
 * A position outside the plotted range would be pinned to an edge and read
 * as though playback were parked there, which is worse than showing
 * nothing: these charts cover the run, while the replay also holds the
 * segment pre-roll ahead of it and a tail behind.
 *
 * Returned as a value rather than a component because Recharts identifies
 * its children by type, and a ReferenceLine wrapped in anything of our own
 * never reaches the axes it needs.
 */
function playheadAt(
  at: number | null | undefined,
  data: Array<Record<string, unknown>>,
): number | null {
  if (at === null || at === undefined || !Number.isFinite(at)) return null;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const row of data) {
    const t = Number(row.timeSec);
    if (!Number.isFinite(t)) continue;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  if (lo > hi) return null;
  return at >= lo && at <= hi ? at : null;
}

const PLAYHEAD = {
  stroke: "var(--foreground)",
  strokeWidth: 1,
  strokeOpacity: 0.65,
  isFront: true,
} as const;

export const TtkMiniChart = memo(function TtkMiniChart({
  data,
  onSeek,
  playhead,
}: {
  data: Array<Record<string, unknown>>;
  onSeek: ((timeSec: number) => void) | null;
  playhead: number | null;
}) {
  const { t } = useI18n();
  const marker = playheadAt(playhead, data);
  const config: ChartConfig = {
    realTTK: {
      label: t("history.analysis.chart.ttk"),
      color: CHART_SERIES_COLORS.ttk,
    },
    ma5: {
      label: t("history.analysis.chart.ma5"),
      color: CHART_SERIES_COLORS.scoreHistory,
    },
  };
  return (
    <ChartContainer config={config} className={`aspect-auto w-full ${HEIGHT}`}>
      <LineChart
        data={data}
        margin={{ top: 6, right: 8, left: 0, bottom: 0 }}
        {...seekHandler(onSeek)}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          type="number"
          dataKey="timeSec"
          minTickGap={28}
          tickFormatter={timeTick}
          {...AXIS}
        />
        <YAxis width={34} tickFormatter={(v) => `${v}s`} {...AXIS} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {marker !== null && <ReferenceLine x={marker} {...PLAYHEAD} />}
        <Line
          isAnimationActive={false}
          type="monotone"
          dataKey="realTTK"
          stroke="var(--color-realTTK)"
          strokeWidth={CHART_STYLE.lineSecondaryWidth}
          dot={false}
        />
        <Line
          isAnimationActive={false}
          type="monotone"
          dataKey="ma5"
          stroke="var(--color-ma5)"
          strokeWidth={CHART_STYLE.linePrimaryWidth}
          dot={false}
        />
      </LineChart>
    </ChartContainer>
  );
});

export const AccuracyMiniChart = memo(function AccuracyMiniChart({
  data,
  onSeek,
  playhead,
}: {
  data: Array<{ timeSec: number; accOverTime: number }>;
  onSeek: ((timeSec: number) => void) | null;
  playhead: number | null;
}) {
  const { t } = useI18n();
  const marker = playheadAt(playhead, data);
  const config: ChartConfig = {
    accOverTime: {
      label: t("history.analysis.chart.accuracy"),
      color: CHART_SERIES_COLORS.accuracy,
    },
  };
  return (
    <ChartContainer config={config} className={`aspect-auto w-full ${HEIGHT}`}>
      <LineChart
        data={data}
        margin={{ top: 6, right: 8, left: 0, bottom: 0 }}
        {...seekHandler(onSeek)}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          type="number"
          dataKey="timeSec"
          minTickGap={28}
          tickFormatter={timeTick}
          {...AXIS}
        />
        <YAxis
          width={38}
          domain={[0, 1]}
          tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
          {...AXIS}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        {marker !== null && <ReferenceLine x={marker} {...PLAYHEAD} />}
        <Line
          isAnimationActive={false}
          type="monotone"
          dataKey="accOverTime"
          stroke="var(--color-accOverTime)"
          strokeWidth={CHART_STYLE.linePrimaryWidth}
          dot={false}
        />
      </LineChart>
    </ChartContainer>
  );
});
