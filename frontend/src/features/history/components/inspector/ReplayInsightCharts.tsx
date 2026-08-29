import type { ChartConfig } from "@/shared/components/ui/chart";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/shared/components/ui/chart";
import { CHART_SERIES_COLORS, CHART_STYLE, useI18n } from "@/shared/lib";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

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

export function TtkMiniChart({
  data,
  onSeek,
}: {
  data: Array<Record<string, unknown>>;
  onSeek: ((timeSec: number) => void) | null;
}) {
  const { t } = useI18n();
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
}

export function AccuracyMiniChart({
  data,
  onSeek,
}: {
  data: Array<{ timeSec: number; accOverTime: number }>;
  onSeek: ((timeSec: number) => void) | null;
}) {
  const { t } = useI18n();
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
}
