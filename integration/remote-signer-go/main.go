// Command remote-signer-go is a test-only typed signing lane. It is kept in a
// separate process from the SDK host and is not a production RPC protocol.
package main

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"sync/atomic"

	"github.com/bsv8/bitcoin-libp2p/signer"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
)

type request struct {
	ID           uint64   `json:"id"`
	Purpose      string   `json:"purpose"`
	StaticKeyHex string   `json:"static_key_hex,omitempty"`
	PeerID       string   `json:"peer_id,omitempty"`
	Addresses    []string `json:"addresses,omitempty"`
	Sequence     string   `json:"sequence,omitempty"`
}

type response struct {
	ID              uint64 `json:"id"`
	OK              bool   `json:"ok"`
	SignatureDERHex string `json:"signature_der_hex,omitempty"`
	Error           string `json:"error,omitempty"`
}

type lane struct {
	signer      *signer.LocalSigner
	wrongSigner *signer.LocalSigner
	maxNoise    uint64
	noise       atomic.Uint64
	mode        string
}

func main() {
	keyHex := flag.String("key", "", "TEST-ONLY private key; never printed")
	maxNoise := flag.Uint64("max-noise", 1, "maximum Noise signing requests for this test lane")
	mode := flag.String("mode", "normal", "normal, pending, exit, reject, or wrong-key")
	flag.Parse()
	if *keyHex == "" {
		fatal(fmt.Errorf("-key is required"))
	}
	privateKey, err := hex.DecodeString(*keyHex)
	if err != nil {
		fatal(err)
	}
	wrongKey, err := signer.NewLocalSigner(scalarKey(2))
	if err != nil {
		fatal(err)
	}
	local, err := signer.NewLocalSigner(privateKey)
	if err != nil {
		fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fatal(err)
	}
	defer listener.Close()
	publicKey := hex.EncodeToString(local.PublicKey())
	fmt.Printf("READY %s %s\n", publicKey, listener.Addr().String())

	current := &lane{signer: local, wrongSigner: wrongKey, maxNoise: *maxNoise, mode: *mode}
	serveDone := make(chan struct{})
	go func() {
		defer close(serveDone)
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go current.handle(connection)
		}
	}()
	_, _ = io.Copy(io.Discard, os.Stdin)
	_ = listener.Close()
	<-serveDone
}

func (l *lane) handle(connection net.Conn) {
	defer connection.Close()
	decoder := json.NewDecoder(bufio.NewReader(connection))
	encoder := json.NewEncoder(connection)
	var input request
	if err := decoder.Decode(&input); err != nil {
		return
	}
	requestContext := context.Background()
	if l.mode == "pending" {
		var cancel context.CancelFunc
		requestContext, cancel = context.WithCancel(context.Background())
		monitorDone := make(chan struct{})
		go func() {
			var probe [1]byte
			_, _ = connection.Read(probe[:])
			cancel()
			close(monitorDone)
		}()
		defer func() {
			cancel()
			_ = connection.Close()
			<-monitorDone
		}()
	}
	output := response{ID: input.ID}
	signature, err := l.sign(requestContext, input)
	if err != nil {
		output.Error = err.Error()
	} else {
		output.OK = true
		output.SignatureDERHex = hex.EncodeToString(signature)
	}
	_ = encoder.Encode(output)
}

func (l *lane) sign(ctx context.Context, input request) ([]byte, error) {
	switch l.mode {
	case "normal":
	case "pending":
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	case "exit":
		os.Exit(42)
	case "reject":
		return nil, fmt.Errorf("test signer rejected request")
	case "wrong-key":
		return l.signWith(l.wrongSigner, ctx, input)
	default:
		return nil, fmt.Errorf("unsupported test signer mode %q", l.mode)
	}
	return l.signWith(l.signer, ctx, input)
}

func (l *lane) signWith(active *signer.LocalSigner, ctx context.Context, input request) ([]byte, error) {
	switch input.Purpose {
	case "noise":
		if l.noise.Add(1) > l.maxNoise {
			return nil, fmt.Errorf("test lane rejected repeated Noise signing")
		}
		staticKey, err := hex.DecodeString(input.StaticKeyHex)
		if err != nil {
			return nil, fmt.Errorf("invalid Noise static key")
		}
		return active.SignNoiseStaticKey(ctx, staticKey)
	case "peer-record":
		id, err := peer.Decode(input.PeerID)
		if err != nil {
			return nil, fmt.Errorf("invalid peer id")
		}
		addresses := make([]ma.Multiaddr, 0, len(input.Addresses))
		for _, value := range input.Addresses {
			address, parseErr := ma.NewMultiaddr(value)
			if parseErr != nil {
				return nil, fmt.Errorf("invalid multiaddr")
			}
			addresses = append(addresses, address)
		}
		sequence, err := strconv.ParseUint(input.Sequence, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid peer record sequence")
		}
		return active.SignPeerRecord(ctx, signer.PeerRecord{PeerID: id, Addresses: addresses, Sequence: sequence})
	default:
		return nil, fmt.Errorf("unsupported signer purpose")
	}
}

func scalarKey(lastByte byte) []byte {
	key := make([]byte, 32)
	key[31] = lastByte
	return key
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
