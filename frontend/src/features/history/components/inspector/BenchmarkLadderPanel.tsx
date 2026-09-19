import { computeFillColor } from "@/features/benchmarks/lib/detailFormatting";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/components/ui/tooltip";
import { useBenchmarks, usePersistedState } from "@/shared/hooks";
import { cn } from "@/shared/lib";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  buildBenchmarkLists,
  findInList,
  rankForScore,
  rankName,
  rankPosition,
  type BenchmarkList,
  type LadderScenario,
} from "../../lib/benchmarkMembership";
import { formatScore } from "../../lib/historyModels";
import {
  useLocalBests,
  useScenarioNormal,
  type ScenarioNormal,
} from "../../lib/scenarioNormal";

/**
 * The benchmark a run belongs to, shown whole, with the run's own scenario
 * marked inside it.
 *
 * The point is placement rather than a single figure: seeing the scenario in
 * its category and subcategory says where this result sits in the whole
 * ladder, which a lone bar cannot.
 *
 * One benchmark is listed at a time, because a scenario can belong to seven
 * of them and stacking those is 152 rows under a video. Nothing is chosen on
 * the player's behalf, though: every benchmark gets a tab, and each tab
 * carries the rank the scenario holds there, so the spread - Celadon in one
 * ladder, unranked in the next - is readable without switching.
 *
 * Only the played scenario's row carries the run and the normal. For every
 * other row those two do not exist, and inventing them would be inventing
 * data. That is also what makes the marked row legible at a glance.
 *
 * Every row takes the higher of the local best and the one the server
 * recorded, so a list does not mix two definitions of "best" depending on
 * which happened to be fresher.
 */

const STORE_OPEN = "refleks.replay.ladder.open";
const STORE_PICK = "refleks.replay.ladder.benchmark";

