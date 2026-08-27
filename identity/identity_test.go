package identity

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

const testPrivateKeyHex = "278d5bed18a82b66619e026c2efb2a907e35310829d9658fb967180636afaa6a"

func TestIdentityVector(t *testing.T) {
	privateKey, err := hex.DecodeString(testPrivateKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, err := PublicKeyFromPrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(publicKey); got != "02e940822d4e7a09ce013bed4fa812e92f22b0ed1fa2d1ad06ae0406680da1cc46" {
		t.Fatalf("public key = %s", got)
	}
	id, err := PeerIDFromPublicKey(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	if got := id.String(); got != "16Uiu2HAmB8C2R7pBJu1z2u1gno7aXcbtkoUzrknTFN2EBLjRavKP" {
		t.Fatalf("peer id = %s", got)
	}
	gotPublicKey, err := PublicKeyFromPeerID(id)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(gotPublicKey) != hex.EncodeToString(publicKey) {
		t.Fatal("peer id did not round-trip public key")
	}
	if err := ValidateIdentity(publicKey, id, "/ip4/127.0.0.1/tcp/4001/p2p/"+id.String()); err != nil {
		t.Fatal(err)
	}
}

func TestInvalidPrivateKeys(t *testing.T) {
	for name, value := range map[string][]byte{
		"empty": nil,
		"short": make([]byte, 31),
		"long":  make([]byte, 33),
		"zero":  make([]byte, 32),
	} {
		t.Run(name, func(t *testing.T) {
			if err := PrivateKeyBytes(value); !errors.Is(err, ErrInvalidPrivateKey) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestInvalidIdentityFixture(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate identity test")
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "testdata", "invalid-identity-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		InvalidPrivateKeys []string `json:"invalid_private_keys_hex"`
		InvalidPublicKeys  []string `json:"invalid_public_keys_hex"`
	}
	if err := json.Unmarshal(data, &vector); err != nil {
		t.Fatal(err)
	}
	for _, encoded := range vector.InvalidPrivateKeys {
		raw, err := hex.DecodeString(encoded)
		if err != nil {
			t.Fatal(err)
		}
		if err := PrivateKeyBytes(raw); !errors.Is(err, ErrInvalidPrivateKey) {
			t.Fatalf("private key %q error = %v", encoded, err)
		}
	}
	for _, encoded := range vector.InvalidPublicKeys {
		raw, err := hex.DecodeString(encoded)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := PublicKeyBytes(raw); !errors.Is(err, ErrInvalidPublicKey) {
			t.Fatalf("public key %q error = %v", encoded, err)
		}
	}
}

func TestInvalidPublicKeysAndPins(t *testing.T) {
	for _, value := range [][]byte{nil, make([]byte, 32), append([]byte{0x04}, make([]byte, 32)...), make([]byte, 33)} {
		if _, err := PublicKeyBytes(value); !errors.Is(err, ErrInvalidPublicKey) {
			t.Fatalf("public key error = %v", err)
		}
	}
	key, _ := hex.DecodeString(testPrivateKeyHex)
	publicKey, _ := PublicKeyFromPrivateKey(key)
	id, _ := PeerIDFromPublicKey(publicKey)
	otherKey := make([]byte, 32)
	otherKey[31] = 1
	otherPublic, err := PublicKeyFromPrivateKey(otherKey)
	if err != nil {
		t.Fatal(err)
	}
	other, err := PeerIDFromPublicKey(otherPublic)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateIdentity(publicKey, other, ""); !errors.Is(err, ErrPeerIDMismatch) {
		t.Fatalf("pin error = %v", err)
	}
	if err := ValidateIdentity(publicKey, id, "/ip4/127.0.0.1/tcp/4001/p2p/"+other.String()); !errors.Is(err, ErrPeerIDMismatch) {
		t.Fatalf("multiaddr pin error = %v", err)
	}
}
