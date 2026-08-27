package golibp2p

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/bsv8/bitcoin-libp2p/identity"
	"github.com/bsv8/bitcoin-libp2p/signer"
	libp2p "github.com/libp2p/go-libp2p"
	libp2pcrypto "github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
)

func testSigner(t *testing.T) *signer.LocalSigner {
	t.Helper()
	key, err := hex.DecodeString("278d5bed18a82b66619e026c2efb2a907e35310829d9658fb967180636afaa6a")
	if err != nil {
		t.Fatal(err)
	}
	result, err := signer.NewLocalSigner(key)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestAdapterIsNonExtractableAndStrict(t *testing.T) {
	local := testSigner(t)
	adapter, err := NewIdentityAdapter(local)
	if err != nil {
		t.Fatal(err)
	}
	if raw, err := adapter.Raw(); !errors.Is(err, ErrNonExtractable) || raw != nil {
		t.Fatalf("raw = %x, err = %v", raw, err)
	}
	if _, err := adapter.Sign([]byte("arbitrary")); !errors.Is(err, signer.ErrUnsupportedPurpose) {
		t.Fatalf("unknown purpose error = %v", err)
	}
	noisePayload := append([]byte(signer.NoiseStaticKeyPrefix), make([]byte, 32)...)
	if _, err := adapter.Sign(noisePayload[:len(noisePayload)-1]); !errors.Is(err, signer.ErrInvalidSignerInput) {
		t.Fatalf("noise length error = %v", err)
	}
	badPrefix := append([]byte("noise-libp2p-static-kex:"), make([]byte, 32)...)
	if _, err := adapter.Sign(badPrefix); !errors.Is(err, signer.ErrUnsupportedPurpose) && !errors.Is(err, signer.ErrInvalidSignerInput) {
		t.Fatalf("noise prefix error = %v", err)
	}
}

func TestAdapterSignsBothFixedPurposes(t *testing.T) {
	local := testSigner(t)
	adapter, err := NewIdentityAdapter(local)
	if err != nil {
		t.Fatal(err)
	}
	staticKey := bytes.Repeat([]byte{0x42}, 32)
	noisePayload := append([]byte(signer.NoiseStaticKeyPrefix), staticKey...)
	if _, err := adapter.Sign(noisePayload); err != nil {
		t.Fatal(err)
	}
	id := adapter.PeerID()
	record := signer.PeerRecord{
		PeerID:    id,
		Sequence:  7,
		Addresses: []ma.Multiaddr{mustAddr(t, "/ip4/127.0.0.1/tcp/4001")},
	}
	unsigned, err := signer.PeerRecordUnsigned(record, id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := adapter.Sign(unsigned); err != nil {
		t.Fatal(err)
	}
}

func TestAdapterRejectsBadSignerResponses(t *testing.T) {
	local := testSigner(t)
	noisePayload := append([]byte(signer.NoiseStaticKeyPrefix), bytes.Repeat([]byte{0x42}, 32)...)

	badDER, err := NewIdentityAdapter(responseSigner{key: local.PublicKey(), noiseSignature: []byte{0x01}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := badDER.Sign(noisePayload); !errors.Is(err, signer.ErrInvalidSignature) {
		t.Fatalf("bad DER response error = %v", err)
	}

	wrong, err := signer.NewLocalSigner(scalarKey(2))
	if err != nil {
		t.Fatal(err)
	}
	wrongSignature, err := wrong.SignNoiseStaticKey(context.Background(), bytes.Repeat([]byte{0x42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	wrongKeyResponse, err := NewIdentityAdapter(responseSigner{key: local.PublicKey(), noiseSignature: wrongSignature})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wrongKeyResponse.Sign(noisePayload); !errors.Is(err, signer.ErrInvalidSignature) {
		t.Fatalf("wrong key response error = %v", err)
	}
	changingKeyResponse, err := NewIdentityAdapter(&changingResponseSigner{
		key:            local.PublicKey(),
		nextKey:        wrong.PublicKey(),
		noiseSignature: append([]byte(nil), lowSignatureForTest(t, local, bytes.Repeat([]byte{0x42}, 32))...),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := changingKeyResponse.Sign(noisePayload); !errors.Is(err, signer.ErrSignerPublicKey) {
		t.Fatalf("changed key response error = %v", err)
	}
}

func lowSignatureForTest(t *testing.T, local *signer.LocalSigner, staticKey []byte) []byte {
	t.Helper()
	signature, err := local.SignNoiseStaticKey(context.Background(), staticKey)
	if err != nil {
		t.Fatal(err)
	}
	return signature
}

func TestHostSigningTimeoutAndCloseCancelPendingDial(t *testing.T) {
	server, err := NewHost(HostConfig{Signer: testSigner(t), ListenAddrs: []ma.Multiaddr{mustAddr(t, "/ip4/127.0.0.1/tcp/0")}})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	remote := peer.AddrInfo{ID: server.ID(), Addrs: server.Addrs()}

	t.Run("timeout", func(t *testing.T) {
		pending := newBlockingSigner(publicKeyForScalar(t, 1))
		client, err := NewHost(HostConfig{Signer: pending, SignTimeout: 50 * time.Millisecond})
		if err != nil {
			t.Fatal(err)
		}
		dialResult := make(chan error, 1)
		go func() { dialResult <- client.Connect(context.Background(), remote) }()
		waitBlockingSignerStarted(t, pending)
		select {
		case err := <-dialResult:
			if err == nil {
				t.Fatal("pending signer dial unexpectedly succeeded")
			}
		case <-time.After(time.Second):
			t.Fatal("signing timeout did not end dial")
		}
		waitBlockingSignerReturned(t, pending)
		pending.releaseOnce()
		if err := client.Close(); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("host close", func(t *testing.T) {
		pending := newBlockingSigner(publicKeyForScalar(t, 1))
		client, err := NewHost(HostConfig{Signer: pending, SignTimeout: 10 * time.Second})
		if err != nil {
			t.Fatal(err)
		}
		dialResult := make(chan error, 1)
		go func() { dialResult <- client.Connect(context.Background(), remote) }()
		waitBlockingSignerStarted(t, pending)
		closeResult := make(chan error, 1)
		go func() { closeResult <- client.Close() }()
		select {
		case err := <-dialResult:
			if err == nil {
				t.Fatal("closed host dial unexpectedly succeeded")
			}
		case <-time.After(time.Second):
			t.Fatal("host close did not end pending dial")
		}
		waitBlockingSignerReturned(t, pending)
		if err := <-closeResult; err != nil {
			t.Fatal(err)
		}
		pending.releaseOnce()
	})
}

func TestAuthenticationRejectsNonSecpAndPins(t *testing.T) {
	if _, err := NewPin([]byte{1}, peer.ID("x")); !errors.Is(err, identity.ErrInvalidPublicKey) {
		t.Fatalf("invalid pin error = %v", err)
	}
	key := testSigner(t).PublicKey()
	identityAdapter, err := NewIdentityAdapter(testSigner(t))
	if err != nil {
		t.Fatal(err)
	}
	correct, err := NewPin(key, identityAdapter.PeerID())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(correct.PublicKey, key) {
		t.Fatal("pin key was not copied")
	}
	if identityAdapter.GetPublic().Type() != libp2pcrypto.Secp256k1 {
		t.Fatal("adapter type is not secp256k1")
	}
	conn := stubConn{key: identityAdapter.GetPublic(), id: identityAdapter.PeerID(), address: mustAddr(t, "/ip4/127.0.0.1/tcp/4001")}
	authenticated, err := AuthenticatedPeerFromConn(conn, &correct)
	if err != nil || authenticated.PeerID != identityAdapter.PeerID() || !bytes.Equal(authenticated.PublicKey, key) {
		t.Fatalf("authenticated peer = %#v, err = %v", authenticated, err)
	}
	_, wrongKey, err := libp2pcrypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	wrongID, err := peer.IDFromPublicKey(wrongKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AuthenticatedPeerFromConn(stubConn{key: wrongKey, id: wrongID}, nil); !errors.Is(err, ErrUnsupportedKeyType) {
		t.Fatalf("non-secp authentication error = %v", err)
	}
	if _, err := AuthenticatedPeerFromConn(conn, &Pin{PublicKey: bytes.Repeat([]byte{0x02}, 33), PeerID: identityAdapter.PeerID()}); !errors.Is(err, ErrPinMismatch) {
		t.Fatalf("wrong pin error = %v", err)
	}
}

func TestAuthenticationRejectsRealEd25519Connection(t *testing.T) {
	secpHost, err := NewHost(HostConfig{
		Signer:      testSigner(t),
		ListenAddrs: []ma.Multiaddr{mustAddr(t, "/ip4/127.0.0.1/tcp/0")},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer secpHost.Close()
	edPrivateKey, _, err := libp2pcrypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	edHost, err := libp2p.New(
		libp2p.Identity(edPrivateKey),
		libp2p.ListenAddrs(mustAddr(t, "/ip4/127.0.0.1/tcp/0")),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer edHost.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := edHost.Connect(ctx, peer.AddrInfo{ID: secpHost.ID(), Addrs: secpHost.Addrs()}); err != nil {
		t.Fatal(err)
	}
	connections := secpHost.Network().ConnsToPeer(edHost.ID())
	if len(connections) == 0 {
		t.Fatal("no authenticated Ed25519 connection")
	}
	if _, err := AuthenticatedPeerFromConn(connections[0], nil); !errors.Is(err, ErrUnsupportedKeyType) {
		t.Fatalf("real Ed25519 authentication error = %v", err)
	}
}

type stubConn struct {
	network.Conn
	key     libp2pcrypto.PubKey
	id      peer.ID
	address ma.Multiaddr
}

func (s stubConn) RemotePublicKey() libp2pcrypto.PubKey { return s.key }
func (s stubConn) RemotePeer() peer.ID                  { return s.id }
func (s stubConn) RemoteMultiaddr() ma.Multiaddr        { return s.address }

type responseSigner struct {
	key            []byte
	noiseSignature []byte
}

type changingResponseSigner struct {
	key            []byte
	nextKey        []byte
	noiseSignature []byte
}

func (s *changingResponseSigner) PublicKey() []byte { return append([]byte(nil), s.key...) }

func (s *changingResponseSigner) SignNoiseStaticKey(context.Context, []byte) ([]byte, error) {
	s.key = append([]byte(nil), s.nextKey...)
	return append([]byte(nil), s.noiseSignature...), nil
}

func (s *changingResponseSigner) SignPeerRecord(context.Context, signer.PeerRecord) ([]byte, error) {
	return nil, signer.ErrInvalidSignature
}

type blockingSigner struct {
	key      []byte
	started  chan struct{}
	returned chan struct{}
	release  chan struct{}
	once     sync.Once
}

func newBlockingSigner(key []byte) *blockingSigner {
	return &blockingSigner{key: append([]byte(nil), key...), started: make(chan struct{}), returned: make(chan struct{}), release: make(chan struct{})}
}

func (s *blockingSigner) PublicKey() []byte { return append([]byte(nil), s.key...) }

func (s *blockingSigner) wait(ctx context.Context) ([]byte, error) {
	s.once.Do(func() { close(s.started) })
	defer close(s.returned)
	select {
	case <-s.release:
		return nil, errors.New("blocking test signer released")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *blockingSigner) SignNoiseStaticKey(ctx context.Context, _ []byte) ([]byte, error) {
	return s.wait(ctx)
}

func (s *blockingSigner) SignPeerRecord(ctx context.Context, _ signer.PeerRecord) ([]byte, error) {
	return s.wait(ctx)
}

func (s *blockingSigner) releaseOnce() {
	s.once.Do(func() { close(s.started) })
	select {
	case <-s.release:
	default:
		close(s.release)
	}
}

func waitBlockingSignerStarted(t *testing.T, signer *blockingSigner) {
	t.Helper()
	select {
	case <-signer.started:
	case <-time.After(time.Second):
		t.Fatal("test signer was not called by host")
	}
}

func waitBlockingSignerReturned(t *testing.T, signer *blockingSigner) {
	t.Helper()
	select {
	case <-signer.returned:
	case <-time.After(time.Second):
		t.Fatal("test signer did not return after cancellation")
	}
}

func (s responseSigner) PublicKey() []byte { return append([]byte(nil), s.key...) }

func (s responseSigner) SignNoiseStaticKey(context.Context, []byte) ([]byte, error) {
	return append([]byte(nil), s.noiseSignature...), nil
}

func (s responseSigner) SignPeerRecord(context.Context, signer.PeerRecord) ([]byte, error) {
	return nil, signer.ErrInvalidSignature
}

func scalarKey(lastByte byte) []byte {
	key := make([]byte, 32)
	key[31] = lastByte
	return key
}

func publicKeyForScalar(t *testing.T, lastByte byte) []byte {
	t.Helper()
	local, err := signer.NewLocalSigner(scalarKey(lastByte))
	if err != nil {
		t.Fatal(err)
	}
	return local.PublicKey()
}

func mustAddr(t *testing.T, value string) ma.Multiaddr {
	t.Helper()
	address, err := ma.NewMultiaddr(value)
	if err != nil {
		t.Fatal(err)
	}
	return address
}
