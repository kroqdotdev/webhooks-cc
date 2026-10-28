package agent

import (
	"context"
	"crypto/sha256"
	"encoding"
	"errors"
	"fmt"
	"math/bits"
	"strconv"
	"time"
)

// Algorithm is the only proof-of-work scheme webhooks.cc asks for.
const Algorithm = "sha256-zero-bits"

// MaxWorkBits caps the expected work Solve takes on: 2^26 hashes, so a
// hostile or broken server cannot pin the CPU.
const MaxWorkBits = 26

// maxNonce keeps a nonce within the 16 decimal digits the server accepts.
const maxNonce = 1e16 - 1

// ErrUnsolvable: Solve refused a challenge (unknown algorithm, invalid
// parameters, or more work than MaxWorkBits allows).
var ErrUnsolvable = errors.New("webhooks.cc agent: unsolvable proof-of-work challenge")

// Challenge is a proof-of-work challenge for anonymous registration.
type Challenge struct {
	Challenge  string `json:"challenge"`
	Algorithm  string `json:"algorithm"`
	Difficulty int    `json:"difficulty"`
	Count      int    `json:"count"`
	// ExpiresAt is when the server stops accepting a solution (5 minutes).
	ExpiresAt time.Time `json:"expires_at"`
}

// Solve finds one decimal nonce per sub-puzzle i in 0..Count-1 such that
// SHA-256 of "<challenge>.<i>.<nonce>" starts with Difficulty zero bits.
// The prefix is hashed once per sub-puzzle and each attempt hashes only the
// digits after it. It returns ctx's error when ctx ends first.
func Solve(ctx context.Context, challenge Challenge) ([]string, error) {
	if err := checkSolvable(challenge); err != nil {
		return nil, err
	}
	nonces := make([]string, 0, challenge.Count)
	for i := range challenge.Count {
		nonce, err := solveOne(ctx, challenge.Challenge, i, challenge.Difficulty)
		if err != nil {
			return nil, err
		}
		nonces = append(nonces, nonce)
	}
	return nonces, nil
}

func checkSolvable(challenge Challenge) error {
	if challenge.Algorithm != Algorithm {
		return fmt.Errorf("%w: unsupported algorithm %q", ErrUnsolvable, challenge.Algorithm)
	}
	difficulty, count := challenge.Difficulty, challenge.Count
	if difficulty < 0 || difficulty > 32 || count < 1 || count > 64 {
		return fmt.Errorf("%w: invalid parameters (difficulty %d, count %d)", ErrUnsolvable, difficulty, count)
	}
	// count x 2^difficulty > 2^MaxWorkBits, with log2(count) rounded up, which
	// for whole numbers draws the same line as the exact logarithm.
	if difficulty+bits.Len(uint(count-1)) > MaxWorkBits {
		return fmt.Errorf("%w: refusing more than 2^%d hashes (difficulty %d x %d)", ErrUnsolvable, MaxWorkBits, difficulty, count)
	}
	return nil
}

func solveOne(ctx context.Context, challenge string, index, difficulty int) (string, error) {
	h := sha256.New()
	h.Write([]byte(challenge + "." + strconv.Itoa(index) + "."))
	// The digest state after the prefix, restored before each attempt: about
	// twice as fast as hashing the whole string, with no allocation.
	state, err := h.(encoding.BinaryMarshaler).MarshalBinary()
	if err != nil {
		return "", err
	}
	restore := h.(encoding.BinaryUnmarshaler)
	var digits [20]byte
	var sum [sha256.Size]byte
	for nonce := uint64(0); nonce <= maxNonce; nonce++ {
		if nonce&0xffff == 0 && ctx.Err() != nil {
			return "", ctx.Err()
		}
		if err := restore.UnmarshalBinary(state); err != nil {
			return "", err
		}
		text := strconv.AppendUint(digits[:0], nonce, 10)
		h.Write(text)
		if leadingZeroBits(h.Sum(sum[:0]), difficulty) {
			return string(text), nil
		}
	}
	return "", fmt.Errorf("%w: no nonce of 16 digits or fewer", ErrUnsolvable)
}

// leadingZeroBits reports whether digest starts with n zero bits.
func leadingZeroBits(digest []byte, n int) bool {
	full := n / 8
	for _, b := range digest[:full] {
		if b != 0 {
			return false
		}
	}
	rest := n % 8
	return rest == 0 || digest[full]>>(8-rest) == 0
}
