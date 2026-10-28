package agent

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"

	"webhooks.cc/go/internal/conformance"
)

// checkNonces is the server's check, written plainly: each nonce is decimal,
// at most 16 digits, and SHA-256 of "<challenge>.<i>.<nonce>" starts with
// difficulty zero bits.
func checkNonces(challenge string, difficulty int, nonces []string) bool {
	for i, nonce := range nonces {
		if len(nonce) == 0 || len(nonce) > 16 {
			return false
		}
		if _, err := strconv.ParseUint(nonce, 10, 64); err != nil {
			return false
		}
		sum := sha256.Sum256([]byte(challenge + "." + strconv.Itoa(i) + "." + nonce))
		for bit := range difficulty {
			if sum[bit/8]&(0x80>>(bit%8)) != 0 {
				return false
			}
		}
	}
	return true
}

// powVectors reads the server's proof-of-work vectors from the web app.
func powVectors(t *testing.T) []struct {
	Challenge  string   `json:"challenge"`
	Difficulty int      `json:"difficulty"`
	Count      int      `json:"count"`
	Nonces     []string `json:"nonces"`
} {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(file), "..", "..", "..", "apps", "web", "lib", "agent", "pow-vectors.json")
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) && !conformance.Required() {
		t.Skipf("proof-of-work vectors not found (%v); run the tests from the webhooks-cc repository", err)
	}
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Vectors []struct {
			Challenge  string   `json:"challenge"`
			Difficulty int      `json:"difficulty"`
			Count      int      `json:"count"`
			Nonces     []string `json:"nonces"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(data, &doc); err != nil || len(doc.Vectors) == 0 {
		t.Fatalf("pow-vectors.json: %v", err)
	}
	return doc.Vectors
}

func TestSolveMatchesTheServerVectors(t *testing.T) {
	for _, vector := range powVectors(t) {
		if !checkNonces(vector.Challenge, vector.Difficulty, vector.Nonces) {
			t.Fatalf("the checker refuses the vector's own nonces for difficulty %d", vector.Difficulty)
		}
		nonces, err := Solve(t.Context(), Challenge{
			Challenge:  vector.Challenge,
			Algorithm:  Algorithm,
			Difficulty: vector.Difficulty,
			Count:      vector.Count,
		})
		if err != nil {
			t.Fatal(err)
		}
		// The solver counts up from 0, so it finds the smallest nonces, as
		// the server's reference solver did.
		if len(nonces) != len(vector.Nonces) {
			t.Fatalf("difficulty %d: %d nonces, want %d", vector.Difficulty, len(nonces), len(vector.Nonces))
		}
		for i := range nonces {
			if nonces[i] != vector.Nonces[i] {
				t.Errorf("difficulty %d, puzzle %d: nonce %s, want %s", vector.Difficulty, i, nonces[i], vector.Nonces[i])
			}
		}
	}
}

func TestSolveFindsValidNonces(t *testing.T) {
	// A challenge longer than one SHA-256 block, so the saved state holds
	// whole blocks as well as leftover bytes.
	challenge := "pow1." + "eyJ2IjoxLCJpZCI6ImFiYyIsImlhdCI6MSwiZXhwIjoyLCJkIjoxMiwibiI6NCwiYXVkIjoiaHR0cHM6Ly93ZWJob29rcy5jYyJ9" + ".mac-mac-mac-mac-mac-mac-mac-mac-mac-mac-mac"
	for _, difficulty := range []int{0, 1, 7, 8, 9, 14} {
		nonces, err := Solve(t.Context(), Challenge{Challenge: challenge, Algorithm: Algorithm, Difficulty: difficulty, Count: 4})
		if err != nil {
			t.Fatal(err)
		}
		if len(nonces) != 4 || !checkNonces(challenge, difficulty, nonces) {
			t.Errorf("difficulty %d: nonces %v do not check out", difficulty, nonces)
		}
	}
}

func TestSolveRefusesBadChallenges(t *testing.T) {
	cases := []Challenge{
		{Challenge: "x", Algorithm: "sha1-zero-bits", Difficulty: 1, Count: 1},
		{Challenge: "x", Algorithm: Algorithm, Difficulty: -1, Count: 1},
		{Challenge: "x", Algorithm: Algorithm, Difficulty: 33, Count: 1},
		{Challenge: "x", Algorithm: Algorithm, Difficulty: 4, Count: 0},
		{Challenge: "x", Algorithm: Algorithm, Difficulty: 4, Count: 65},
		{Challenge: "x", Algorithm: Algorithm, Difficulty: 27, Count: 1},
		{Challenge: "x", Algorithm: Algorithm, Difficulty: 22, Count: 17}, // 2^22 x 17 > 2^26
		{Challenge: "x", Algorithm: Algorithm, Difficulty: 21, Count: 33},
	}
	for _, c := range cases {
		if _, err := Solve(t.Context(), c); !errors.Is(err, ErrUnsolvable) {
			t.Errorf("Solve(%+v) = %v, want ErrUnsolvable", c, err)
		}
	}
	// Right at the limit is accepted (checked without solving).
	for _, c := range []Challenge{
		{Algorithm: Algorithm, Difficulty: 26, Count: 1},
		{Algorithm: Algorithm, Difficulty: 22, Count: 16},
		{Algorithm: Algorithm, Difficulty: 21, Count: 32},
		{Algorithm: Algorithm, Difficulty: 20, Count: 64},
	} {
		if err := checkSolvable(c); err != nil {
			t.Errorf("checkSolvable(%+v) = %v", c, err)
		}
	}
}

func TestSolveStopsWithTheContext(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := Solve(ctx, Challenge{Challenge: "never", Algorithm: Algorithm, Difficulty: 26, Count: 1})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the context's", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("Solve took %s to notice the context", elapsed)
	}
}

func BenchmarkSolveAttempt(b *testing.B) {
	challenge := Challenge{Challenge: "pow1.eyJ2IjoxLCJpZCI6ImJlbmNoIn0.mac", Algorithm: Algorithm, Difficulty: 16, Count: 1}
	for i := 0; i < b.N; i++ {
		challenge.Challenge = "pow1.bench." + strconv.Itoa(i)
		if _, err := Solve(context.Background(), challenge); err != nil {
			b.Fatal(err)
		}
	}
}
