import {
  cellFill,
  computeFillColor,
} from "@/features/benchmarks/lib/detailFormatting";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/components/ui/tooltip";
import { useBenchmarks, usePersistedState } from "@/shared/hooks";
import { cn } from "@/shared/lib";
import type { RankDef } from "@/shared/types";
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
 * its category and subcategory says where a result sits in the whole ladder,
 * which a lone bar cannot.
 *
 * One benchmark is listed at a time, because a scenario can belong to seven
 * of them and stacking those is 152 rows under a video. Nothing is chosen on
 * the player's behalf even so: every benchmark gets a tab carrying the rank
 * the scenario holds there, so the spread is readable without switching.
 *
 * The played scenario's row always prints the thresholds. Whether the other
 * rows do is a preference, because it is a judgement rather than a fact:
 * they fit - even a thirteen-rank ladder leaves forty pixels a segment, and
 * 99% of the ladders reachable from a month's play have ten ranks or fewer -
 * but thirty-nine rows of them is three hundred numbers, and whether that
 * reads as context or as noise is not something to decide on someone's
 * behalf. Off, the other rows give up their thresholds on hover instead.
 *
 * Either way the played row is set apart by weight rather than by being the
 * only one with numbers: larger, brighter figures, its own key line and
 * markers, a ring and a block of three lines among rows of one.
 */

const STORE_OPEN = "refleks.replay.ladder.open";
const STORE_PICK = "refleks.replay.ladder.benchmark";
const STORE_ROW_NUMBERS = "refleks.replay.ladder.rowNumbers";

