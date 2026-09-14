import { useStore } from "@/shared/hooks";
import { GetSessionTimers } from "@wails/go/main/App";
import { useEffect, useState } from "react";

/**
 * The session clock read out of each run's replay, as recorded by the backend.
 *
 * The clock counts time actually spent in a scenario, restarts and abandoned
 * attempts included, which is the figure this app cannot derive from the stats
 * files: those describe only the runs that finished.
 *
 * Failures are carried alongside the readings rather than dropped. There is no
 * second chance to read a clip - the replay store is capped by size and holds
 * roughly three days - so a reading that quietly stops working has to be
 * visible while the cause is still recent, not inferred weeks later from
 * figures that look low.
 */

export type SessionTimerEntry = {
  /** The clock at the end of the run, in seconds. Absent when unread. */
  seconds?: number;
  /** Empty on success; the refusal otherwise. */
  reason?: string;
  readAt: number;
};

export type SessionTimers = {
  /** Readings that succeeded, keyed by run file name. */
  seconds: Map<string, number>;
  /** Refusals, keyed the same way. */
  reasons: Map<string, string>;
  loaded: boolean;
};

const EMPTY: SessionTimers = {
  seconds: new Map(),
  reasons: new Map(),
  loaded: false,
};

export function useSessionTimers(): SessionTimers {
  // Re-read when a run lands: the backend files its reading moments after the
  // replay is cut, which is usually just after the run appears.
  const sessions = useStore((state) => state.sessions);
  const [timers, setTimers] = useState<SessionTimers>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    GetSessionTimers()
      .then((raw) => {
        if (cancelled) return;
        const seconds = new Map<string, number>();
        const reasons = new Map<string, string>();
        for (const [key, entry] of Object.entries(
          (raw ?? {}) as Record<string, SessionTimerEntry>,
        )) {
          if (entry?.reason) reasons.set(key, entry.reason);
          else if (typeof entry?.seconds === "number" && entry.seconds > 0) {
            seconds.set(key, entry.seconds);
          }
        }
        setTimers({ seconds, reasons, loaded: true });
      })
      .catch(() => {
        if (!cancelled) setTimers({ ...EMPTY, loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, [sessions]);

  return timers;
}
