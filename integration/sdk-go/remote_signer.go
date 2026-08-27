package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"sync/atomic"

	"github.com/bsv8/bitcoin-libp2p/identity"
	"github.com/bsv8/bitcoin-libp2p/signer"
	"github.com/libp2p/go-libp2p/core/peer"
)

// remoteSigner is intentionally integration-only. The host sees only the
// public key and these two typed methods; the private key lives in the lane
// process started by scripts/test-integration.sh.
type remoteSigner struct {
	publicKey []byte
	peerID    peer.ID
	address   string
	nextID    atomic.Uint64
}

var _ signer.Signer = (*remoteSigner)(nil)

func newRemoteSigner(publicKey []byte, address string) (*remoteSigner, error) {
	key, err := identity.PublicKeyBytes(publicKey)
	if err != nil {
		return nil, err
	}
	id, err := identity.PeerIDFromPublicKey(key)
	if err != nil {
		return nil, err
	}
	if address == "" {
		return nil, fmt.Errorf("remote signer address is empty")
	}
	return &remoteSigner{publicKey: key, peerID: id, address: address}, nil
}

func (s *remoteSigner) PublicKey() []byte {
	return append([]byte(nil), s.publicKey...)
}

func (s *remoteSigner) SignNoiseStaticKey(ctx context.Context, staticKey []byte) ([]byte, error) {
	if len(staticKey) != 32 {
		return nil, fmt.Errorf("invalid Noise static key length")
	}
	return s.request(ctx, remoteSignerRequest{
		Purpose:      "noise",
		StaticKeyHex: hex.EncodeToString(staticKey),
	})
}

func (s *remoteSigner) SignPeerRecord(ctx context.Context, record signer.PeerRecord) ([]byte, error) {
	if _, err := signer.PeerRecordUnsigned(record, s.peerID); err != nil {
		return nil, err
	}
	addresses := make([]string, len(record.Addresses))
	for index, address := range record.Addresses {
		addresses[index] = address.String()
	}
	return s.request(ctx, remoteSignerRequest{
		Purpose:   "peer-record",
		PeerID:    record.PeerID.String(),
		Addresses: addresses,
		Sequence:  fmt.Sprintf("%d", record.Sequence),
	})
}

type remoteSignerRequest struct {
	ID           uint64   `json:"id"`
	Purpose      string   `json:"purpose"`
	StaticKeyHex string   `json:"static_key_hex,omitempty"`
	PeerID       string   `json:"peer_id,omitempty"`
	Addresses    []string `json:"addresses,omitempty"`
	Sequence     string   `json:"sequence,omitempty"`
}

type remoteSignerResponse struct {
	ID              uint64 `json:"id"`
	OK              bool   `json:"ok"`
	SignatureDERHex string `json:"signature_der_hex,omitempty"`
	Error           string `json:"error,omitempty"`
}

func (s *remoteSigner) request(ctx context.Context, request remoteSignerRequest) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	request.ID = s.nextID.Add(1)
	connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", s.address)
	if err != nil {
		return nil, err
	}
	stopClose := context.AfterFunc(ctx, func() { _ = connection.Close() })
	defer stopClose()
	defer connection.Close()
	if err := json.NewEncoder(connection).Encode(request); err != nil {
		return nil, err
	}
	var response remoteSignerResponse
	if err := json.NewDecoder(connection).Decode(&response); err != nil {
		return nil, err
	}
	if response.ID != request.ID || !response.OK {
		if response.Error == "" {
			response.Error = "remote signer rejected request"
		}
		return nil, fmt.Errorf("%s", response.Error)
	}
	signature, err := hex.DecodeString(response.SignatureDERHex)
	if err != nil {
		return nil, fmt.Errorf("remote signer returned malformed signature")
	}
	return signature, nil
}
