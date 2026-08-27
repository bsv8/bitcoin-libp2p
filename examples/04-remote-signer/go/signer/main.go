// Command signer is a teaching-only typed signer child process. Its JSONL
// channel is local to this Demo and is not a bitcoin-libp2p RPC protocol.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/bsv8/bitcoin-libp2p/identity"
	"github.com/bsv8/bitcoin-libp2p/signer"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
)

type readyMessage struct {
	Event     string `json:"event"`
	PublicKey string `json:"publicKey"`
	PID       int    `json:"pid"`
}

type request struct {
	ID           uint64   `json:"id"`
	Purpose      string   `json:"purpose"`
	StaticKeyHex string   `json:"staticKeyHex,omitempty"`
	PeerID       string   `json:"peerId,omitempty"`
	Addresses    []string `json:"addresses,omitempty"`
	Sequence     string   `json:"sequence,omitempty"`
}

type response struct {
	ID            uint64 `json:"id"`
	OK            bool   `json:"ok"`
	SignatureDER  string `json:"signatureDer,omitempty"`
	Error         string `json:"error,omitempty"`
	Requests      uint64 `json:"requests,omitempty"`
	NoiseRequests uint64 `json:"noiseRequests,omitempty"`
}

func main() {
	mode := flag.String("mode", "normal", "normal, pending, exit, reject, or wrong-key")
	flag.Parse()
	if err := run(*mode); err != nil {
		fmt.Fprintf(os.Stderr, "signer: %s\n", err)
		os.Exit(1)
	}
}

func run(mode string) error {
	if mode != "normal" && mode != "pending" && mode != "exit" && mode != "reject" && mode != "wrong-key" {
		return fmt.Errorf("unsupported signer mode %q", mode)
	}
	local, err := randomSigner()
	if err != nil {
		return err
	}
	wrong, err := randomSigner()
	if err != nil {
		return err
	}
	if err := json.NewEncoder(os.Stdout).Encode(readyMessage{
		Event: "ready", PublicKey: hex.EncodeToString(local.PublicKey()), PID: os.Getpid(),
	}); err != nil {
		return err
	}

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024), 64<<10)
	var requests uint64
	var noiseRequests uint64
	for scanner.Scan() {
		var input request
		if err := json.Unmarshal(scanner.Bytes(), &input); err != nil {
			if err := emit(response{OK: false, Error: "malformed signer request"}); err != nil {
				return err
			}
			continue
		}
		requests++
		if input.Purpose == "noise-static-key" {
			noiseRequests++
		}
		if mode == "pending" {
			// The host's bounded Context and close path must end this wait; the
			// parent then terminates this deliberately stuck teaching child.
			select {}
		}
		if mode == "exit" {
			os.Exit(42)
		}
		if mode == "reject" {
			if err := emit(response{ID: input.ID, Error: "teaching signer rejected request", Requests: requests, NoiseRequests: noiseRequests}); err != nil {
				return err
			}
			continue
		}
		active := local
		if mode == "wrong-key" {
			active = wrong
		}
		signature, err := signRequest(active, input)
		if err != nil {
			if err := emit(response{ID: input.ID, Error: err.Error(), Requests: requests, NoiseRequests: noiseRequests}); err != nil {
				return err
			}
			continue
		}
		if err := emit(response{
			ID: input.ID, OK: true, SignatureDER: hex.EncodeToString(signature),
			Requests: requests, NoiseRequests: noiseRequests,
		}); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func randomSigner() (*signer.LocalSigner, error) {
	for {
		raw := make([]byte, 32)
		if _, err := io.ReadFull(rand.Reader, raw); err != nil {
			return nil, fmt.Errorf("generate signer key: %w", err)
		}
		local, err := signer.NewLocalSigner(raw)
		if err == nil {
			return local, nil
		}
		if !errors.Is(err, identity.ErrInvalidPrivateKey) && !strings.Contains(err.Error(), "invalid secp256k1 private key") {
			return nil, err
		}
	}
}

func signRequest(active *signer.LocalSigner, input request) ([]byte, error) {
	switch input.Purpose {
	case "noise-static-key":
		staticKey, err := hex.DecodeString(input.StaticKeyHex)
		if err != nil || len(staticKey) != 32 {
			return nil, errors.New("Noise static key must be 32 bytes of hex")
		}
		return active.SignNoiseStaticKey(context.Background(), staticKey)
	case "peer-record":
		id, err := peer.Decode(input.PeerID)
		if err != nil {
			return nil, errors.New("peer record PeerId is malformed")
		}
		addresses := make([]ma.Multiaddr, len(input.Addresses))
		for index, value := range input.Addresses {
			addresses[index], err = ma.NewMultiaddr(value)
			if err != nil {
				return nil, errors.New("peer record address is malformed")
			}
		}
		sequence, err := parseSequence(input.Sequence)
		if err != nil {
			return nil, err
		}
		return active.SignPeerRecord(context.Background(), signer.PeerRecord{PeerID: id, Addresses: addresses, Sequence: sequence})
	default:
		return nil, errors.New("unsupported signer purpose")
	}
}

func parseSequence(value string) (uint64, error) {
	var sequence uint64
	if value == "" {
		return 0, errors.New("peer record sequence is missing")
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return 0, errors.New("peer record sequence is malformed")
		}
		next := sequence*10 + uint64(char-'0')
		if next < sequence {
			return 0, errors.New("peer record sequence is too large")
		}
		sequence = next
	}
	return sequence, nil
}

func emit(value response) error {
	return json.NewEncoder(os.Stdout).Encode(value)
}
