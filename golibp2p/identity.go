// Package golibp2p adapts the typed signer to the native go-libp2p identity
// seam and provides connection authentication helpers.
package golibp2p

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/bsv8/bitcoin-libp2p/identity"
	"github.com/bsv8/bitcoin-libp2p/signer"
	libp2pcrypto "github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/crypto/pb"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
)

var (
	ErrNonExtractable       = errors.New("non-extractable identity key")
	ErrUnsupportedKeyType   = errors.New("unsupported authenticated key type")
	ErrAuthenticationFailed = errors.New("authenticated peer validation failed")
	ErrPinMismatch          = errors.New("authenticated peer pin mismatch")
	ErrIdentityClosed       = errors.New("identity adapter is closed")
)

const DefaultSignTimeout = 5 * time.Second

type identityOptions struct {
	signTimeout time.Duration
}

// IdentityOption configures the adapter's private signing lifecycle. It does
// not expose a general-purpose signing entry point.
type IdentityOption func(*identityOptions)

func WithSignTimeout(timeout time.Duration) IdentityOption {
	return func(options *identityOptions) {
		if timeout > 0 {
			options.signTimeout = timeout
		}
	}
}

// Identity is a go-libp2p crypto.PrivKey whose private material is held only
// by the supplied typed signer. Its Sign method is intentionally private in
// spirit: it is the narrow upstream seam, not a public signing API.
type Identity struct {
	signer    signer.Signer
	publicKey libp2pcrypto.PubKey
	publicRaw []byte
	peerID    peer.ID
	lifecycle context.Context
	cancel    context.CancelFunc
	closeOnce sync.Once
	timeout   time.Duration
}

var _ libp2pcrypto.PrivKey = (*Identity)(nil)

func NewIdentityAdapter(s signer.Signer, options ...IdentityOption) (*Identity, error) {
	if s == nil {
		return nil, fmt.Errorf("%w: signer is nil", signer.ErrInvalidSignerInput)
	}
	adapterOptions := identityOptions{signTimeout: DefaultSignTimeout}
	for _, option := range options {
		if option != nil {
			option(&adapterOptions)
		}
	}
	raw := s.PublicKey()
	validated, err := identity.PublicKeyBytes(raw)
	if err != nil {
		return nil, err
	}
	publicKey, err := identity.Libp2pPublicKey(validated)
	if err != nil {
		return nil, err
	}
	peerID, err := identity.PeerIDFromPublicKey(validated)
	if err != nil {
		return nil, err
	}
	lifecycle, cancel := context.WithCancel(context.Background())
	return &Identity{
		signer:    s,
		publicKey: publicKey,
		publicRaw: validated,
		peerID:    peerID,
		lifecycle: lifecycle,
		cancel:    cancel,
		timeout:   adapterOptions.signTimeout,
	}, nil
}

// Close cancels all adapter-owned signing waits. A signer may still finish a
// physical operation after this call; its late result is discarded.
func (i *Identity) Close() {
	if i == nil || i.cancel == nil {
		return
	}
	i.closeOnce.Do(i.cancel)
}

func (i *Identity) Type() pb.KeyType { return pb.KeyType_Secp256k1 }

func (i *Identity) GetPublic() libp2pcrypto.PubKey { return i.publicKey }

func (i *Identity) Raw() ([]byte, error) { return nil, ErrNonExtractable }

func (i *Identity) Equals(other libp2pcrypto.Key) bool {
	if i == nil || other == nil {
		return false
	}
	if other.Type() != pb.KeyType_Secp256k1 {
		return false
	}
	if pub, ok := other.(libp2pcrypto.PrivKey); ok {
		other = pub.GetPublic()
	}
	raw, err := other.Raw()
	return err == nil && bytes.Equal(raw, i.publicRaw)
}

func (i *Identity) PeerID() peer.ID { return i.peerID }

func (i *Identity) PublicKeyBytes() []byte { return append([]byte(nil), i.publicRaw...) }

func (i *Identity) Sign(data []byte) ([]byte, error) {
	return i.sign(context.Background(), data)
}

