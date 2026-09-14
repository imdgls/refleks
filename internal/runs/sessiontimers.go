package runs

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"refleks/internal/constants"
	"refleks/internal/runs/screen"
	appsettings "refleks/internal/settings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// The session clock, kept somewhere it will outlive the clip it came from.
//
// Replays are capped by total size, not by age: at five gigabytes and some
// thirty-five megabytes a clip, roughly three and a half days survive. The
// clock can therefore only be read once, in the minutes after a clip is cut,
// and whatever is not captured then is gone for good. So the number is
// copied out immediately and kept here, in the data directory rather than
// among the replays, where the size cap cannot reach it.
//
// Failures are recorded as deliberately as successes. There is no second
// attempt to fall back on, so a reading that stops working - a changed
// resolution, the on-screen panel switched off - has to be visible while it
// is still worth fixing, rather than discovered weeks later as a suspicion
// that the figures look low. The reason travels with the entry and the
// interface shows it; this file does not decide how, only that it is kept.

const sessionTimerFileName = "session-timers.json"
const sessionTimerVersion = 1

// SessionTimerEntry is one run's reading, or the reason there is not one.
type SessionTimerEntry struct {
	// Seconds is the clock at the end of the run, 0 when unread.
	Seconds int `json:"seconds,omitempty"`
	// Reason is empty on success and carries the refusal otherwise.
	Reason string `json:"reason,omitempty"`
	ReadAt int64  `json:"readAt"`
}

// Read reports whether this entry carries a usable figure.
func (e SessionTimerEntry) Read() bool { return e.Reason == "" && e.Seconds > 0 }

type sessionTimerFile struct {
	Version int                          `json:"version"`
	Entries map[string]SessionTimerEntry `json:"entries"`
}

var sessionTimerMu sync.Mutex

func sessionTimerPath() (string, error) {
	base, err := appsettings.GetConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, sessionTimerFileName), nil
}

// SessionTimers returns every reading recorded so far, keyed by run file name.
func (s *Store) SessionTimers() map[string]SessionTimerEntry {
	sessionTimerMu.Lock()
	defer sessionTimerMu.Unlock()
	f, err := loadSessionTimersLocked()
	if err != nil {
		return map[string]SessionTimerEntry{}
	}
	return f.Entries
}

func loadSessionTimersLocked() (sessionTimerFile, error) {
	out := sessionTimerFile{Version: sessionTimerVersion, Entries: map[string]SessionTimerEntry{}}
	path, err := sessionTimerPath()
	if err != nil {
		return out, err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	var parsed sessionTimerFile
	if err := json.Unmarshal(raw, &parsed); err != nil {
		// A damaged index is worth less than the readings still to come, so
		// it starts again rather than blocking them.
		return out, nil
	}
	if parsed.Entries == nil {
		parsed.Entries = map[string]SessionTimerEntry{}
	}
	return parsed, nil
}

func storeSessionTimerLocked(key string, entry SessionTimerEntry) error {
	f, err := loadSessionTimersLocked()
	if err != nil {
		return err
	}
	f.Version = sessionTimerVersion
	f.Entries[key] = entry

	path, err := sessionTimerPath()
	if err != nil {
		return err
	}
	blob, err := json.Marshal(f)
	if err != nil {
		return err
	}
	// Written beside the target and renamed over it: a half-written index
	// would lose every reading taken so far, which cannot be retaken.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, blob, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// recordSessionTimer reads the clock out of a freshly cut replay and files
// the result under the run's name.
//
// It is called once per clip and never retried, because the clip will not be
// there to retry against.
func (s *Store) recordSessionTimer(runPath string) {
	key := sessionTimerKey(runPath)
	if key == "" {
		return
	}

	sessionTimerMu.Lock()
	existing, loadErr := loadSessionTimersLocked()
	sessionTimerMu.Unlock()
	if loadErr == nil {
		if _, done := existing.Entries[key]; done {
			return // Read once: the clip may not survive a second attempt.
		}
	}

	s.screenMu.Lock()
	encoder := s.encoder
	s.screenMu.Unlock()

	replayPath := ""
	if encoder != nil {
		replayPath, _ = s.ReplayPath(runPath, encoder.Info().Container)
	}

	entry := SessionTimerEntry{ReadAt: time.Now().UnixMilli()}
	switch {
	case encoder == nil:
		entry.Reason = "no encoder available to read the clip"
	case replayPath == "":
		entry.Reason = "could not resolve the replay's path"
	default:
		seconds, readErr := encoder.ReadSessionTimer(replayPath)
		var unavailable screen.ErrTimerUnavailable
		switch {
		case readErr == nil:
			entry.Seconds = seconds
		case errors.As(readErr, &unavailable):
			entry.Reason = unavailable.Reason
		default:
			entry.Reason = readErr.Error()
		}
	}

	sessionTimerMu.Lock()
	err := storeSessionTimerLocked(key, entry)
	sessionTimerMu.Unlock()
	if err != nil {
		runtime.LogErrorf(s.ctx, "session clock: could not record %s: %v", key, err)
		return
	}

	if entry.Read() {
		runtime.LogDebugf(s.ctx, "session clock: %s read %d:%02d", key, entry.Seconds/60, entry.Seconds%60)
		return
	}
	// Logged loudly. This is the only chance to notice that reading has
	// stopped working while the cause is still recent.
	runtime.LogWarningf(s.ctx, "session clock: %s could not be read: %s", key, entry.Reason)
}

// sessionTimerKey names an entry by the run's file name, the same handle the
// stored run and the interface use.
func sessionTimerKey(runPath string) string {
	base := filepath.Base(runPath)
	base = strings.TrimSuffix(base, constants.RunFileExt)
	return strings.TrimSpace(base)
}

// RecentSessionTimerFailures returns the newest refusals, most recent first,
// for surfacing in the interface.
func (s *Store) RecentSessionTimerFailures(limit int) []string {
	entries := s.SessionTimers()
	type failure struct {
		at     int64
		reason string
	}
	var all []failure
	for _, e := range entries {
		if e.Reason != "" {
			all = append(all, failure{e.ReadAt, e.Reason})
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].at > all[j].at })
	out := make([]string, 0, limit)
	for _, f := range all {
		if len(out) >= limit {
			break
		}
		out = append(out, f.reason)
	}
	return out
}
