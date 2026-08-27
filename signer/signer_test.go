package signer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/bsv8/bitcoin-libp2p/identity"
	secpECDSA "github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
)

type noiseVector struct {
	StaticPublicKeyHex string `json:"static_public_key_hex"`
	PayloadHex         string `json:"payload_hex"`
	SHA256Hex          string `json:"sha256_hex"`
	SignatureDERHex    string `json:"signature_der_hex"`
}

type peerVector struct {
	PeerID              string   `json:"peer_id"`
	Addresses           []string `json:"addresses"`
	Sequence            uint64   `json:"sequence"`
	ProtobufPayloadHex  string   `json:"protobuf_payload_hex"`
	UnsignedEnvelopeHex string   `json:"unsigned_envelope_payload_hex"`
	SignatureDERHex     string   `json:"signature_der_hex"`
}

func fixture(t *testing.T, name string, destination any) {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, destination); err != nil {
		t.Fatal(err)
	}
}

func TestCrossLanguageVectors(t *testing.T) {
	privateKey, _ := hex.DecodeString("278d5bed18a82b66619e026c2efb2a907e35310829d9658fb967180636afaa6a")
	local, err := NewLocalSigner(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	var noiseVector noiseVector
	fixture(t, "noise-signature-v1.json", &noiseVector)
	staticKey, _ := hex.DecodeString(noiseVector.StaticPublicKeyHex)
	payload := append([]byte(NoiseStaticKeyPrefix), staticKey...)
	digest := sha256.Sum256(payload)
	if hex.EncodeToString(digest[:]) != noiseVector.SHA256Hex || hex.EncodeToString(payload) != noiseVector.PayloadHex {
		t.Fatal("Noise payload vector mismatch")
	}
	signature, err := local.SignNoiseStaticKey(context.Background(), staticKey)
	if err != nil || hex.EncodeToString(signature) != noiseVector.SignatureDERHex {
		t.Fatalf("Noise signature = %x, err = %v", signature, err)
	}

	var peerVector peerVector
	fixture(t, "peer-record-v1.json", &peerVector)
	id, err := identity.PeerIDFromPublicKey(local.PublicKey())
	if err != nil || id.String() != peerVector.PeerID {
		t.Fatalf("peer id = %s, err = %v", id, err)
	}
	addresses := make([]ma.Multiaddr, 0, len(peerVector.Addresses))
	for _, value := range peerVector.Addresses {
		address, err := ma.NewMultiaddr(value)
		if err != nil {
			t.Fatal(err)
		}
		addresses = append(addresses, address)
	}
	record := PeerRecord{PeerID: id, Addresses: addresses, Sequence: peerVector.Sequence}
	payload, err = MarshalPeerRecord(record, id)
	if err != nil || hex.EncodeToString(payload) != peerVector.ProtobufPayloadHex {
		t.Fatalf("record payload = %x, err = %v", payload, err)
	}
	unsigned, err := PeerRecordUnsigned(record, id)
	if err != nil || hex.EncodeToString(unsigned) != peerVector.UnsignedEnvelopeHex {
		t.Fatalf("record unsigned = %x, err = %v", unsigned, err)
	}
	signature, err = local.SignPeerRecord(context.Background(), record)
	if err != nil || hex.EncodeToString(signature) != peerVector.SignatureDERHex {
		t.Fatalf("record signature = %x, err = %v", signature, err)
	}
	parsed, err := ParsePeerRecordUnsigned(unsigned, id)
	if err != nil || parsed.PeerID != id || parsed.Sequence != record.Sequence {
		t.Fatalf("parsed record = %#v, err = %v", parsed, err)
	}
}

func TestSignerContextAndInputFailures(t *testing.T) {
	local, err := NewLocalSigner(make([]byte, 32))
	if err == nil || !errors.Is(err, identity.ErrInvalidPrivateKey) {
		t.Fatalf("zero key err = %v", err)
	}
	key, _ := hex.DecodeString("278d5bed18a82b66619e026c2efb2a907e35310829d9658fb967180636afaa6a")
	local, err = NewLocalSigner(key)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := local.SignNoiseStaticKey(ctx, make([]byte, 32)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel err = %v", err)
	}
	if _, err := local.SignNoiseStaticKey(context.Background(), make([]byte, 31)); !errors.Is(err, ErrInvalidSignerInput) {
		t.Fatalf("noise length err = %v", err)
	}
	if _, err := ParsePeerRecordUnsigned([]byte("unknown"), identityPeerID(t, local)); !errors.Is(err, ErrUnsupportedPurpose) && !errors.Is(err, ErrInvalidSignerInput) {
		t.Fatalf("unknown record err = %v", err)
	}
}

func TestPeerRecordFailuresAndSignerResponseVerification(t *testing.T) {
	local, err := NewLocalSigner(testPrivateKey(t))
	if err != nil {
		t.Fatal(err)
	}
	id := identityPeerID(t, local)
	record := PeerRecord{PeerID: id, Sequence: 7, Addresses: []ma.Multiaddr{mustMultiaddr(t, "/ip4/127.0.0.1/tcp/4001")}}
	unsigned, err := PeerRecordUnsigned(record, id)
	if err != nil {
		t.Fatal(err)
	}
	wrongDomain := append([]byte(nil), unsigned...)
	wrongDomain[1] = 'X'
	if _, err := ParsePeerRecordUnsigned(wrongDomain, id); !errors.Is(err, ErrUnsupportedPurpose) {
		t.Fatalf("wrong domain error = %v", err)
	}
	wrongType := append([]byte(nil), unsigned...)
	wrongType[1+len(PeerRecordEnvelopeDomain)+1] = 0x04
	if _, err := ParsePeerRecordUnsigned(wrongType, id); !errors.Is(err, ErrUnsupportedPurpose) {
		t.Fatalf("wrong payload type error = %v", err)
	}
	if _, err := PeerRecordUnsigned(PeerRecord{PeerID: id, Addresses: []ma.Multiaddr{nil}}, id); !errors.Is(err, ErrInvalidSignerInput) {
		t.Fatalf("invalid address error = %v", err)
	}
	other, err := NewLocalSigner(bytes.Repeat([]byte{0}, 31))
	if err == nil || !errors.Is(err, identity.ErrInvalidPrivateKey) {
		t.Fatalf("invalid alternate key error = %v", err)
	}
	other, err = NewLocalSigner(scalarKey(1))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := PeerRecordUnsigned(record, identityPeerID(t, other)); !errors.Is(err, ErrInvalidSignerInput) {
		t.Fatalf("wrong record identity error = %v", err)
	}
	noise := append([]byte(NoiseStaticKeyPrefix), bytes.Repeat([]byte{0x42}, 32)...)
	if err := VerifyDER(local.PublicKey(), noise, []byte{0x01}); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("bad DER error = %v", err)
	}
	wrongKey, err := NewLocalSigner(scalarKey(2))
	if err != nil {
		t.Fatal(err)
	}
	wrongSignature, err := wrongKey.SignNoiseStaticKey(context.Background(), bytes.Repeat([]byte{0x42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyDER(local.PublicKey(), noise, wrongSignature); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("wrong key signature error = %v", err)
	}
	lowSignature, err := local.SignNoiseStaticKey(context.Background(), bytes.Repeat([]byte{0x42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := secpECDSA.ParseDERSignature(lowSignature)
	if err != nil {
		t.Fatal(err)
	}
	rValue := parsed.R()
	sValue := parsed.S()
	rBytes := rValue.Bytes()
	sBytes := sValue.Bytes()
	compactSignature := append(append([]byte(nil), rBytes[:]...), sBytes[:]...)
	if err := VerifyDER(local.PublicKey(), noise, compactSignature); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("compact signature error = %v", err)
	}
	sValue.Negate()
	sBytes = sValue.Bytes()
	highSignature, err := asn1.Marshal(struct {
		R *big.Int
		S *big.Int
	}{
		R: new(big.Int).SetBytes(rBytes[:]),
		S: new(big.Int).SetBytes(sBytes[:]),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyDER(local.PublicKey(), noise, highSignature); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("high-S signature error = %v", err)
	}
}

func testPrivateKey(t *testing.T) []byte {
	t.Helper()
	key, err := hex.DecodeString("278d5bed18a82b66619e026c2efb2a907e35310829d9658fb967180636afaa6a")
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func scalarKey(lastByte byte) []byte {
	key := make([]byte, 32)
	key[31] = lastByte
	return key
}

func identityPeerID(t *testing.T, local *LocalSigner) peer.ID {
	t.Helper()
	id, err := identity.PeerIDFromPublicKey(local.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func mustMultiaddr(t *testing.T, value string) ma.Multiaddr {
	t.Helper()
	address, err := ma.NewMultiaddr(value)
	if err != nil {
		t.Fatal(err)
	}
	return address
}
