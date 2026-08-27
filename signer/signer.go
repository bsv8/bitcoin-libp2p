// Package signer defines the two-purpose signing seam used by the SDK. It
// deliberately does not expose a general message or digest signing method.
package signer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/bsv8/bitcoin-libp2p/identity"
	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	secpECDSA "github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	libp2pcrypto "github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
)

const NoiseStaticKeyPrefix = "noise-libp2p-static-key:"

var (
	ErrUnsupportedPurpose = errors.New("unsupported signer purpose")
	ErrInvalidSignerInput = errors.New("invalid signer input")
	ErrInvalidSignature   = errors.New("invalid signature")
	ErrSignerPublicKey    = errors.New("signer public key mismatch")
)

// Signer is intentionally narrow. Implementations may be backed by a local
// test key, a Worker, an HSM or a remote service, but none can be asked to sign
// arbitrary bytes. Implementations must observe ctx and return promptly after
// it is canceled; the adapter cannot forcibly stop a synchronous signer call.
type Signer interface {
	PublicKey() []byte
	SignNoiseStaticKey(context.Context, []byte) ([]byte, error)
	SignPeerRecord(context.Context, PeerRecord) ([]byte, error)
}

// PeerRecord is the structured, standard libp2p peer record passed to a
// signer. Domain, payload type and signature encoding are fixed by this
// package and cannot be supplied by callers.
type PeerRecord struct {
	PeerID    peer.ID
	Addresses []ma.Multiaddr
	Sequence  uint64
}

func (r PeerRecord) copy() PeerRecord {
	out := PeerRecord{PeerID: r.PeerID, Sequence: r.Sequence, Addresses: make([]ma.Multiaddr, len(r.Addresses))}
	for i, address := range r.Addresses {
		out.Addresses[i], _ = ma.NewMultiaddrBytes(append([]byte(nil), address.Bytes()...))
	}
	return out
}

func (r PeerRecord) validate(expected peer.ID) error {
	if err := r.PeerID.Validate(); err != nil || r.PeerID != expected {
		return fmt.Errorf("%w: peer id", ErrInvalidSignerInput)
	}
	for _, address := range r.Addresses {
		if len(address) == 0 {
			return fmt.Errorf("%w: empty multiaddr", ErrInvalidSignerInput)
		}
		if _, err := ma.NewMultiaddrBytes(address.Bytes()); err != nil {
			return fmt.Errorf("%w: invalid multiaddr", ErrInvalidSignerInput)
		}
	}
	return nil
}

func (r PeerRecord) native() *peer.PeerRecord {
	addrs := make([]ma.Multiaddr, len(r.Addresses))
	for i, address := range r.Addresses {
		addrs[i], _ = ma.NewMultiaddrBytes(append([]byte(nil), address.Bytes()...))
	}
	return &peer.PeerRecord{PeerID: r.PeerID, Addrs: addrs, Seq: r.Sequence}
}

// MarshalPeerRecord returns the standard protobuf payload, not an envelope.
func MarshalPeerRecord(r PeerRecord, expected peer.ID) ([]byte, error) {
	if err := r.validate(expected); err != nil {
		return nil, err
	}
	payload, err := r.native().MarshalRecord()
	if err != nil {
		return nil, fmt.Errorf("%w: peer record encoding", ErrInvalidSignerInput)
	}
	return payload, nil
}

// PeerRecordUnsigned returns the exact standard libp2p Envelope signing bytes.
// It is useful to test a remote signer implementation without exposing a
// generic signing oracle.
func PeerRecordUnsigned(r PeerRecord, expected peer.ID) ([]byte, error) {
	payload, err := MarshalPeerRecord(r, expected)
	if err != nil {
		return nil, err
	}
	return unsignedEnvelope(PeerRecordEnvelopeDomain, peerRecordEnvelopePayloadType[:], payload), nil
}

const PeerRecordEnvelopeDomain = "libp2p-peer-record"

var peerRecordEnvelopePayloadType = [...]byte{0x03, 0x01}

