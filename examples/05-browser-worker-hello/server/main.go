// Command native-go-hello is the independent native libp2p receiver used by
// the browser example and the native interop example. It deliberately does
// not import github.com/bsv8/bitcoin-libp2p.
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

	libp2p "github.com/libp2p/go-libp2p"
	libp2pcrypto "github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	"github.com/libp2p/go-libp2p/p2p/muxer/yamux"
	"github.com/libp2p/go-libp2p/p2p/security/noise"
	libp2ptcp "github.com/libp2p/go-libp2p/p2p/transport/tcp"
	libp2pwebrtc "github.com/libp2p/go-libp2p/p2p/transport/webrtc"
	libp2pwebsocket "github.com/libp2p/go-libp2p/p2p/transport/websocket"
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
	Transport string `json:"transport"`
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
	listenValue := flag.String("listen", "", "server listen multiaddr")
	dialValue := flag.String("dial", "", "client peer multiaddr")
	keyValue := flag.String("key", "", "optional TEST-ONLY private key hex; never printed")
	transportValue := flag.String("transport", "websocket", "tcp, websocket, or webrtc-direct")
	flag.Parse()
	if *mode != "server" && *mode != "client" {
		return errors.New("--mode must be server or client")
	}
	privateKey, err := loadPrivateKey(*keyValue)
	if err != nil {
		return err
	}

	options := []libp2p.Option{
		libp2p.Identity(privateKey),
		libp2p.Security(noise.ID, noise.New),
		libp2p.Muxer(yamux.ID, yamux.DefaultTransport),
	}
	listenValueDefault := *listenValue
	if *mode == "server" && listenValueDefault == "" {
		switch *transportValue {
		case "tcp":
			listenValueDefault = "/ip4/127.0.0.1/tcp/0"
		case "websocket":
			listenValueDefault = "/ip4/127.0.0.1/tcp/0/ws"
		case "webrtc-direct":
			listenValueDefault = "/ip4/127.0.0.1/udp/0/webrtc-direct"
		default:
			return fmt.Errorf("unsupported --transport %q", *transportValue)
		}
	}
	if err := addTransportOptions(&options, *transportValue); err != nil {
		return err
	}
	if *mode == "server" {
		listen, err := ma.NewMultiaddr(listenValueDefault)
		if err != nil {
			return fmt.Errorf("parse --listen: %w", err)
		}
		options = append(options, libp2p.ListenAddrs(listen))
	}
	h, err := libp2p.New(options...)
	if err != nil {
		return fmt.Errorf("create native libp2p host: %w", err)
	}
	defer h.Close()
	ctx, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()

	if *mode == "server" {
		installHello(h)
		if len(h.Addrs()) == 0 {
			return errors.New("native host did not listen")
		}
		id := h.ID()
		address := h.Addrs()[0].Encapsulate(mustMultiaddr("/p2p/" + id.String()))
		return emitAndWait(readyEvent{
			Event: "ready", Demo: "native-go-hello", Language: "go", PeerID: id.String(),
			PublicKey: hex.EncodeToString(publicKeyBytes(privateKey)), Address: address.String(),
			Protocol: string(helloProtocol), Transport: *transportValue,
		}, ctx)
	}

	if *dialValue == "" {
		return errors.New("--dial is required in client mode")
	}
	remoteAddress, err := ma.NewMultiaddr(*dialValue)
	if err != nil {
		return fmt.Errorf("parse --dial: %w", err)
	}
	info, err := peer.AddrInfoFromP2pAddr(remoteAddress)
	if err != nil {
		return fmt.Errorf("parse --dial peer: %w", err)
	}
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := h.Connect(dialCtx, *info); err != nil {
		return fmt.Errorf("dial peer: %w", err)
	}
	connections := h.Network().ConnsToPeer(info.ID)
	if len(connections) == 0 || connections[0].RemotePublicKey() == nil {
		return errors.New("dial completed without an authenticated connection")
	}
	remoteKey, err := connections[0].RemotePublicKey().Raw()
	if err != nil {
		return fmt.Errorf("read authenticated remote public key: %w", err)
	}
	message := []byte("hello from native Go")
	for range 2 {
		response, err := roundTrip(dialCtx, h, info.ID, message)
		if err != nil || string(response) != "hello, "+string(message) {
			return fmt.Errorf("Hello stream failed: %w", err)
		}
	}
	return emit(helloEvent{
		Event: "hello", Demo: "native-go-hello", Language: "go", RemotePeerID: info.ID.String(),
		RemotePublicKey: hex.EncodeToString(remoteKey), RemoteAddress: remoteAddress.String(),
		AddressPeerID: info.ID.String(), Request: string(message), Response: "hello, " + string(message), Streams: 2,
	})
}

func addTransportOptions(options *[]libp2p.Option, name string) error {
	switch name {
	case "tcp":
		*options = append(*options, libp2p.Transport(libp2ptcp.NewTCPTransport))
	case "websocket":
		*options = append(*options, libp2p.Transport(libp2pwebsocket.New))
	case "webrtc-direct":
		*options = append(*options, libp2p.Transport(libp2pwebrtc.New))
	default:
		return fmt.Errorf("unsupported --transport %q", name)
	}
	return nil
}

func loadPrivateKey(value string) (libp2pcrypto.PrivKey, error) {
	if value != "" {
		raw, err := hex.DecodeString(value)
		if err != nil {
			return nil, fmt.Errorf("parse --key: %w", err)
		}
		key, err := libp2pcrypto.UnmarshalSecp256k1PrivateKey(raw)
		if err != nil {
			return nil, fmt.Errorf("parse --key: %w", err)
		}
		return key, nil
	}
	for {
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return nil, fmt.Errorf("generate native identity: %w", err)
		}
		key, err := libp2pcrypto.UnmarshalSecp256k1PrivateKey(raw)
		if err == nil {
			return key, nil
		}
	}
}

func installHello(h host.Host) {
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
			_ = stream.CloseWrite()
		}()
	})
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

func emitAndWait(value readyEvent, ctx context.Context) error {
	if err := emit(value); err != nil {
		return err
	}
	stdinDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		close(stdinDone)
	}()
	select {
	case <-ctx.Done():
	case <-stdinDone:
	}
	return nil
}

func publicKeyBytes(key libp2pcrypto.PrivKey) []byte {
	raw, err := key.GetPublic().Raw()
	if err != nil {
		fatal(err)
	}
	return raw
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
