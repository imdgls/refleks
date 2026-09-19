import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/components/ui/tooltip";
import { useBenchmarks, usePersistedState } from "@/shared/hooks";
import { cn } from "@/shared/lib";
import { computeFillColor } from "@/features/benchmarks/lib/detailFormatting";
import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildMembershipIndex,
  rankForScore,
  rankName,
  rankPosition,
  type BenchmarkMembership,
} from "../../lib/benchmarkMembership";
import { formatScore } from "../../lib/historyModels";
import {
  useScenarioNormal,
  type ScenarioNormal,
} from "../../lib/scenarioNormal";

/**
 * Where a run landed on every benchmark ladder the scenario belongs to.
 *
 * One bar per benchmark, never a chosen one: the same score is ranked
 * differently by different ladders, so a single bar would be an answer that
 * is usually wrong. A scenario in no benchmark says so rather than showing
 * nothing, since a panel that simply vanishes cannot be told apart from one
 * that failed.
 *
 * Three weights, in the order they should be read: the best score as a solid
 * fill in its rank's colour, this run as a line with a notch, the normal as
 * a hairline that can be missed without loss.
 */

const STORE_OPEN = "refleks.inspector.benchmarks.open";
const VISIBLE = 3;

export function BenchmarkProgressPanel({
  scenarioName,
  runScore,
}: {
  scenarioName: string;
  runScore: number;
}) {
  const { benchmarks, progressMap, loadAllProgress, favorites } =
    useBenchmarks();
  const [open, setOpen] = usePersistedState(STORE_OPEN, true);
  const [expanded, setExpanded] = useState(false);
  const requested = useRef(false);

  // The progress cache is most of a megabyte and only this panel and the
  // sidebar breakdown read it, so it waits until something needs it.
  useEffect(() => {
    if (!open || requested.current) return;
    if (Object.keys(progressMap).length > 0) return;
    requested.current = true;
    loadAllProgress();
  }, [open, progressMap, loadAllProgress]);

  const index = useMemo(
    () => buildMembershipIndex(benchmarks, progressMap, favorites),
    [benchmarks, progressMap, favorites],
  );
  const memberships = index.get(scenarioName) ?? [];
  const normal = useScenarioNormal(scenarioName);

  const loading = index.size === 0;
  const shown = expanded ? memberships : memberships.slice(0, VISIBLE);

  return (
    <div className="rounded-xl bg-surface-subtle">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1 text-[0.6875rem] font-medium uppercase tracking-wider text-surface-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              open ? "" : "-rotate-90",
            )}
          />
          Benchmarks
        </button>
        {open && memberships.length > 0 && (
          <div className="ml-auto">
            <NormalSummary
              runScore={runScore}
              normal={normal}
              best={Math.max(normal.localBest, memberships[0].apiScore)}
            />
          </div>
        )}
      </div>

      {open && (
        <div className="space-y-3 px-3 pb-3">
          {loading && (
            <p className="text-[0.6875rem] text-surface-muted-foreground">
              Loading benchmarks...
            </p>
          )}
          {!loading && memberships.length === 0 && (
            <p className="text-[0.6875rem] text-surface-muted-foreground">
              This scenario is not in any benchmark.
            </p>
          )}
          {shown.map((m) => (
            <LadderBar
              key={`${m.benchmarkId}-${m.benchmarkName}`}
              membership={m}
              runScore={runScore}
              normal={normal.normal}
              localBest={normal.localBest}
            />
          ))}
          {memberships.length > VISIBLE && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-[0.6875rem] text-surface-muted-foreground hover:text-foreground"
            >
              {expanded
                ? "Show fewer"
                : `Show ${memberships.length - VISIBLE} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The one figure worth reading at a glance: how this run compared with normal.
 * Everything behind it - what normal means, what it was taken over, how close
 * the run came to the record - waits for a hover.
 */
function NormalSummary({
  runScore,
  normal,
  best,
}: {
  runScore: number;
  normal: ScenarioNormal;
  best: number;
}) {
  if (normal.normal === null) {
    return (
      <span className="text-[0.6875rem] text-surface-muted-foreground">
        {normal.runs > 0 ? `${normal.runs} runs on record` : "no history"}
      </span>
    );
  }

  const delta = ((runScore - normal.normal) / normal.normal) * 100;
  const ofBest = best > 0 ? (runScore / best) * 100 : null;
  const sign = delta >= 0 ? "+" : "";

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex cursor-default items-baseline gap-2">
            <span
              className={cn(
                "text-[0.6875rem] font-medium tabular-nums",
                delta >= 0 ? "text-success" : "text-warning",
              )}
            >
              {sign}
              {delta.toFixed(1)}% vs normal
            </span>
            <span className="text-[0.6875rem] tabular-nums text-surface-muted-foreground">
              {formatScore(normal.normal)}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-[17rem]">
          <div className="space-y-1 text-[0.6875rem] leading-relaxed">
            <div>
              Normal:{" "}
              <span className="tabular-nums">{formatScore(normal.normal)}</span>{" "}
              <span className="text-popover-foreground/70">
                (median of {normal.runs} run{normal.runs === 1 ? "" : "s"}
                {normal.spanDays > 0 ? ` over ${normal.spanDays} days` : ""})
              </span>
            </div>
            <div>
              This run:{" "}
              <span className="tabular-nums">{formatScore(runScore)}</span>
              {ofBest !== null && (
                <span className="text-popover-foreground/70">
                  {" "}
                  — {ofBest.toFixed(0)}% of your best {formatScore(best)}
                </span>
              )}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * One benchmark's ladder.
 *
 * The axis gives every rank an equal share rather than spacing them by score,
 * because the thresholds are spaced unevenly and a score-linear axis would
 * make some ranks wide and others a sliver.
 */
function LadderBar({
  membership,
  runScore,
  normal,
  localBest,
}: {
  membership: BenchmarkMembership;
  runScore: number;
  normal: number | null;
  localBest: number;
}) {
  // A personal best set moments ago can lead the server by a refresh, so the
  // higher of the two fills the bar and the rank is recomputed from the
  // thresholds rather than taken from the server, which would disagree.
  const best = Math.max(membership.apiScore, localBest);
  const bestRank = rankForScore(best, membership.thresholds);
  const fillColor = computeFillColor(bestRank, membership.ranks);
  const earned = rankName(best, membership);

  const bands = membership.thresholds.length - 1;
  const pct = (value: number) =>
    `${(rankPosition(value, membership.thresholds) * 100).toFixed(2)}%`;

  const runAtCeiling =
    runScore >= membership.thresholds[membership.thresholds.length - 1];

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 pb-1">
        <span className="min-w-0 truncate text-[0.6875rem] text-foreground">
          {membership.benchmarkName}
          <span className="text-surface-muted-foreground">
            {" · "}
            {membership.difficultyName}
          </span>
        </span>
        <span
          className="shrink-0 text-[0.6875rem] font-medium"
          style={earned ? { color: fillColor } : undefined}
        >
          {earned ?? "unranked"}
        </span>
      </div>

      <div className="relative h-4">
        <div className="absolute inset-x-0 top-1 h-2.5 overflow-hidden rounded-full bg-surface-panel">
          <div
            className="absolute inset-y-0 left-0"
            style={{ width: pct(best), background: fillColor }}
          />
          {/* The ladder's own steps, faint, so the bar reads as ranks. */}
          {Array.from({ length: Math.max(0, bands - 1) }, (_, i) => (
            <div
              key={i}
              className="absolute inset-y-0 w-px bg-canvas/50"
              style={{ left: `${((i + 1) / bands) * 100}%` }}
            />
          ))}
          {normal !== null && (
            <div
              className="absolute inset-y-0 w-px bg-foreground/40"
              style={{ left: pct(normal) }}
              aria-hidden
            />
          )}
        </div>

        {/* This run: drawn over the fill, so it carries its own outline to
            stay legible against any rank colour. */}
        <div
          className="absolute top-0 h-4 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={{
            left: pct(runScore),
            boxShadow: "0 0 0 1px var(--canvas)",
          }}
          aria-hidden
        />
        <div
          className="absolute top-[0.875rem] size-0 -translate-x-1/2 border-x-[3px] border-b-[4px] border-x-transparent"
          style={{
            left: pct(runScore),
            borderBottomColor: "var(--foreground)",
          }}
          aria-hidden
        />
        {runAtCeiling && (
          <span className="absolute -top-0.5 right-0 text-[0.5rem] text-foreground">
            ▸
          </span>
        )}
      </div>
    </div>
  );
}
