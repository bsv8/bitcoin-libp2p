// Command host demonstrates a Go libp2p host whose private key lives in the
// sibling signer process. The JSONL channel below is Demo-only teaching code,
// not a bitcoin-libp2p signer standard or production RPC.
package main

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/bsv8/bitcoin-libp2p/golibp2p"
	"github.com/bsv8/bitcoin-libp2p/identity"
	"github.com/bsv8/bitcoin-libp2p/signer"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	ma "github.com/multiformats/go-multiaddr"
)

const (
	helloProtocol = protocol.ID("/bitcoin-libp2p/demo/hello/1.0.0")
	maxMessage    = 1 << 10
)

type readyEvent struct {
	Event                 string `json:"event"`
	Demo                  string `json:"demo"`
	Language              string `json:"language"`
	PeerID                string `json:"peerId"`
	PublicKey             string `json:"publicKey"`
	Address               string `json:"address"`
	Protocol              string `json:"protocol"`
	HostPID               int    `json:"hostPid"`
	SignerPID             int    `json:"signerPid"`
	SignerRequests        uint64 `json:"signerRequests"`
	SignerNoiseRequests   uint64 `json:"signerNoiseRequests"`
	PendingSignerRequests int    `json:"pendingSignerRequests"`
}

type helloEvent struct {
	Event                     string `json:"event"`
	Demo                      string `json:"demo"`
	Language                  string `json:"language"`
	RemotePeerID              string `json:"remotePeerId"`
	RemotePublicKey           string `json:"remotePublicKey"`
	RemoteAddress             string `json:"remoteAddress"`
	AddressPeerID             string `json:"addressPeerId"`
	Request                   string `json:"request"`
	Response                  string `json:"response"`
	Streams                   int    `json:"streams"`
	HostPID                   int    `json:"hostPid"`
	SignerPID                 int    `json:"signerPid"`
	SignerRequests            uint64 `json:"signerRequests"`
	SignerNoiseRequestsBefore uint64 `json:"signerNoiseRequestsBefore"`
	SignerNoiseRequests       uint64 `json:"signerNoiseRequests"`
	PendingSignerRequests     int    `json:"pendingSignerRequests"`
}

type lifecycleEvent struct {
	Event                 string `json:"event"`
	Error                 string `json:"error,omitempty"`
	HostPID               int    `json:"hostPid"`
	SignerPID             int    `json:"signerPid"`
	SignerRequests        uint64 `json:"signerRequests"`
	SignerNoiseRequests   uint64 `json:"signerNoiseRequests"`
	PendingSignerRequests int    `json:"pendingSignerRequests"`
}

type signerRequest struct {
	ID           uint64   `json:"id"`
	Purpose      string   `json:"purpose"`
	StaticKeyHex string   `json:"staticKeyHex,omitempty"`
	PeerID       string   `json:"peerId,omitempty"`
	Addresses    []string `json:"addresses,omitempty"`
	Sequence     string   `json:"sequence,omitempty"`
}

type signerResponse struct {
	ID            uint64 `json:"id"`
	OK            bool   `json:"ok"`
	SignatureDER  string `json:"signatureDer,omitempty"`
	Error         string `json:"error,omitempty"`
	Requests      uint64 `json:"requests,omitempty"`
	NoiseRequests uint64 `json:"noiseRequests,omitempty"`
}

type signerReady struct {
	Event     string `json:"event"`
	PublicKey string `json:"publicKey"`
	PID       int    `json:"pid"`
}

type processSigner struct {
	child     *exec.Cmd
	input     io.WriteCloser
	publicKey []byte
	peerID    peer.ID
	done      chan struct{}
	pendingMu sync.Mutex
	pending   map[uint64]chan signerResponse
	writeMu   sync.Mutex
	nextID    atomic.Uint64
	requests  uint64
	noiseReqs uint64
	closeOnce sync.Once
	doneOnce  sync.Once
	closed    bool
}

var _ signer.Signer = (*processSigner)(nil)

func main() {
	if err := run(); err != nil {
		fatal(err)
	}
}

