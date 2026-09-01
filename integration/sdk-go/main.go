// Command sdk-go is an explicit integration-test endpoint. It imports the
// SDK and is never started by go test ./... or by the package host assembler.
package main

import (
	"context"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/bsv8/bitcoin-libp2p/golibp2p"
	"github.com/bsv8/bitcoin-libp2p/integration/echo"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
)

func main() {
	mode := flag.String("mode", "server", "server or client")
	address := flag.String("addr", "", "peer multiaddr for client mode")
	publicKeyHex := flag.String("public-key", "", "remote signer public key")
	signerAddress := flag.String("signer-addr", "", "test-only remote signer lane address")
	signTimeoutMS := flag.Int("sign-timeout-ms", 0, "test-only signer timeout in milliseconds")
	hostStopAfterMS := flag.Int("host-stop-after-ms", 0, "test-only host stop delay in milliseconds")
	framing := flag.Bool("framing", false, "test-only: use the uvarint framing protocol")
	flag.Parse()

	publicKey, err := hex.DecodeString(*publicKeyHex)
	if err != nil {
		fatal(err)
	}
	remoteSigner, err := newRemoteSigner(publicKey, *signerAddress)
	if err != nil {
		fatal(err)
	}
	var listen []ma.Multiaddr
	if *mode == "server" {
		listen, err = multiaddrs("/ip4/127.0.0.1/tcp/0")
		if err != nil {
			fatal(err)
		}
	}
	hostConfig := golibp2p.HostConfig{
		Signer:      remoteSigner,
		ListenAddrs: listen,
		Services: []golibp2p.Service{func(h host.Host) error {
			echo.Install(h)
			echo.InstallFraming(h)
			return nil
		}},
	}
	if *signTimeoutMS > 0 {
		hostConfig.SignTimeout = time.Duration(*signTimeoutMS) * time.Millisecond
	}
	h, err := golibp2p.NewHost(hostConfig)
	if err != nil {
		fatal(err)
	}
	defer h.Close()
	if *mode == "server" {
		id := h.ID()
		if len(h.Addrs()) == 0 {
			fatal(fmt.Errorf("host did not listen"))
		}
		fmt.Printf("READY %s %s %s\n", id.String(), h.Addrs()[0].Encapsulate(mustMultiaddr("/p2p/"+id.String())).String(), hex.EncodeToString(remoteSigner.PublicKey()))
		_, _ = io.Copy(io.Discard, os.Stdin)
		return
	}
	if *address == "" {
		fatal(fmt.Errorf("-addr is required in client mode"))
	}
	if *hostStopAfterMS > 0 {
		time.AfterFunc(time.Duration(*hostStopAfterMS)*time.Millisecond, func() { _ = h.Close() })
	}
	remoteAddr, err := ma.NewMultiaddr(*address)
	if err != nil {
		fatal(err)
	}
	info, err := peer.AddrInfoFromP2pAddr(remoteAddr)
	if err != nil {
		fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := h.Connect(ctx, *info); err != nil {
		fatal(err)
	}
	// Keep this endpoint on the full standard multistream-select path. When
	// Identify has advertised the test protocol, go-libp2p may choose its
	// optimistic lazy path; the TypeScript client covers that path separately.
	h.Peerstore().RemoveProtocols(info.ID, echo.ProtocolID)
	conn := h.Network().ConnsToPeer(info.ID)
	if len(conn) == 0 {
		fatal(fmt.Errorf("no authenticated connection"))
	}
	authenticated, err := golibp2p.AuthenticatedPeerFromConn(conn[0], nil)
	if err != nil {
		fatal(err)
	}
	if *framing {
		payloads := [][]byte{[]byte("framing"), []byte("中文 payload"), bytesOf(128 * 1024)}
		if _, err := echo.FramingRoundTrip(ctx, h, info.ID, payloads); err != nil {
			fatal(fmt.Errorf("framing round trip failed: %v", err))
		}
	} else {
		for _, payload := range [][]byte{[]byte("hello"), bytesOf(128 * 1024)} {
			response, err := echo.RoundTrip(ctx, h, info.ID, payload)
			if err != nil || string(response) != string(payload) {
				fatal(fmt.Errorf("echo failed: %v", err))
			}
		}
	}
	fmt.Printf("OK %s %s %s\n", authenticated.PeerID, hex.EncodeToString(authenticated.PublicKey), info.ID)
}

func bytesOf(size int) []byte {
	value := make([]byte, size)
	for i := range value {
		value[i] = byte(i)
	}
	return value
}

func multiaddrs(values ...string) ([]ma.Multiaddr, error) {
	result := make([]ma.Multiaddr, 0, len(values))
	for _, value := range values {
		address, err := ma.NewMultiaddr(value)
		if err != nil {
			return nil, err
		}
		result = append(result, address)
	}
	return result, nil
}

func mustMultiaddr(value string) ma.Multiaddr {
	address, err := ma.NewMultiaddr(value)
	if err != nil {
		fatal(err)
	}
	return address
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, strings.TrimSpace(err.Error()))
	os.Exit(1)
}
