//go:build windows

package mouse

import (
	"fmt"
	"os"

	"refleks/internal/models"
)

// compactLocked drops the points before start from both buffers.
//
// buf and pointDeviceIDs are parallel: entry i of one describes entry i of
// the other, and both are cut at the same index. Cutting them separately at
// a shared index is only safe while they are the same length, and a slice
// expression past the end of a slice does not return short - it panics, and
// takes the whole application with it.
//
// They have gone out of step before. Start cleared the device IDs without
// clearing the points or the start index, so a restarted tracker - which
// happens every time KovaaK's is relaunched - held thousands of points
// against a single ID, and the next compaction brought the app down with
// "slice bounds out of range [3181:1]". That cause is fixed at its source,
// but the consequence was severe enough to be worth making impossible:
// nobody can debug a process that is no longer running.
//
// So a mismatch here is survived rather than fatal, and survived by
// discarding the device IDs rather than keeping a misaligned set. Attributing
// points to the wrong mouse would be a quiet, plausible wrongness in the run
// record; having no attribution is visibly nothing, and the consumers of
// this data already treat an empty set as "unknown".
//
// The caller must hold t.mu.
func (t *trackerWin) compactLocked() {
	if t.start <= 0 {
		return
	}
	if t.start > len(t.buf) {
		t.start = len(t.buf)
	}

	aligned := t.start <= len(t.pointDeviceIDs)
	t.buf = append([]models.MousePoint(nil), t.buf[t.start:]...)
	if aligned {
		t.pointDeviceIDs = append([]uint32(nil), t.pointDeviceIDs[t.start:]...)
	} else {
		// Written to stderr because the tracker holds no logger; the launcher
		// captures it, so this leaves a trace instead of a crash.
		fmt.Fprintf(os.Stderr,
			"mouse: point and device buffers out of step (%d points, %d ids); dropping device attribution\n",
			len(t.buf)+t.start, len(t.pointDeviceIDs))
		t.pointDeviceIDs = t.pointDeviceIDs[:0]
	}
	t.start = 0
}