func run() (runErr error) {
	mode := flag.String("mode", "server", "server or client")
	listenValue := flag.String("listen", "", "server listen multiaddr; defaults to a random loopback TCP port")
	dialValue := flag.String("dial", "", "client peer multiaddr")
	message := flag.String("message", "hello", "client UTF-8 message")
	expectedPeerID := flag.String("expect-peer-id", "", "optional authenticated remote PeerId pin")
	expectedPublicKey := flag.String("expect-public-key", "", "optional authenticated remote compressed public key pin")
	signerCommand := flag.String("signer-command", "", "path to the Demo signer child executable")
	signerMode := flag.String("signer-mode", "normal", "normal, pending, exit, reject, or wrong-key")
	signTimeoutMS := flag.Int("sign-timeout-ms", 0, "optional signer timeout in milliseconds")
	hostStopAfterMS := flag.Int("host-stop-after-ms", 0, "optional client host stop delay in milliseconds")
	flag.Parse()
	if *mode != "server" && *mode != "client" {
		return errors.New("--mode must be server or client")
	}
	if *signerCommand == "" {
		return errors.New("--signer-command is required; build examples/04-remote-signer/go/signer first")
	}
	remoteSigner, err := startProcessSigner(*signerCommand, *signerMode)
	if err != nil {
		return fmt.Errorf("start signer child: %w", err)
	}
	defer func() {
		remoteSigner.close()
		event := "closed"
		message := ""
		if runErr != nil {
			event = "failure"
			message = runErr.Error()
		}
		if err := emit(lifecycleEvent{
			Event: event, Error: message, HostPID: os.Getpid(), SignerPID: remoteSigner.pid(),
			SignerRequests: remoteSigner.requestCount(), SignerNoiseRequests: remoteSigner.noiseRequestCount(),
			PendingSignerRequests: remoteSigner.pendingCount(),
		}); runErr == nil && err != nil {
			runErr = err
		}
	}()

	var listen []ma.Multiaddr
	if *mode == "server" {
		value := *listenValue
		if value == "" {
			value = "/ip4/127.0.0.1/tcp/0"
		}
		address, err := ma.NewMultiaddr(value)
		if err != nil {
			return fmt.Errorf("parse --listen: %w", err)
		}
		listen = []ma.Multiaddr{address}
	}
	hostConfig := golibp2p.HostConfig{
		Signer:      remoteSigner,
		ListenAddrs: listen,
		Services:    []golibp2p.Service{installHello},
	}
	if *signTimeoutMS > 0 {
		hostConfig.SignTimeout = time.Duration(*signTimeoutMS) * time.Millisecond
	}
	h, err := golibp2p.NewHost(hostConfig)
	if err != nil {
		return fmt.Errorf("create host: %w", err)
	}
	defer h.Close()
	ctx, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()

	if *mode == "server" {
		if len(h.Addrs()) == 0 {
			return errors.New("host did not listen")
		}
		id := h.ID()
		address := h.Addrs()[0].Encapsulate(mustMultiaddr("/p2p/" + id.String()))
		if err := emit(readyEvent{
			Event: "ready", Demo: "go-remote-signer", Language: "go", PeerID: id.String(),
			PublicKey: hex.EncodeToString(remoteSigner.PublicKey()), Address: address.String(), Protocol: string(helloProtocol),
			HostPID: os.Getpid(), SignerPID: remoteSigner.pid(), SignerRequests: remoteSigner.requestCount(),
			SignerNoiseRequests: remoteSigner.noiseRequestCount(), PendingSignerRequests: remoteSigner.pendingCount(),
		}); err != nil {
			return err
		}
		waitForStop(ctx)
		return nil
	}

	if *dialValue == "" {
		return errors.New("--dial is required in client mode")
	}
	if err := checkMessage(*message); err != nil {
		return err
	}
	dialAddress, err := ma.NewMultiaddr(*dialValue)
	if err != nil {
		return fmt.Errorf("parse --dial: %w", err)
	}
	info, err := peer.AddrInfoFromP2pAddr(dialAddress)
	if err != nil {
		return fmt.Errorf("parse --dial peer: %w", err)
	}
	workCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	if *hostStopAfterMS > 0 {
		time.AfterFunc(time.Duration(*hostStopAfterMS)*time.Millisecond, func() {
			cancel()
			_ = h.Close()
		})
	}
	noiseRequestsBefore := remoteSigner.noiseRequestCount()
	dialCtx, dialCancel := context.WithTimeout(workCtx, 15*time.Second)
	defer dialCancel()
	if err := h.Connect(dialCtx, *info); err != nil {
		return fmt.Errorf("dial peer: %w", err)
	}
	connections := h.Network().ConnsToPeer(info.ID)
	if len(connections) == 0 {
		return errors.New("dial completed without a connection")
	}
	h.Peerstore().RemoveProtocols(info.ID, helloProtocol)
	pin, err := optionalPin(*expectedPeerID, *expectedPublicKey)
	if err != nil {
		return err
	}
	authenticated, err := golibp2p.AuthenticatedPeerFromConn(connections[0], pin)
	if err != nil {
		return fmt.Errorf("authenticate remote connection: %w", err)
	}
	if err := checkSinglePins(authenticated, *expectedPeerID, *expectedPublicKey); err != nil {
		return err
	}
	request := []byte(*message)
	for range 2 {
		response, err := roundTrip(dialCtx, h, info.ID, request)
		if err != nil {
			return fmt.Errorf("hello stream: %w", err)
		}
		if string(response) != "hello, "+*message {
			return fmt.Errorf("unexpected Hello response %q", string(response))
		}
	}
	return emit(helloEvent{
		Event: "hello", Demo: "go-remote-signer", Language: "go", RemotePeerID: authenticated.PeerID.String(),
		RemotePublicKey: hex.EncodeToString(authenticated.PublicKey), RemoteAddress: dialAddress.String(), AddressPeerID: info.ID.String(),
		Request: *message, Response: "hello, " + *message, Streams: 2, HostPID: os.Getpid(), SignerPID: remoteSigner.pid(),
		SignerNoiseRequestsBefore: noiseRequestsBefore,
		SignerRequests:            remoteSigner.requestCount(), SignerNoiseRequests: remoteSigner.noiseRequestCount(), PendingSignerRequests: remoteSigner.pendingCount(),
	})
}

