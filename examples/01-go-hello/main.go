// Command go-hello is the smallest Go SDK application example. The Hello
// protocol belongs to this application; the SDK only assembles standard
// libp2p identity, Noise, Identify and Yamux.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
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
	Event     string `json:"event"`
	Demo      string `json:"demo"`
	Language  string `json:"language"`
	PeerID    string `json:"peerId"`
	PublicKey string `json:"publicKey"`
	Address   string `json:"address"`
	Protocol  string `json:"protocol"`
}

type helloEvent struct {
	Event           string `json:"event"`
	Demo            string `json:"demo"`
	Language        string `json:"language"`
	RemotePeerID    string `json:"remotePeerId"`
	RemotePublicKey string `json:"remotePublicKey"`
	RemoteAddress   string `json:"remoteAddress"`
	AddressPeerID   string `json:"addressPeerId"`
	Request         string `json:"request"`
	Response        string `json:"response"`
	Streams         int    `json:"streams"`
}

func main() {
	if err := run(); err != nil {
		fatal(err)
	}
}

func run() error {
	mode := flag.String("mode", "server", "server or client")
	listenValue := flag.String("listen", "", "server listen multiaddr; defaults to a random loopback TCP port")
	dialValue := flag.String("dial", "", "client peer multiaddr")
	message := flag.String("message", "hello", "client UTF-8 message")
	expectedPeerID := flag.String("expect-peer-id", "", "optional authenticated remote PeerId pin")
	expectedPublicKey := flag.String("expect-public-key", "", "optional authenticated remote compressed public key pin")
	flag.Parse()
	if *mode != "server" && *mode != "client" {
		return fmt.Errorf("--mode must be server or client")
	}

	// LocalSigner is intentionally used only for this short-lived Demo/test
	// identity. A production host should not copy its business private key;
	// Demo 04 shows the typed signer boundary with a separate process.
	localSigner, err := newDemoSigner()
	if err != nil {
		return err
	}

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

	h, err := golibp2p.NewHost(golibp2p.HostConfig{
		Signer:      localSigner,
		ListenAddrs: listen,
		Services:    []golibp2p.Service{installHello},
	})
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
			Event: "ready", Demo: "go-hello", Language: "go", PeerID: id.String(),
			PublicKey: hex.EncodeToString(localSigner.PublicKey()), Address: address.String(), Protocol: string(helloProtocol),
		}); err != nil {
			return err
		}
		waitForStop(ctx)
		return nil
	}

	if *dialValue == "" {
		return errors.New("--dial is required in client mode")
	}
	dialAddress, err := ma.NewMultiaddr(*dialValue)
	if err != nil {
		return fmt.Errorf("parse --dial: %w", err)
	}
	info, err := peer.AddrInfoFromP2pAddr(dialAddress)
	if err != nil {
		return fmt.Errorf("parse --dial peer: %w", err)
	}
	if err := checkMessage(*message); err != nil {
		return err
	}

	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := h.Connect(dialCtx, *info); err != nil {
		return fmt.Errorf("dial peer: %w", err)
	}
	connections := h.Network().ConnsToPeer(info.ID)
	if len(connections) == 0 {
		return errors.New("dial completed without a connection")
	}
	// Identify may advertise the application protocol before the first stream.
	// Removing that hint exercises the standard multistream-select path and
	// keeps this readable example interoperable with native libp2p peers.
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
		expected := "hello, " + *message
		if string(response) != expected {
			return fmt.Errorf("unexpected Hello response %q", string(response))
		}
	}
	if err := emit(helloEvent{
		Event: "hello", Demo: "go-hello", Language: "go", RemotePeerID: authenticated.PeerID.String(),
		RemotePublicKey: hex.EncodeToString(authenticated.PublicKey), RemoteAddress: dialAddress.String(),
		AddressPeerID: info.ID.String(), Request: *message, Response: "hello, " + *message, Streams: 2,
	}); err != nil {
		return err
	}
	return nil
}

func newDemoSigner() (*signer.LocalSigner, error) {
	raw := make([]byte, 32)
	for {
		if _, err := rand.Read(raw); err != nil {
			return nil, fmt.Errorf("generate temporary identity: %w", err)
		}
		local, err := signer.NewLocalSigner(raw)
		if err == nil {
			return local, nil
		}
		if !errors.Is(err, identity.ErrInvalidPrivateKey) {
			return nil, fmt.Errorf("create temporary identity: %w", err)
		}
	}
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
		if hex.EncodeToString(expected) != hex.EncodeToString(authenticated.PublicKey) {
			return golibp2p.ErrPinMismatch
		}
	}
	return nil
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

func emit(value any) error {
	return json.NewEncoder(os.Stdout).Encode(value)
}

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