func unsignedEnvelope(domain string, payloadType, payload []byte) []byte {
	out := make([]byte, 0, len(domain)+len(payloadType)+len(payload)+6)
	var encoded [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(encoded[:], uint64(len(domain)))
	out = append(out, encoded[:n]...)
	out = append(out, domain...)
	n = binary.PutUvarint(encoded[:], uint64(len(payloadType)))
	out = append(out, encoded[:n]...)
	out = append(out, payloadType...)
	n = binary.PutUvarint(encoded[:], uint64(len(payload)))
	out = append(out, encoded[:n]...)
	out = append(out, payload...)
	return out
}

// ParsePeerRecordUnsigned recognizes only standard Signed Peer Record input.
// Canonical re-encoding prevents silently accepting unknown fields or invalid
// addresses that the upstream decoder would otherwise skip.
func ParsePeerRecordUnsigned(data []byte, expected peer.ID) (PeerRecord, error) {
	read := func(offset *int) ([]byte, error) {
		start := *offset
		length, n := binary.Uvarint(data[start:])
		if n <= 0 || length > uint64(len(data)-start-n) {
			return nil, fmt.Errorf("%w: malformed record envelope", ErrInvalidSignerInput)
		}
		var canonical [binary.MaxVarintLen64]byte
		canonicalLength := binary.PutUvarint(canonical[:], length)
		if canonicalLength != n || !bytes.Equal(canonical[:n], data[start:start+n]) {
			return nil, fmt.Errorf("%w: non-canonical record envelope", ErrInvalidSignerInput)
		}
		*offset += n
		value := data[*offset : *offset+int(length)]
		*offset += int(length)
		return value, nil
	}
	offset := 0
	domain, err := read(&offset)
	if err != nil || string(domain) != PeerRecordEnvelopeDomain {
		return PeerRecord{}, fmt.Errorf("%w: peer record domain", ErrUnsupportedPurpose)
	}
	payloadType, err := read(&offset)
	if err != nil || !bytes.Equal(payloadType, peerRecordEnvelopePayloadType[:]) {
		return PeerRecord{}, fmt.Errorf("%w: peer record payload type", ErrUnsupportedPurpose)
	}
	payload, err := read(&offset)
	if err != nil || offset != len(data) {
		return PeerRecord{}, fmt.Errorf("%w: malformed record envelope", ErrInvalidSignerInput)
	}
	var native peer.PeerRecord
	if err := native.UnmarshalRecord(payload); err != nil {
		return PeerRecord{}, fmt.Errorf("%w: peer record payload", ErrInvalidSignerInput)
	}
	converted := PeerRecord{PeerID: native.PeerID, Sequence: native.Seq, Addresses: native.Addrs}
	canonical, err := MarshalPeerRecord(converted, expected)
	if err != nil || !bytes.Equal(canonical, payload) {
		return PeerRecord{}, fmt.Errorf("%w: non-canonical peer record", ErrInvalidSignerInput)
	}
	return converted, nil
}

// VerifyDER verifies the exact libp2p secp256k1 signature format: SHA-256 of
// data, strict DER, and low-S. It also checks that the key is secp256k1.
func VerifyDER(publicKey, data, signature []byte) error {
	pub, err := identity.Libp2pPublicKey(publicKey)
	if err != nil {
		return err
	}
	parsed, err := secpECDSA.ParseDERSignature(signature)
	if err != nil || parsed == nil || !bytes.Equal(parsed.Serialize(), signature) {
		return fmt.Errorf("%w: non-canonical DER", ErrInvalidSignature)
	}
	sValue := parsed.S()
	if sValue.IsOverHalfOrder() {
		return fmt.Errorf("%w: high-S signature", ErrInvalidSignature)
	}
	valid, err := pub.Verify(data, signature)
	if err != nil || !valid {
		return fmt.Errorf("%w: public-key verification failed", ErrInvalidSignature)
	}
	return nil
}

// LocalSigner is provided for tests and trusted single-process programs. It
// keeps the key private to this package and exposes only the typed interface.
// Production callers should implement Signer around their own protected key
// service.
type LocalSigner struct {
	privateKey *secp256k1.PrivateKey
	publicKey  []byte
}

var _ Signer = (*LocalSigner)(nil)

func NewLocalSigner(rawPrivateKey []byte) (*LocalSigner, error) {
	if err := identity.PrivateKeyBytes(rawPrivateKey); err != nil {
		return nil, err
	}
	key := secp256k1.PrivKeyFromBytes(append([]byte(nil), rawPrivateKey...))
	return &LocalSigner{privateKey: key, publicKey: key.PubKey().SerializeCompressed()}, nil
}

func (s *LocalSigner) PublicKey() []byte {
	if s == nil {
		return nil
	}
	return append([]byte(nil), s.publicKey...)
}

func (s *LocalSigner) sign(ctx context.Context, data []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	digest := sha256.Sum256(data)
	signature := secpECDSA.Sign(s.privateKey, digest[:]).Serialize()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := VerifyDER(s.publicKey, data, signature); err != nil {
		return nil, err
	}
	return signature, nil
}

func (s *LocalSigner) SignNoiseStaticKey(ctx context.Context, staticKey []byte) ([]byte, error) {
	if len(staticKey) != 32 {
		return nil, fmt.Errorf("%w: noise static key must be 32 bytes", ErrInvalidSignerInput)
	}
	payload := append([]byte(NoiseStaticKeyPrefix), staticKey...)
	return s.sign(ctx, payload)
}

func (s *LocalSigner) SignPeerRecord(ctx context.Context, record PeerRecord) ([]byte, error) {
	id, err := identity.PeerIDFromPublicKey(s.publicKey)
	if err != nil {
		return nil, err
	}
	unsigned, err := PeerRecordUnsigned(record, id)
	if err != nil {
		return nil, err
	}
	return s.sign(ctx, unsigned)
}

// Ensure the local implementation remains a native libp2p public key
// compatible signer without exposing its private-key object.
func (s *LocalSigner) PublicKeyObject() (libp2pcrypto.PubKey, error) {
	return identity.Libp2pPublicKey(s.publicKey)
}