func startProcessSigner(command, mode string) (*processSigner, error) {
	child := exec.Command(command, "--mode", mode)
	input, err := child.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := child.StdoutPipe()
	if err != nil {
		_ = input.Close()
		return nil, err
	}
	stderr, err := child.StderrPipe()
	if err != nil {
		_ = input.Close()
		return nil, err
	}
	if err := child.Start(); err != nil {
		_ = input.Close()
		return nil, err
	}
	go func() { _, _ = io.Copy(os.Stderr, stderr) }()
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 1024), 64<<10)
	if !scanner.Scan() {
		waitErr := child.Wait()
		if waitErr != nil {
			return nil, fmt.Errorf("signer child exited before ready: %w", waitErr)
		}
		return nil, errors.New("signer child did not emit ready")
	}
	var ready signerReady
	if err := json.Unmarshal(scanner.Bytes(), &ready); err != nil || ready.Event != "ready" {
		_ = child.Process.Kill()
		_ = child.Wait()
		return nil, errors.New("signer child emitted malformed ready event")
	}
	publicKey, err := hex.DecodeString(ready.PublicKey)
	if err != nil {
		_ = child.Process.Kill()
		_ = child.Wait()
		return nil, errors.New("signer child public key is malformed")
	}
	publicKey, err = identity.PublicKeyBytes(publicKey)
	if err != nil {
		_ = child.Process.Kill()
		_ = child.Wait()
		return nil, err
	}
	id, err := identity.PeerIDFromPublicKey(publicKey)
	if err != nil {
		_ = child.Process.Kill()
		_ = child.Wait()
		return nil, err
	}
	process := &processSigner{
		child: child, input: input, publicKey: publicKey, peerID: id,
		done: make(chan struct{}), pending: make(map[uint64]chan signerResponse),
	}
	go process.readResponses(scanner)
	go func() {
		err := child.Wait()
		process.fail(fmt.Errorf("signer child exited: %v", err))
	}()
	return process, nil
}

