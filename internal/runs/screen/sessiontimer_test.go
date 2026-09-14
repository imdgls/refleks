package screen

import (
	"fmt"
	"testing"
)

// paintTimer renders a clock into a crop the same shape the decoder is given,
// using the glyph bitmaps themselves, so a test value goes through the real
// segmentation and matching rather than a shortcut.
func paintTimer(clock string) []byte {
	buf := make([]byte, timerCropW*timerCropH)
	x := 4
	for _, ch := range clock {
		if ch == ':' {
			// Any small two-column blob segments as one character.
			for _, col := range []int{x, x + 1} {
				for y := timerRowTop + 4; y < timerRowTop+14; y += 5 {
					buf[y*timerCropW+col] = 255
					buf[(y+1)*timerCropW+col] = 255
				}
			}
			x += 4
			continue
		}
		bits := timerGlyphs[ch-'0']
		// Trim the glyph canvas back to its ink, then lay it down.
		top, bottom, left, right := glyphHeight, -1, glyphWidth, -1
		for gy := 0; gy < glyphHeight; gy++ {
			for gx := 0; gx < glyphWidth; gx++ {
				if bits[gy*glyphWidth+gx] {
					if gy < top {
						top = gy
					}
					if gy > bottom {
						bottom = gy
					}
					if gx < left {
						left = gx
					}
					if gx > right {
						right = gx
					}
				}
			}
		}
		for gy := top; gy <= bottom; gy++ {
			for gx := left; gx <= right; gx++ {
				if bits[gy*glyphWidth+gx] {
					buf[(timerRowTop+3+gy-top)*timerCropW+x+gx-left] = 255
				}
			}
		}
		x += right - left + 2
	}
	return buf
}

func TestDecodeTimerFrameReadsEveryDigit(t *testing.T) {
	cases := []struct {
		clock string
		want  int
	}{
		{"00:00:00", 0},
		{"00:01:23", 83},
		{"00:45:67", -1}, // 67 seconds is not a clock
		{"00:12:34", 754},
		{"00:56:07", 3367},
		{"00:08:59", 539},
		{"01:23:45", 5025},
		{"00:09:09", 549},
	}
	for _, c := range cases {
		t.Run(c.clock, func(t *testing.T) {
			got, ok := decodeTimerFrame(paintTimer(c.clock))
			if c.want < 0 {
				if ok {
					t.Fatalf("read %d from an impossible clock", got)
				}
				return
			}
			if !ok {
				t.Fatalf("refused a legible clock")
			}
			if got != c.want {
				t.Fatalf("got %d, want %d", got, c.want)
			}
		})
	}
}

// Every digit must survive a round trip, in both halves of a pair, or a
// mis-set template would hide behind the digits that happen to be tested.
func TestDecodeTimerFrameCoversAllTenDigits(t *testing.T) {
	for d := 0; d <= 9; d++ {
		clock := fmt.Sprintf("00:%d%d:%d%d", d, d, d, d)
		want := (d*10+d)*60 + d*10 + d
		got, ok := decodeTimerFrame(paintTimer(clock))
		if d > 5 {
			// Minutes and seconds above 59 are refused, which is the point.
			if ok {
				t.Errorf("%s: read %d from an impossible clock", clock, got)
			}
			continue
		}
		if !ok || got != want {
			t.Errorf("%s: got %d ok=%v, want %d", clock, got, ok, want)
		}
	}
	// The digits above 5 still have to read; put them where they are legal.
	for d := 6; d <= 9; d++ {
		clock := fmt.Sprintf("00:0%d:0%d", d, d)
		want := d*60 + d
		if got, ok := decodeTimerFrame(paintTimer(clock)); !ok || got != want {
			t.Errorf("%s: got %d ok=%v, want %d", clock, got, ok, want)
		}
	}
}

func TestDecodeTimerFrameRefusesRatherThanGuesses(t *testing.T) {
	t.Run("a blank panel", func(t *testing.T) {
		if _, ok := decodeTimerFrame(make([]byte, timerCropW*timerCropH)); ok {
			t.Fatal("read a clock out of an empty frame")
		}
	})

	t.Run("too few characters", func(t *testing.T) {
		if _, ok := decodeTimerFrame(paintTimer("00:00:0")); ok {
			t.Fatal("read a clock from seven characters")
		}
	})

	t.Run("a covered panel", func(t *testing.T) {
		// What the scenario-change logo does: ink everywhere.
		buf := make([]byte, timerCropW*timerCropH)
		for i := range buf {
			buf[i] = 255
		}
		if _, ok := decodeTimerFrame(buf); ok {
			t.Fatal("read a clock from a fully covered frame")
		}
	})

	t.Run("a short buffer", func(t *testing.T) {
		if _, ok := decodeTimerFrame(make([]byte, 10)); ok {
			t.Fatal("read a clock from a truncated frame")
		}
	})
}
