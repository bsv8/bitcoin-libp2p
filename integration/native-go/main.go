// Command native-go is the standard-libp2p control endpoint. It deliberately
// does not import github.com/bsv8/bitcoin-libp2p.
package main

import (
	"context"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	libp2p "github.com/libp2p/go-libp2p"
	libp2pcrypto "github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	"github.com/libp2p/go-libp2p/p2p/muxer/yamux"
	"github.com/libp2p/go-libp2p/p2p/security/noise"
	libp2pwebrtc "github.com/libp2p/go-libp2p/p2p/transport/webrtc"
	libp2pwebsocket "github.com/libp2p/go-libp2p/p2p/transport/websocket"
	ma "github.com/multiformats/go-multiaddr"
)

const defaultKey = "0000000000000000000000000000000000000000000000000000000000000001"

func main() {
	mode := flag.String("mode", "server", "server or client")
	address := flag.String("addr", "", "peer multiaddr for client mode")
	keyHex := flag.String("key", defaultKey, "TEST-ONLY private key; never printed")
	transportName := flag.String("transport", "tcp", "tcp, websocket, or webrtc-direct")
	flag.Parse()
	raw, err := hex.DecodeString(*keyHex)
	if err != nil {
		fatal(err)
	}
	privateKey, err := libp2pcrypto.UnmarshalSecp256k1PrivateKey(raw)
	if err != nil {
		fatal(err)
	}
	options := []libp2p.Option{
		libp2p.Identity(privateKey),
		libp2p.Security(noise.ID, noise.New),
		libp2p.Muxer(yamux.ID, yamux.DefaultTransport),
	}
	listenValue := "/ip4/127.0.0.1/tcp/0"
	switch *transportName {
	case "websocket":
		listenValue = "/ip4/127.0.0.1/tcp/0/ws"
		options = append(options, libp2p.Transport(libp2pwebsocket.New))
	case "webrtc-direct":
		listenValue = "/ip4/127.0.0.1/udp/0/webrtc-direct"
		options = append(options, libp2p.Transport(libp2pwebrtc.New))
	case "tcp":
		// The default libp2p transport set includes TCP.
	default:
		fatal(fmt.Errorf("unsupported transport %q", *transportName))
	}
	if *mode == "server" {
		listen, err := ma.NewMultiaddr(listenValue)
		if err != nil {
			fatal(err)
		}
		options = append(options, libp2p.ListenAddrs(listen))
	}
	h, err := libp2p.New(options...)
	if err != nil {
		fatal(err)
	}
	defer h.Close()
	if *mode == "server" {
		installEcho(h)
		if len(h.Addrs()) == 0 {
			fatal(fmt.Errorf("host did not listen"))
		}
		fmt.Printf("READY %s %s %s\n", h.ID(), h.Addrs()[0].Encapsulate(mustAddr("/p2p/"+h.ID().String())), hex.EncodeToString(rawPublicKey(privateKey)))
		_, _ = io.Copy(io.Discard, os.Stdin)
		return
	}
	if *address == "" {
		fatal(fmt.Errorf("-addr is required in client mode"))
	}
	remote, err := ma.NewMultiaddr(*address)
	if err != nil {
		fatal(err)
	}
	info, err := peer.AddrInfoFromP2pAddr(remote)
	if err != nil {
		fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := h.Connect(ctx, *info); err != nil {
		fatal(err)
	}
	// Exercise the full standard multistream-select exchange. The Go host may
	// otherwise use its optimistic lazy path when Identify already advertised
	// the test protocol; the explicit matrix also covers that path through the
	// TypeScript client.
	h.Peerstore().RemoveProtocols(info.ID, echoProtocol)
	remotePublicKey, err := authenticatedRemotePublicKey(h, info.ID)
	if err != nil {
		fatal(err)
	}
	for _, payload := range [][]byte{[]byte("native-go"), bytesOf(128 * 1024)} {
		response, err := roundTrip(ctx, h, info.ID, payload)
		if err != nil || string(response) != string(payload) {
			fatal(fmt.Errorf("echo failed: %v", err))
		}
	}
	fmt.Printf("OK %s %s %s\n", info.ID, hex.EncodeToString(remotePublicKey), info.ID)
}

const (
	echoProtocol = protocol.ID("/bitcoin-libp2p/test/echo/1.0.0")
	maxEcho      = 1 << 20
)

func installEcho(h host.Host) {
	h.SetStreamHandler(echoProtocol, func(stream network.Stream) {
		go func() {
			defer stream.Close()
			payload, err := io.ReadAll(io.LimitReader(stream, maxEcho+1))
			if err != nil || len(payload) > maxEcho {
				_ = stream.Reset()
				return
			}
			_, _ = stream.Write(payload)
			_ = stream.CloseWrite()
		}()
	})
}

func roundTrip(ctx context.Context, h host.Host, id peer.ID, payload []byte) ([]byte, error) {
	if len(payload) == 0 || len(payload) > maxEcho {
		return nil, fmt.Errorf("echo payload must be 1..%d bytes", maxEcho)
	}
	stream, err := h.NewStream(ctx, id, echoProtocol)
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	if _, err := stream.Write(payload); err != nil {
		return nil, err
	}
	if err := stream.CloseWrite(); err != nil {
		return nil, err
	}
	return io.ReadAll(io.LimitReader(stream, maxEcho+1))
}

func authenticatedRemotePublicKey(h host.Host, id peer.ID) ([]byte, error) {
	connections := h.Network().ConnsToPeer(id)
	if len(connections) == 0 || connections[0].RemotePublicKey() == nil {
		return nil, fmt.Errorf("no authenticated connection to %s", id)
	}
	publicKey := connections[0].RemotePublicKey()
	if publicKey.Type() != libp2pcrypto.Secp256k1 {
		return nil, fmt.Errorf("remote key is not secp256k1")
	}
	return publicKey.Raw()
}

func rawPublicKey(privateKey libp2pcrypto.PrivKey) []byte {
	publicKey := privateKey.GetPublic()
	if publicKey == nil {
		fatal(fmt.Errorf("native identity has no public key"))
	}
	raw, err := publicKey.Raw()
	if err != nil {
		fatal(err)
	}
	return raw
}

func bytesOf(size int) []byte {
	value := make([]byte, size)
	for i := range value {
		value[i] = byte(i)
	}
	return value
}

func mustAddr(value string) ma.Multiaddr {
	address, err := ma.NewMultiaddr(value)
	if err != nil {
		fatal(err)
	}
	return address
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