func (s *processSigner) readResponses(scanner *bufio.Scanner) {
	for scanner.Scan() {
		var response signerResponse
		if err := json.Unmarshal(scanner.Bytes(), &response); err != nil {
			s.continueWithError(errors.New("signer response was malformed"))
			continue
		}
		s.pendingMu.Lock()
		channel := s.pending[response.ID]
		if channel != nil {
			delete(s.pending, response.ID)
		}
		s.pendingMu.Unlock()
		if channel != nil {
			channel <- response
		}
	}
	if err := scanner.Err(); err != nil {
		s.fail(fmt.Errorf("read signer child: %w", err))
	}
}

func (s *processSigner) continueWithError(err error) {
	s.pendingMu.Lock()
	channels := make([]chan signerResponse, 0, len(s.pending))
	for id, channel := range s.pending {
		delete(s.pending, id)
		channels = append(channels, channel)
	}
	s.pendingMu.Unlock()
	for _, channel := range channels {
		channel <- signerResponse{Error: err.Error()}
	}
}

func (s *processSigner) fail(err error) {
	s.pendingMu.Lock()
	if s.closed {
		s.pendingMu.Unlock()
		return
	}
	s.closed = true
	channels := make([]chan signerResponse, 0, len(s.pending))
	for id, channel := range s.pending {
		delete(s.pending, id)
		channels = append(channels, channel)
	}
	s.pendingMu.Unlock()
	for _, channel := range channels {
		channel <- signerResponse{Error: err.Error()}
	}
	s.doneOnce.Do(func() { close(s.done) })
}

func (s *processSigner) close() {
	s.closeOnce.Do(func() {
		s.fail(errors.New("signer child stopped"))
		_ = s.input.Close()
		if s.child.Process != nil {
			_ = s.child.Process.Kill()
		}
		select {
		case <-s.done:
		case <-time.After(2 * time.Second):
		}
	})
}

func (s *processSigner) PublicKey() []byte { return append([]byte(nil), s.publicKey...) }

func (s *processSigner) SignNoiseStaticKey(ctx context.Context, staticKey []byte) ([]byte, error) {
	if len(staticKey) != 32 {
		return nil, errors.New("Noise static key must be 32 bytes")
	}
	return s.request(ctx, signerRequest{Purpose: "noise-static-key", StaticKeyHex: hex.EncodeToString(staticKey)})
}

func (s *processSigner) SignPeerRecord(ctx context.Context, record signer.PeerRecord) ([]byte, error) {
	if _, err := signer.PeerRecordUnsigned(record, s.peerID); err != nil {
		return nil, err
	}
	addresses := make([]string, len(record.Addresses))
	for index, address := range record.Addresses {
		addresses[index] = address.String()
	}
	return s.request(ctx, signerRequest{
		Purpose: "peer-record", PeerID: record.PeerID.String(), Addresses: addresses, Sequence: fmt.Sprintf("%d", record.Sequence),
	})
}

func (s *processSigner) request(ctx context.Context, input signerRequest) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	input.ID = s.nextID.Add(1)
	result := make(chan signerResponse, 1)
	s.pendingMu.Lock()
	if s.closed {
		s.pendingMu.Unlock()
		return nil, errors.New("signer child is closed")
	}
	s.pending[input.ID] = result
	s.pendingMu.Unlock()
	encoded, err := json.Marshal(input)
	if err == nil {
		s.writeMu.Lock()
		_, err = io.WriteString(s.input, string(encoded)+"\n")
		s.writeMu.Unlock()
	}
	if err != nil {
		s.removePending(input.ID)
		return nil, err
	}
	var response signerResponse
	select {
	case <-ctx.Done():
		s.removePending(input.ID)
		return nil, ctx.Err()
	case response = <-result:
	}
	if !response.OK {
		if response.Error == "" {
			response.Error = "signer rejected request"
		}
		return nil, errors.New(response.Error)
	}
	s.pendingMu.Lock()
	s.requests = response.Requests
	s.noiseReqs = response.NoiseRequests
	s.pendingMu.Unlock()
	signature, err := hex.DecodeString(response.SignatureDER)
	if err != nil {
		return nil, errors.New("signer returned malformed signature")
	}
	return signature, nil
}