func (i *Identity) sign(parent context.Context, data []byte) ([]byte, error) {
	if i == nil || i.signer == nil {
		return nil, fmt.Errorf("%w: signer is unavailable", signer.ErrInvalidSignerInput)
	}
	if parent == nil {
		parent = context.Background()
	}
	if err := i.lifecycle.Err(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrIdentityClosed, err)
	}
	if !bytes.Equal(i.signer.PublicKey(), i.publicRaw) {
		return nil, fmt.Errorf("%w: active public key changed", signer.ErrSignerPublicKey)
	}
	callContext, cancel := context.WithTimeout(i.lifecycle, i.timeout)
	stopParent := context.AfterFunc(parent, cancel)
	defer func() {
		stopParent()
		cancel()
	}()

	var signature []byte
	var err error
	switch {
	case bytes.HasPrefix(data, []byte(signer.NoiseStaticKeyPrefix)):
		if len(data) != len(signer.NoiseStaticKeyPrefix)+32 {
			return nil, fmt.Errorf("%w: noise payload length", signer.ErrInvalidSignerInput)
		}
		staticKey := append([]byte(nil), data[len(signer.NoiseStaticKeyPrefix):]...)
		signature, err = i.signer.SignNoiseStaticKey(callContext, staticKey)
	case len(data) == len(signer.NoiseStaticKeyPrefix)+32:
		return nil, fmt.Errorf("%w: noise payload prefix", signer.ErrInvalidSignerInput)
	default:
		record, parseErr := signer.ParsePeerRecordUnsigned(data, i.peerID)
		if parseErr != nil {
			return nil, fmt.Errorf("%w: %v", signer.ErrUnsupportedPurpose, parseErr)
		}
		signature, err = i.signer.SignPeerRecord(callContext, record)
	}
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(i.signer.PublicKey(), i.publicRaw) {
		return nil, fmt.Errorf("%w: active public key changed", signer.ErrSignerPublicKey)
	}
	if err := signer.VerifyDER(i.publicRaw, data, signature); err != nil {
		return nil, err
	}
	return append([]byte(nil), signature...), nil
}

// AuthenticatedPeer is derived from the security-upgraded connection, never
// from an application payload or an Identify self-report.
type AuthenticatedPeer struct {
	PublicKey  []byte
	PeerID     peer.ID
	RemoteAddr ma.Multiaddr
}

type Pin struct {
	PublicKey []byte
	PeerID    peer.ID
}

func NewPin(publicKey []byte, peerID peer.ID) (Pin, error) {
	key, err := identity.PublicKeyBytes(publicKey)
	if err != nil {
		return Pin{}, err
	}
	derived, err := identity.PeerIDFromPublicKey(key)
	if err != nil {
		return Pin{}, err
	}
	if derived != peerID {
		return Pin{}, identity.ErrPeerIDMismatch
	}
	return Pin{PublicKey: key, PeerID: peerID}, nil
}

func AuthenticatedPeerFromConn(conn network.Conn, pin *Pin) (AuthenticatedPeer, error) {
	if conn == nil {
		return AuthenticatedPeer{}, fmt.Errorf("%w: connection is nil", ErrAuthenticationFailed)
	}
	remoteKey := conn.RemotePublicKey()
	if remoteKey == nil || remoteKey.Type() != libp2pcrypto.Secp256k1 {
		return AuthenticatedPeer{}, ErrUnsupportedKeyType
	}
	publicRaw, err := remoteKey.Raw()
	if err != nil {
		return AuthenticatedPeer{}, fmt.Errorf("%w: public key unavailable", ErrAuthenticationFailed)
	}
	publicRaw, err = identity.PublicKeyBytes(publicRaw)
	if err != nil {
		return AuthenticatedPeer{}, ErrUnsupportedKeyType
	}
	peerID, err := identity.PeerIDFromPublicKey(publicRaw)
	if err != nil || peerID != conn.RemotePeer() {
		return AuthenticatedPeer{}, fmt.Errorf("%w: peer id mismatch", ErrAuthenticationFailed)
	}
	if pin != nil {
		if !bytes.Equal(pin.PublicKey, publicRaw) || pin.PeerID != peerID {
			return AuthenticatedPeer{}, ErrPinMismatch
		}
	}
	return AuthenticatedPeer{
		PublicKey:  publicRaw,
		PeerID:     peerID,
		RemoteAddr: conn.RemoteMultiaddr(),
	}, nil
}