export function BenchmarkLadderPanel({
  scenarioName,
  runScore,
  playedAt,
}: {
  scenarioName: string;
  runScore: number;
  playedAt?: number;
}) {
  const { benchmarks, progressMap, loadAllProgress, favorites } =
    useBenchmarks();
  const [open, setOpen] = usePersistedState(STORE_OPEN, true);
  const [pick, setPick] = usePersistedState<string>(STORE_PICK, "");
  const [rowNumbers, setRowNumbers] = usePersistedState(
    STORE_ROW_NUMBERS,
    true,
  );
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
  const normal = useScenarioNormal(scenarioName, playedAt);
  const localBests = useLocalBests();

  // The remembered benchmark applies only where it holds the scenario;
  // otherwise the ordering decides.
  const selected = lists.find((l) => l.key === pick) ?? lists[0] ?? null;
  const loading =
    benchmarks.length === 0 || Object.keys(progressMap).length === 0;

  return (
    <div className="rounded-xl bg-surface-subtle">
      <div className="flex items-center gap-1 px-2 py-1">
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
        {open && selected && (
          <button
            type="button"
            onClick={() => setRowNumbers((v) => !v)}
            aria-pressed={rowNumbers}
            title="Show each rank's score on every row, not only on yours"
            className={cn(
              "ml-auto rounded px-1.5 py-0.5 text-[0.625rem] transition-colors",
              rowNumbers
                ? "bg-surface text-foreground"
                : "text-surface-muted-foreground hover:text-foreground",
            )}
          >
            thresholds on every row
          </button>
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
                normal={normal}
                localBests={localBests}
                rowNumbers={rowNumbers}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
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
 * The list, with the played scenario kept findable.
 *
 * A marked row that has scrolled out of sight is no better than an unmarked
 * one, so the list centres it and, once it leaves, says which way it went.
 */
function LadderList({
  list,
  scenarioName,
  runScore,
  normal,
  localBests,
  rowNumbers,
}: {
  list: BenchmarkList;
  scenarioName: string;
  runScore: number;
  normal: ScenarioNormal;
  localBests: Map<string, number>;
  rowNumbers: boolean;
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
  const markedBest = entry ? bestFor(entry, localBests) : 0;
  const markedRank = entry
    ? rankName(markedBest, entry.thresholds, list.ranks)
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
        className="relative max-h-[24rem] space-y-2 overflow-y-auto pr-1"
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
                {group.scenarios.map((scenario) =>
                  scenario.name === scenarioName ? (
                    <div key={scenario.name} ref={rowRef}>
                      <MarkedRow
                        scenario={scenario}
                        ranks={list.ranks}
                        best={bestFor(scenario, localBests)}
                        runScore={runScore}
                        normal={normal}
                      />
                    </div>
                  ) : (
                    <CompactRow
                      key={scenario.name}
                      scenario={scenario}
                      ranks={list.ranks}
                      best={bestFor(scenario, localBests)}
                      showNumbers={rowNumbers}
                    />
                  ),
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      {offscreen === "below" && locator("below")}
    </div>
  );
}

/* ─── The bar ─── */

/**
 * A ladder drawn as one cell per rank, which is how the benchmarks page
 * draws it and what makes the thresholds readable: the cells are equal, so
 * unevenly spaced scores do not make some ranks a sliver.
 *
 * Cells carry their own fill rather than one bar being filled across them,
 * which is the same picture and lets a threshold sit inside its cell with a
 * legible colour on both sides of the fill edge.
 */
type Numbers = "none" | "dim" | "full";

function LadderBar({
  thresholds,
  ranks,
  best,
  numbers,
  tall,
  children,
}: {
  thresholds: number[];
  ranks: RankDef[];
  best: number;
  /** "dim" is the other rows: present, smaller, quieter than the played row. */
  numbers: Numbers;
  tall: boolean;
  children?: React.ReactNode;
}) {
  const bands = Math.max(0, thresholds.length - 1);
  const fillColor = computeFillColor(rankForScore(best, thresholds), ranks);
  const height = tall
    ? "h-[1.375rem]"
    : numbers === "none"
      ? "h-2.5"
      : "h-[0.9375rem]";

  return (
    <div className={cn("relative w-full", height)}>
      <div
        className="absolute inset-0 grid overflow-hidden rounded-md"
        style={{ gridTemplateColumns: `repeat(${bands}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: bands }, (_, i) => {
          const fill = cellFill(i, best, thresholds);
          const pct = Math.round(fill * 100);
          const label = formatScore(thresholds[i + 1]);
          return (
            <div
              key={i}
              className={cn(
                "relative flex items-center justify-center overflow-hidden bg-surface-panel",
                i > 0 && "border-l border-canvas/70",
              )}
            >
              <div
                className="absolute inset-y-0 left-0"
                style={{ width: `${pct}%`, background: fillColor }}
              />
              {/* JetBrains Mono, which the app already ships and uses for
                  timecodes. Montserrat is a geometric sans whose digits
                  close up at eight pixels - 0 against 8, 3 against 8 - and
                  its figures are proportional, so a column of thresholds
                  does not line up. A monospace face fixes both. */}
              {numbers !== "none" && (
                <>
                  <span
                    className={cn(
                      "relative z-10 font-mono tabular-nums",
                      numbers === "full"
                        ? "text-[0.5625rem] text-foreground/70"
                        : "text-[0.5rem] text-foreground/55",
                    )}
                  >
                    {label}
                  </span>
                  {/* The same number again, clipped to the filled part, so it
                      stays legible where the fill runs under it. */}
                  {pct > 0 && (
                    <span
                      aria-hidden
                      className={cn(
                        // Over the fill the contrast colour is never diluted:
                        // a translucent dark on a saturated rank colour is
                        // what made these unreadable. The quieter rows are
                        // quieter by size and by their unfilled colour only.
                        "absolute inset-0 z-20 flex items-center justify-center font-medium font-mono tabular-nums text-canvas",
                        numbers === "full"
                          ? "text-[0.5625rem]"
                          : "text-[0.5rem]",
                      )}
                      style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}
                    >
                      {label}
                    </span>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      {children}
    </div>
  );
}

/** Every row that is not the one played: the ladder, filled, and nothing else. */
function CompactRow({
  scenario,
  ranks,
  best,
  showNumbers,
}: {
  scenario: LadderScenario;
  ranks: RankDef[];
  best: number;
  showNumbers: boolean;
}) {
  const earned = rankName(best, scenario.thresholds, ranks);
  const fillColor = computeFillColor(
    rankForScore(best, scenario.thresholds),
    ranks,
  );

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex cursor-default items-center gap-2 py-0.5 pl-2 pr-1">
            <span
              className="w-[11rem] shrink-0 truncate text-[0.6875rem] text-surface-foreground"
              title={scenario.name}
            >
              {scenario.name}
            </span>
            <div className="min-w-0 flex-1">
              <LadderBar
                thresholds={scenario.thresholds}
                ranks={ranks}
                best={best}
                numbers={showNumbers ? "dim" : "none"}
                tall={false}
              />
            </div>
            <span
              className="w-[4.5rem] shrink-0 truncate text-right text-[0.625rem]"
              style={earned ? { color: fillColor } : undefined}
            >
              {earned ?? "–"}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[20rem]">
          <div className="text-[0.6875rem] leading-relaxed">
            <div className="font-medium">{scenario.name}</div>
            <div className="text-popover-foreground/70">
              Best {formatScore(best)} · thresholds{" "}
              {scenario.thresholds
                .slice(1)
                .map((t) => formatScore(t))
                .join(" · ")}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The played scenario: the ladder with its thresholds, the three figures
 * that describe this result, and what is left to the next rank.
 *
 * The figures sit in a fixed key line rather than beside their markers.
 * Normal, this run and the record are three samples of the same player on
 * the same scenario, so they cluster: on one real row they spanned 8.7% of
 * the bar where three labels need about 24%. The bar says where they are,
 * the key says what they are, and the order never changes.
 */
function MarkedRow({
  scenario,
  ranks,
  best,
  runScore,
  normal,
}: {
  scenario: LadderScenario;
  ranks: RankDef[];
  best: number;
  runScore: number;
  normal: ScenarioNormal;
}) {
  const { thresholds } = scenario;
  const earned = rankName(best, thresholds, ranks);
  const fillColor = computeFillColor(rankForScore(best, thresholds), ranks);
  const pct = (value: number) =>
    `${(rankPosition(value, thresholds) * 100).toFixed(2)}%`;

  // A run that beat everything before it is the record, and saying so once
  // is better than printing the same number twice under two names.
  const isRecord = runScore >= best;
  const isNewRecord = runScore > normal.bestBefore && normal.bestBefore > 0;
  const isFirstEver = normal.bestBefore === 0;

  const runRank = rankForScore(runScore, thresholds);
  const nextThreshold =
    runRank + 1 < thresholds.length ? thresholds[runRank + 1] : null;
  const nextRankName = ranks[runRank]?.name ?? null;
  const toNext =
    nextThreshold !== null && runScore > 0
      ? ((nextThreshold - runScore) / runScore) * 100
      : null;

  return (
    <div className="my-1 rounded-lg bg-primary/10 py-1.5 pl-1 pr-1 ring-1 ring-primary/30">
      <div className="flex items-center gap-2 pb-1">
        <span
          aria-hidden
          className="h-3.5 w-1 shrink-0 rounded-full bg-primary"
        />
        <span
          className="min-w-0 flex-1 truncate text-[0.75rem] font-semibold text-foreground"
          title={scenario.name}
        >
          {scenario.name}
        </span>
        <span
          className="shrink-0 text-[0.6875rem] font-medium"
          style={earned ? { color: fillColor } : undefined}
        >
          {earned ?? "unranked"}
        </span>
        <HoverDetail
          scenario={scenario}
          best={best}
          runScore={runScore}
          normal={normal}
          nextThreshold={nextThreshold}
          nextRankName={nextRankName}
        />
      </div>

      <Key
        normal={normal.normal}
        runScore={runScore}
        best={best}
        isRecord={isRecord}
        isNewRecord={isNewRecord}
        isFirstEver={isFirstEver}
        toNext={toNext}
        nextRankName={nextRankName}
        fillColor={fillColor}
      />

      <div className="pl-2 pr-1 pt-1">
        <LadderBar
          thresholds={thresholds}
          ranks={ranks}
          best={best}
          numbers="full"
          tall
        >
          {normal.normal !== null && (
            <div
              aria-hidden
              title="your normal"
              className="pointer-events-none absolute inset-y-0 w-[5px] -translate-x-1/2 rounded-sm bg-foreground/35"
              style={{ left: pct(normal.normal) }}
            />
          )}
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
            style={{
              left: pct(runScore),
              boxShadow: "0 0 0 1px var(--canvas)",
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-1 size-0 -translate-x-1/2 border-x-[3px] border-b-[4px] border-x-transparent"
            style={{
              left: pct(runScore),
              borderBottomColor: "var(--foreground)",
            }}
          />
        </LadderBar>
      </div>
    </div>
  );
}

/** The fixed key: always the same items in the same order. */
function Key({
  normal,
  runScore,
  best,
  isRecord,
  isNewRecord,
  isFirstEver,
  toNext,
  nextRankName,
  fillColor,
}: {
  normal: number | null;
  runScore: number;
  best: number;
  isRecord: boolean;
  isNewRecord: boolean;
  isFirstEver: boolean;
  toNext: number | null;
  nextRankName: string | null;
  fillColor: string;
}) {
  const target =
    toNext === null
      ? "top rank"
      : `${toNext.toFixed(toNext < 10 ? 1 : 0)}% to ${nextRankName ?? "next"}`;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-3 text-[0.625rem]">
      {normal !== null && (
        <span className="flex items-center gap-1 text-surface-muted-foreground">
          <span
            aria-hidden
            className="h-2 w-[5px] shrink-0 rounded-sm bg-foreground/35"
          />
          normal{" "}
          <span className="font-mono tabular-nums">{formatScore(normal)}</span>
        </span>
      )}

      {/* When the run is the record the two are one number, so they are said
          once - and the occasion is worth naming rather than hiding. */}
      {isRecord ? (
        <span className="flex items-center gap-1 font-medium text-foreground">
          <span
            aria-hidden
            className="h-2.5 w-0.5 shrink-0 rounded-full bg-foreground"
          />
          {isFirstEver ? "first run" : isNewRecord ? "new record" : "record"}{" "}
          <span className="font-mono tabular-nums">
            {formatScore(runScore)}
          </span>
        </span>
      ) : (
        <>
          <span className="flex items-center gap-1 font-medium text-foreground">
            <span
              aria-hidden
              className="h-2.5 w-0.5 shrink-0 rounded-full bg-foreground"
            />
            this run{" "}
            <span className="font-mono tabular-nums">
              {formatScore(runScore)}
            </span>
          </span>
          <span className="flex items-center gap-1 text-surface-muted-foreground">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ background: fillColor }}
            />
            record{" "}
            <span className="font-mono tabular-nums">{formatScore(best)}</span>
          </span>
        </>
      )}

      <span className="text-primary">{target}</span>
    </div>
  );
}

/** Everything that does not earn a place on the row itself. */
function HoverDetail({
  scenario,
  best,
  runScore,
  normal,
  nextThreshold,
  nextRankName,
}: {
  scenario: LadderScenario;
  best: number;
  runScore: number;
  normal: ScenarioNormal;
  nextThreshold: number | null;
  nextRankName: string | null;
}) {
  const ofBest = best > 0 ? (runScore / best) * 100 : null;

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 cursor-default rounded px-1 text-[0.625rem] text-surface-muted-foreground hover:text-foreground">
            details
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[20rem]">
          <div className="space-y-1 text-[0.6875rem] leading-relaxed">
            <div className="font-medium">{scenario.name}</div>
            {ofBest !== null && (
              <div>
                This run reached{" "}
                <span className="font-mono tabular-nums">
                  {ofBest.toFixed(0)}%
                </span>{" "}
                of your record.
              </div>
            )}
            {normal.normal !== null && (
              <div className="text-popover-foreground/70">
                Normal is the median of {normal.runs} run
                {normal.runs === 1 ? "" : "s"}
                {normal.spanDays > 0 ? ` over ${normal.spanDays} days` : ""}, of{" "}
                {normal.total} on record.
              </div>
            )}
            {nextThreshold !== null && (
              <div className="text-popover-foreground/70">
                {nextRankName ?? "Next rank"} needs{" "}
                <span className="font-mono tabular-nums">
                  {formatScore(nextThreshold)}
                </span>
                , which is{" "}
                <span className="font-mono tabular-nums">
                  {formatScore(nextThreshold - runScore)}
                </span>{" "}
                more than this run.
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