func (s *processSigner) removePending(id uint64) {
	s.pendingMu.Lock()
	delete(s.pending, id)
	s.pendingMu.Unlock()
}

func (s *processSigner) pid() int { return s.child.Process.Pid }

func (s *processSigner) requestCount() uint64 {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	return s.requests
}

func (s *processSigner) noiseRequestCount() uint64 {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	return s.noiseReqs
}

func (s *processSigner) pendingCount() int {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	return len(s.pending)
}

func installHello(h host.Host) error {
	h.SetStreamHandler(helloProtocol, func(stream network.Stream) {
		go func() {
			defer stream.Close()
			input, err := io.ReadAll(io.LimitReader(stream, maxMessage+1))
			if err != nil || len(input) == 0 || len(input) > maxMessage || !utf8.Valid(input) {
				_ = stream.Reset()
				return
			}
			if _, err := stream.Write([]byte("hello, " + string(input))); err != nil {
				_ = stream.Reset()
				return
			}
			if err := stream.CloseWrite(); err != nil {
				_ = stream.Reset()
			}
		}()
	})
	return nil
}

func roundTrip(ctx context.Context, h host.Host, id peer.ID, message []byte) ([]byte, error) {
	stream, err := h.NewStream(ctx, id, helloProtocol)
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	if _, err := stream.Write(message); err != nil {
		return nil, err
	}
	if err := stream.CloseWrite(); err != nil {
		return nil, err
	}
	return io.ReadAll(io.LimitReader(stream, int64(maxMessage+len("hello, ")+1)))
}

func checkMessage(message string) error {
	encoded := []byte(message)
	if len(encoded) == 0 || len(encoded) > maxMessage || !utf8.Valid(encoded) {
		return fmt.Errorf("--message must be non-empty valid UTF-8 of at most %d bytes", maxMessage)
	}
	return nil
}

func optionalPin(expectedPeerID, expectedPublicKey string) (*golibp2p.Pin, error) {
	if expectedPeerID == "" || expectedPublicKey == "" {
		return nil, nil
	}
	key, err := hex.DecodeString(strings.TrimSpace(expectedPublicKey))
	if err != nil {
		return nil, fmt.Errorf("--expect-public-key is malformed: %w", err)
	}
	id, err := peer.Decode(expectedPeerID)
	if err != nil {
		return nil, fmt.Errorf("--expect-peer-id is malformed: %w", err)
	}
	pin, err := golibp2p.NewPin(key, id)
	if err != nil {
		return nil, fmt.Errorf("invalid remote pin: %w", err)
	}
	return &pin, nil
}

func checkSinglePins(authenticated golibp2p.AuthenticatedPeer, expectedPeerID, expectedPublicKey string) error {
	if expectedPeerID != "" && authenticated.PeerID.String() != expectedPeerID {
		return golibp2p.ErrPinMismatch
	}
	if expectedPublicKey != "" {
		expected, err := hex.DecodeString(strings.TrimSpace(expectedPublicKey))
		if err != nil {
			return fmt.Errorf("--expect-public-key is malformed: %w", err)
		}
		if !equalBytes(expected, authenticated.PublicKey) {
			return golibp2p.ErrPinMismatch
		}
	}
	return nil
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func waitForStop(ctx context.Context) {
	stdinDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		close(stdinDone)
	}()
	select {
	case <-ctx.Done():
	case <-stdinDone:
	}
}

func emit(value any) error { return json.NewEncoder(os.Stdout).Encode(value) }

func mustMultiaddr(value string) ma.Multiaddr {
	address, err := ma.NewMultiaddr(value)
	if err != nil {
		panic(err)
	}
	return address
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "fatal: %s\n", strings.TrimSpace(err.Error()))
	os.Exit(1)
}
