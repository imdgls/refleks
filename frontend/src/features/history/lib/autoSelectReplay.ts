import { EventsOn } from "@wails/runtime";
import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { HistoryRun } from "./historyModels";
import type { InspectorTab } from "./inspectorTabs";

/**
 * Brings the newest replay forward on its own, so it is already open when
 * the player comes back from the game.
 *
 * A trim finishes up to three quarters of a minute after its run, by which
 * time the next run is usually under way. So this has to be genuinely
 * invisible, not merely quiet:
 *
 *   - it never touches the window. Nothing on this path calls WindowShow or
 *     any of its neighbours, so focus, position and minimised state are all
 *     left exactly as they were.
 *   - it never starts playback. The player only ever calls play() from its
 *     own button.
 *   - it does nothing at all while the app has focus. Changing the selection
 *     under someone who is looking at it is the interruption worth avoiding,
 *     and someone with the window in front of them can pick the run himself.
 *   - it waits for an idle moment before applying, so the loading the
 *     selection sets off does not compete with a game for the main thread.
 *
 * What it cannot avoid is that loading: choosing a run reads its trace,
 * events and replay metadata and runs the analyses. That is the cost of
 * having it ready rather than loading while you watch, and it is why this
 * can be switched off.
 */

export const STORE_AUTO_SELECT = "refleks.replay.autoSelectLatest";

export function isAutoSelectEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORE_AUTO_SELECT);
    return raw === null ? true : JSON.parse(raw) === true;
  } catch {
    return true;
  }
}

type Selectors = {
  runs: HistoryRun[];
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
  setPrimaryRunId: Dispatch<SetStateAction<string | null>>;
  setInspectorTab: Dispatch<SetStateAction<InspectorTab>>;
  setRunInspectorOpen: Dispatch<SetStateAction<boolean>>;
};

/** Runs the work when the main thread is free, or shortly after regardless. */
function whenIdle(fn: () => void): () => void {
  const idle = (
    window as typeof window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    }
  ).requestIdleCallback;

  if (typeof idle === "function") {
    const handle = idle(fn, { timeout: 4000 });
    return () =>
      (window as typeof window & { cancelIdleCallback?: (h: number) => void })
        .cancelIdleCallback?.(handle);
  }
  const timer = window.setTimeout(fn, 250);
  return () => window.clearTimeout(timer);
}

export function useAutoSelectLatestReplay(selectors: Selectors) {
  // Held in a ref so a new run list does not tear down and rebuild the
  // subscription, which would drop events arriving at that moment.
  const latest = useRef(selectors);
  latest.current = selectors;

  useEffect(() => {
    const cancels = new Set<() => void>();

    const off = EventsOn(
      "replay:status",
      (payload: { path?: string; state?: string }) => {
        if (payload?.state !== "ready" || !payload.path) return;
        if (!isAutoSelectEnabled()) return;
        // The one hard gate: never move the selection under someone's eyes.
        if (document.hasFocus()) return;

        const path = payload.path;
        const cancel = whenIdle(() => {
          cancels.delete(cancel);
          // Re-checked on the way out: focus can return while this waits.
          if (document.hasFocus() || !isAutoSelectEnabled()) return;

          const {
            runs,
            setSelectedSessionId,
            setPrimaryRunId,
            setInspectorTab,
            setRunInspectorOpen,
          } = latest.current;
          const run = runs.find((r) => r.item.filePath === path);
          if (!run) return;

          setSelectedSessionId(run.sessionId);
          setPrimaryRunId(run.id);
          setInspectorTab("replay");
          setRunInspectorOpen(true);
        });
        cancels.add(cancel);
      },
    );

    return () => {
      off();
      for (const cancel of cancels) cancel();
      cancels.clear();
    };
  }, []);
}