export function BenchmarkLadderPanel({
  scenarioName,
  runScore,
}: {
  scenarioName: string;
  runScore: number;
}) {
  const { benchmarks, progressMap, loadAllProgress, favorites } =
    useBenchmarks();
  const [open, setOpen] = usePersistedState(STORE_OPEN, true);
  const [pick, setPick] = usePersistedState<string>(STORE_PICK, "");
  const requested = useRef(false);

  useEffect(() => {
    if (!open || requested.current) return;
    if (Object.keys(progressMap).length > 0) return;
    requested.current = true;
    loadAllProgress();
  }, [open, progressMap, loadAllProgress]);

  const { byScenario } = useMemo(
    () => buildBenchmarkLists(benchmarks, progressMap, favorites),
    [benchmarks, progressMap, favorites],
  );
  const lists = byScenario.get(scenarioName) ?? [];
  const normal = useScenarioNormal(scenarioName);
  const localBests = useLocalBests();

  // The remembered benchmark only applies where it actually holds the
  // scenario; otherwise the ordering decides.
  const selected = lists.find((l) => l.key === pick) ?? lists[0] ?? null;
  const loading =
    benchmarks.length === 0 || Object.keys(progressMap).length === 0;

  return (
    <div className="rounded-xl bg-surface-subtle">
      <div className="flex items-center gap-1.5 px-2 py-1">
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
        {open && lists.length > 0 && (
          <div className="ml-auto">
            <NormalSummary
              runScore={runScore}
              normal={normal}
              best={Math.max(
                normal.localBest,
                bestInList(selected, scenarioName),
              )}
            />
          </div>
        )}
      </div>

      {open && (
        <div className="px-2 pb-2">
          {loading && (
            <p className="text-[0.6875rem] text-surface-muted-foreground">
              Loading benchmarks...
            </p>
          )}
          {!loading && lists.length === 0 && (
            <p className="text-[0.6875rem] text-surface-muted-foreground">
              {scenarioName} is not in any benchmark.
            </p>
          )}
          {selected && (
            <>
              <div className="flex flex-wrap gap-1 pb-2">
                {lists.map((list) => (
                  <BenchmarkTab
                    key={list.key}
                    list={list}
                    scenarioName={scenarioName}
                    localBests={localBests}
                    active={list.key === selected.key}
                    onPick={() => setPick(list.key)}
                  />
                ))}
              </div>
              <LadderList
                list={selected}
                scenarioName={scenarioName}
                runScore={runScore}
                normal={normal.normal}
                localBests={localBests}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function bestInList(list: BenchmarkList | null, scenarioName: string): number {
  if (!list) return 0;
  return findInList(list, scenarioName)?.apiScore ?? 0;
}

function bestFor(
  scenario: LadderScenario,
  localBests: Map<string, number>,
): number {
  return Math.max(scenario.apiScore, localBests.get(scenario.name) ?? 0);
}

/** One benchmark's tab, carrying the rank the scenario holds inside it. */
function BenchmarkTab({
  list,
  scenarioName,
  localBests,
  active,
  onPick,
}: {
  list: BenchmarkList;
  scenarioName: string;
  localBests: Map<string, number>;
  active: boolean;
  onPick: () => void;
}) {
  const entry = findInList(list, scenarioName);
  const best = entry ? bestFor(entry, localBests) : 0;
  const earned = entry ? rankName(best, entry.thresholds, list.ranks) : null;
  const colour = entry
    ? computeFillColor(rankForScore(best, entry.thresholds), list.ranks)
    : undefined;

  return (
    <button
      type="button"
      onClick={onPick}
      title={`${list.benchmarkName} · ${list.difficultyName}`}
      className={cn(
        "flex max-w-[15rem] items-center gap-1.5 rounded-md px-2 py-1 text-[0.625rem] transition-colors",
        active
          ? "bg-surface text-foreground"
          : "text-surface-muted-foreground hover:bg-surface/60 hover:text-foreground",
      )}
    >
      <span className="min-w-0 truncate">
        {list.benchmarkName}
        <span className="opacity-60">
          {" · "}
          {list.difficultyName}
        </span>
      </span>
      <span
        className="shrink-0 font-medium"
        style={earned ? { color: colour } : undefined}
      >
        {earned ?? "–"}
      </span>
    </button>
  );
}

/**
 * The list itself, with the played scenario kept findable.
 *
 * A long ladder scrolls, and a marked row that has scrolled out of sight is
 * no better than an unmarked one, so the panel says which way it went and
 * offers to go back to it.
 */
function LadderList({
  list,
  scenarioName,
  runScore,
  normal,
  localBests,
}: {
  list: BenchmarkList;
  scenarioName: string;
  runScore: number;
  normal: number | null;
  localBests: Map<string, number>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const [offscreen, setOffscreen] = useState<"above" | "below" | null>(null);

  const scrollToRow = (smooth = true) => {
    const root = scrollRef.current;
    const row = rowRef.current;
    if (!root || !row) return;
    root.scrollTo({
      top: row.offsetTop - root.clientHeight / 2 + row.clientHeight / 2,
      behavior: smooth ? "smooth" : "auto",
    });
  };

  // Centre the marked row whenever the list changes, so opening a benchmark
  // never starts with a hunt.
  useLayoutEffect(() => {
    scrollToRow(false);
  }, [list.key, scenarioName]);

  useEffect(() => {
    const root = scrollRef.current;
    const row = rowRef.current;
    if (!root || !row) {
      setOffscreen(null);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setOffscreen(null);
          return;
        }
        const rootTop = entry.rootBounds?.top ?? 0;
        setOffscreen(
          entry.boundingClientRect.top < rootTop ? "above" : "below",
        );
      },
      { root, threshold: 1 },
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, [list.key, scenarioName]);

  const entry = findInList(list, scenarioName);
  const marked = entry ? bestFor(entry, localBests) : 0;
  const markedRank = entry
    ? rankName(marked, entry.thresholds, list.ranks)
    : null;

  const locator = (direction: "above" | "below") => (
    <button
      type="button"
      onClick={() => scrollToRow()}
      className="flex w-full items-center gap-1.5 rounded-md bg-surface px-2 py-1 text-[0.625rem] text-foreground hover:bg-surface-panel"
    >
      {direction === "above" ? (
        <ChevronUp className="h-3 w-3 shrink-0" />
      ) : (
        <ChevronDown className="h-3 w-3 shrink-0" />
      )}
      <span className="min-w-0 truncate font-medium">{scenarioName}</span>
      {markedRank && (
        <span className="ml-auto shrink-0 text-surface-muted-foreground">
          {markedRank}
        </span>
      )}
    </button>
  );

  return (
    <div className="space-y-1">
      {offscreen === "above" && locator("above")}
      <div
        ref={scrollRef}
        className="relative max-h-[22rem] space-y-2 overflow-y-auto pr-1"
      >
        {list.categories.map((category) => (
          <div key={category.name || "uncategorised"}>
            {category.name && (
              <div className="pb-0.5 text-[0.625rem] font-medium uppercase tracking-wider text-surface-muted-foreground">
                {category.name}
              </div>
            )}
            {category.groups.map((group) => (
              <div key={group.name || "ungrouped"} className="pb-1">
                {group.name && (
                  <div className="pb-0.5 pl-1 text-[0.5625rem] uppercase tracking-wider text-surface-muted-foreground/70">
                    {group.name}
                  </div>
                )}
                {group.scenarios.map((scenario) => {
                  const mine = scenario.name === scenarioName;
                  return (
                    <div key={scenario.name} ref={mine ? rowRef : undefined}>
                      <LadderRow
                        scenario={scenario}
                        ranks={list.ranks}
                        best={bestFor(scenario, localBests)}
                        runScore={mine ? runScore : null}
                        normal={mine ? normal : null}
                        marked={mine}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
      {offscreen === "below" && locator("below")}
    </div>
  );
}

/**
 * One scenario's ladder.
 *
 * The axis gives every rank an equal share rather than spacing them by score,
 * because thresholds are spaced unevenly and a score-linear axis would draw
 * some ranks wide and others a sliver.
 */
function LadderRow({
  scenario,
  ranks,
  best,
  runScore,
  normal,
  marked,
}: {
  scenario: LadderScenario;
  ranks: Array<{ name?: string; color?: string }>;
  best: number;
  runScore: number | null;
  normal: number | null;
  marked: boolean;
}) {
  const { thresholds } = scenario;
  const bands = thresholds.length - 1;
  const fillColor = computeFillColor(rankForScore(best, thresholds), ranks);
  const earned = rankName(best, thresholds, ranks as never);
  const pct = (value: number) =>
    `${(rankPosition(value, thresholds) * 100).toFixed(2)}%`;

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md py-0.5 pr-1",
        marked ? "bg-primary/10 pl-1" : "pl-2",
      )}
    >
      {marked && (
        <span
          aria-hidden
          className="h-3 w-0.5 shrink-0 rounded-full bg-primary"
        />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[0.6875rem]",
          marked ? "font-medium text-foreground" : "text-surface-foreground",
        )}
        title={scenario.name}
      >
        {scenario.name}
      </span>

      <div className="relative h-3.5 w-[9rem] shrink-0 sm:w-[12rem]">
        <div className="absolute inset-x-0 top-1 h-2 overflow-hidden rounded-full bg-surface-panel">
          <div
            className="absolute inset-y-0 left-0"
            style={{ width: pct(best), background: fillColor }}
          />
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
        {runScore !== null && (
          <>
            <div
              className="absolute top-0 h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
              style={{
                left: pct(runScore),
                boxShadow: "0 0 0 1px var(--canvas)",
              }}
              aria-hidden
            />
            <div
              className="absolute top-[0.75rem] size-0 -translate-x-1/2 border-x-[3px] border-b-[4px] border-x-transparent"
              style={{
                left: pct(runScore),
                borderBottomColor: "var(--foreground)",
              }}
              aria-hidden
            />
          </>
        )}
      </div>

      <span
        className="w-[4.5rem] shrink-0 truncate text-right text-[0.625rem]"
        style={earned ? { color: fillColor } : undefined}
      >
        {earned ?? "–"}
      </span>
    </div>
  );
}

/** How this run compared with normal; the provenance waits for a hover. */
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
              {delta >= 0 ? "+" : ""}
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
