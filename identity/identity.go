// Package identity contains the byte-oriented identity rules shared by the
// Go and TypeScript SDKs.
package identity

import (
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	libp2pcrypto "github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
)

var (
	ErrInvalidPrivateKey = errors.New("invalid secp256k1 private key")
	ErrInvalidPublicKey  = errors.New("invalid compressed secp256k1 public key")
	ErrInvalidPeerID     = errors.New("invalid peer id")
	ErrPeerIDMismatch    = errors.New("peer id does not match public key")
	ErrInvalidMultiaddr  = errors.New("invalid p2p multiaddr")
)

// PrivateKeyBytes is the only private-key input accepted by the identity
// package. It is intentionally not returned by any public identity helper.
func PrivateKeyBytes(raw []byte) error {
	if len(raw) != secp256k1.PrivKeyBytesLen {
		return fmt.Errorf("%w: expected 32 bytes", ErrInvalidPrivateKey)
	}
	key := new(secp256k1.ModNScalar)
	var encoded [32]byte
	copy(encoded[:], raw)
	if key.SetByteSlice(encoded[:]) || key.IsZero() {
		return fmt.Errorf("%w: scalar is outside 1..n-1", ErrInvalidPrivateKey)
	}
	return nil
}

// ParsePrivateKeyHex validates the configuration-only hexadecimal form.
func ParsePrivateKeyHex(value string) ([]byte, error) {
	if len(value) != secp256k1.PrivKeyBytesLen*2 {
		return nil, fmt.Errorf("%w: expected 64 hex characters", ErrInvalidPrivateKey)
	}
	raw, err := hex.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("%w: malformed hex", ErrInvalidPrivateKey)
	}
	if err := PrivateKeyBytes(raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// PublicKeyBytes validates a compressed SEC1 public key and returns a copy.
func PublicKeyBytes(raw []byte) ([]byte, error) {
	if len(raw) != secp256k1.PubKeyBytesLenCompressed {
		return nil, fmt.Errorf("%w: expected 33 bytes", ErrInvalidPublicKey)
	}
	if raw[0] != 0x02 && raw[0] != 0x03 {
		return nil, fmt.Errorf("%w: compressed prefix must be 02 or 03", ErrInvalidPublicKey)
	}
	if _, err := secp256k1.ParsePubKey(raw); err != nil {
		return nil, fmt.Errorf("%w: point is not on secp256k1", ErrInvalidPublicKey)
	}
	return append([]byte(nil), raw...), nil
}

// PublicKeyFromPrivateKey derives the canonical compressed public key. This
// helper is intended for a trusted local signer and test fixtures.
func PublicKeyFromPrivateKey(raw []byte) ([]byte, error) {
	if err := PrivateKeyBytes(raw); err != nil {
		return nil, err
	}
	key := secp256k1.PrivKeyFromBytes(raw)
	return append([]byte(nil), key.PubKey().SerializeCompressed()...), nil
}

// PublicKeyHex returns the configuration/logging representation of a public
// key. Bytes remain the identity truth inside the SDK.
func PublicKeyHex(raw []byte) (string, error) {
	key, err := PublicKeyBytes(raw)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(key), nil
}

// Libp2pPublicKey converts validated bytes into the native libp2p public-key
// object used by PeerId, Noise and Identify.
func Libp2pPublicKey(raw []byte) (libp2pcrypto.PubKey, error) {
	key, err := PublicKeyBytes(raw)
	if err != nil {
		return nil, err
	}
	pub, err := libp2pcrypto.UnmarshalSecp256k1PublicKey(key)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidPublicKey, err)
	}
	return pub, nil
}

// PeerIDFromPublicKey uses the native libp2p key serialization and PeerId
// implementation. No protobuf, multihash or Base58 is assembled here.
func PeerIDFromPublicKey(raw []byte) (peer.ID, error) {
	pub, err := Libp2pPublicKey(raw)
	if err != nil {
		return "", err
	}
	id, err := peer.IDFromPublicKey(pub)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidPeerID, err)
	}
	return id, nil
}

// PublicKeyFromPeerID extracts the inline secp256k1 public key and checks the
// resulting identity. Hashed peer IDs deliberately fail closed because their
// public key cannot be authenticated from the ID alone.
func PublicKeyFromPeerID(id peer.ID) ([]byte, error) {
	if err := id.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidPeerID, err)
	}
	pub, err := id.ExtractPublicKey()
	if err != nil {
		return nil, fmt.Errorf("%w: public key is not inline", ErrInvalidPeerID)
	}
	if pub.Type() != libp2pcrypto.Secp256k1 {
		return nil, fmt.Errorf("%w: peer id key type is not secp256k1", ErrInvalidPublicKey)
	}
	raw, err := pub.Raw()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidPublicKey, err)
	}
	key, err := PublicKeyBytes(raw)
	if err != nil {
		return nil, err
	}
	derived, err := PeerIDFromPublicKey(key)
	if err != nil || derived != id {
		return nil, ErrPeerIDMismatch
	}
	return key, nil
}

// ValidateIdentity checks the public-key/PeerId relationship and, when an
// address is supplied, its /p2p peer component as well.
func ValidateIdentity(publicKey []byte, id peer.ID, address string) error {
	if _, err := PublicKeyBytes(publicKey); err != nil {
		return err
	}
	derived, err := PeerIDFromPublicKey(publicKey)
	if err != nil {
		return err
	}
	if derived != id {
		return ErrPeerIDMismatch
	}
	if address == "" {
		return nil
	}
	addr, err := ma.NewMultiaddr(address)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidMultiaddr, err)
	}
	info, err := peer.AddrInfoFromP2pAddr(addr)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidMultiaddr, err)
	}
	if info.ID != id {
		return fmt.Errorf("%w: address peer id mismatch", ErrPeerIDMismatch)
	}
	return nil
}
