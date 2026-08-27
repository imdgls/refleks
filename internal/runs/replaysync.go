package runs

import (
	"encoding/json"
	"os"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"refleks/internal/constants"
)

// A replay .mp4 does not begin at the moment its run began.
//
// TrimRecording copies whole capture segments with -c copy and starts the
// output at the first keyframe of the segment covering the run start (see
// screen/encode.go: the computed start offset is deliberately discarded so
// the stream stays decodable in WebView2). That leaves up to one segment
// length - ScreenCaptureSegmentSeconds - of footage in front of the run.
//
// The wall-clock time of that first video frame is known while trimming:
// it is firstSegmentStartMs. Nothing has ever persisted it, so anything
// wanting to line video time up against the mouse trace had to measure the
// offset back out of the pixels. Recording it turns that into arithmetic:
//
//	traceEpochMs = frame0EpochMs + videoCurrentTimeSeconds*1000
//
// It is written to a sidecar rather than into the .refleks run file on
// purpose. The run file is saved as soon as the run ends, while its trim
// can finish up to a minute later; rewriting a finished run file to add a
// field would be a far more invasive change than writing a second small
// file next to the replay it describes.
//
// The sidecar is optional by design. A replay recorded before this existed
// simply has none, and callers fall back to aligning by hand.

// ReplaySyncExt is appended to a replay's own path, giving names like
// "<run>.mp4.sync.json" so a sidecar always sits beside its replay and is
// removed with it.
const ReplaySyncExt = ".sync.json"

// ReplaySyncVersion identifies the sidecar layout. Readers must ignore a
// version they do not recognise rather than guess at its fields.
const ReplaySyncVersion = 1

// ReplaySync records how a replay's video timeline maps onto wall-clock
// time. All times are Unix epoch milliseconds, matching the mouse trace's
// own timestamps.
type ReplaySync struct {
	Version int `json:"version"`

	// Frame0EpochMs is when the replay's first video frame was captured.
	// This is the field that matters; the rest is context for diagnosing a
	// suspicious alignment.
	Frame0EpochMs int64 `json:"frame0EpochMs"`

	// RunStartEpochMs and RunEndEpochMs bound the run itself, so a consumer
	// can tell run footage from the segment pre-roll ahead of it and the
	// tail kept after it.
	RunStartEpochMs int64 `json:"runStartEpochMs"`
	RunEndEpochMs   int64 `json:"runEndEpochMs"`

	// ReplayEndEpochMs is where the trim was cut, i.e. the run end plus
	// ScreenCaptureReplayTailSeconds.
	ReplayEndEpochMs int64 `json:"replayEndEpochMs"`

	// SessionStartEpochMs is the capture session this replay was cut from.
	SessionStartEpochMs int64 `json:"sessionStartEpochMs"`

	// SegmentSeconds is the segment length in force when this replay was
	// trimmed, which bounds how much pre-roll Frame0EpochMs can represent.
	SegmentSeconds int `json:"segmentSeconds"`
}

// PreRollMs is how much footage precedes the run itself.
func (r ReplaySync) PreRollMs() int64 {
	return r.RunStartEpochMs - r.Frame0EpochMs
}

// ReplaySyncPath returns the sidecar path for a replay file.
func ReplaySyncPath(replayPath string) string {
	return replayPath + ReplaySyncExt
}

// writeReplaySync records a freshly trimmed replay's alignment. Failing to
// write it is logged but never fails the trim: the replay itself is the
// valuable artifact, and a missing sidecar only costs manual alignment.
//
// Written via a temporary file and a rename so a reader can never observe a
// half-written sidecar.
func (s *Store) writeReplaySync(replayPath string, trim pendingScreenTrim, frame0EpochMs int64) {
	data := ReplaySync{
		Version:             ReplaySyncVersion,
		Frame0EpochMs:       frame0EpochMs,
		RunStartEpochMs:     trim.runStart.UnixMilli(),
		RunEndEpochMs:       trim.runEnd.UnixMilli(),
		ReplayEndEpochMs:    trim.replayEnd.UnixMilli(),
		SessionStartEpochMs: trim.sessionStart.UnixMilli(),
		SegmentSeconds:      constants.ScreenCaptureSegmentSeconds,
	}

	encoded, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		runtime.LogWarningf(s.ctx, "screen/sync: encode sidecar for %s: %v", trim.runFileName, err)
		return
	}

	path := ReplaySyncPath(replayPath)
	tmpPath := path + ".partial"
	if err := os.WriteFile(tmpPath, encoded, 0o644); err != nil {
		runtime.LogWarningf(s.ctx, "screen/sync: write sidecar for %s: %v", trim.runFileName, err)
		return
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		runtime.LogWarningf(s.ctx, "screen/sync: publish sidecar for %s: %v", trim.runFileName, err)
		return
	}

	runtime.LogInfof(s.ctx, "screen/sync: %s starts at epoch %d (%d ms of pre-roll before the run)",
		trim.runFileName, data.Frame0EpochMs, data.PreRollMs())
}

// ReadReplaySync loads a replay's sidecar. A replay without one, or with a
// sidecar written by a newer version, returns (nil, nil): the caller is
// expected to carry on without it rather than treat it as an error.
func ReadReplaySync(replayPath string) (*ReplaySync, error) {
	encoded, err := os.ReadFile(ReplaySyncPath(replayPath))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var data ReplaySync
	if err := json.Unmarshal(encoded, &data); err != nil {
		return nil, err
	}
	if data.Version != ReplaySyncVersion || data.Frame0EpochMs <= 0 {
		return nil, nil
	}
	return &data, nil
}
