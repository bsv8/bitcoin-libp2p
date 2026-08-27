package webrtcdirect

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/bsv8/bitcoin-libp2p/identity"
	"github.com/libp2p/go-libp2p/core/peer"
)

type endpointVectors struct {
	Valid        []validVector        `json:"valid"`
	Build        []buildVector        `json:"build"`
	BuildInvalid []invalidBuildVector `json:"build_invalid"`
	Invalid      []invalidVector      `json:"invalid"`
}

type validVector struct {
	Name              string `json:"name"`
	Input             string `json:"input"`
	CanonicalAddress  string `json:"canonical_address"`
	HostType          string `json:"host_type"`
	Host              string `json:"host"`
	UDPPort           uint16 `json:"udp_port"`
	Certhash          string `json:"certhash"`
	CerthashDigestHex string `json:"certhash_digest_hex"`
	PeerID            string `json:"peer_id"`
	PublicKeyHex      string `json:"public_key_hex"`
}

type buildVector struct {
	Name            string `json:"name"`
	HostType        string `json:"host_type"`
	Host            string `json:"host"`
	UDPPort         uint16 `json:"udp_port"`
	Certhash        string `json:"certhash"`
	PublicKeyHex    string `json:"public_key_hex"`
	ExpectedPeerID  string `json:"expected_peer_id"`
	ExpectedAddress string `json:"expected_address"`
}

type invalidBuildVector struct {
	Name              string `json:"name"`
	HostType          string `json:"host_type"`
	Host              string `json:"host"`
	UDPPort           uint16 `json:"udp_port"`
	Certhash          string `json:"certhash"`
	PublicKeyHex      string `json:"public_key_hex"`
	ExpectedErrorCode string `json:"expected_error_code"`
	ExpectedStage     string `json:"expected_stage"`
}

type invalidVector struct {
	Name              string `json:"name"`
	Input             string `json:"input"`
	PinPublicKeyHex   string `json:"pin_public_key_hex"`
	PinPeerID         string `json:"pin_peer_id"`
	ExpectedErrorCode string `json:"expected_error_code"`
	ExpectedStage     string `json:"expected_stage"`
}

func readEndpointVectors(t *testing.T) endpointVectors {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not locate endpoint test")
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "testdata", "webrtc-direct-endpoint-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors endpointVectors
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	return vectors
}

func TestSharedEndpointVectors(t *testing.T) {
	vectors := readEndpointVectors(t)
	for _, vector := range vectors.Valid {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			endpoint, err := ParseEndpoint(vector.Input, nil)
			if err != nil {
				t.Fatal(err)
			}
			if endpoint.Addr.String() != vector.CanonicalAddress {
				t.Fatalf("address = %s, want %s", endpoint.Addr, vector.CanonicalAddress)
			}
			if endpoint.HostType != vector.HostType || endpoint.Host != vector.Host || endpoint.UDPPort != vector.UDPPort {
				t.Fatalf("host fields = %s/%s/%d", endpoint.HostType, endpoint.Host, endpoint.UDPPort)
			}
			if endpoint.Certhash != vector.Certhash || hex.EncodeToString(endpoint.CerthashDigest) != vector.CerthashDigestHex {
				t.Fatalf("certificate fields = %s/%x", endpoint.Certhash, endpoint.CerthashDigest)
			}
			if endpoint.PeerID.String() != vector.PeerID || hex.EncodeToString(endpoint.PublicKey) != vector.PublicKeyHex {
				t.Fatalf("identity fields = %s/%x", endpoint.PeerID, endpoint.PublicKey)
			}
		})
	}

	for _, vector := range vectors.Build {
		vector := vector
		t.Run("build-"+vector.Name, func(t *testing.T) {
			publicKey, err := hex.DecodeString(vector.PublicKeyHex)
			if err != nil {
				t.Fatal(err)
			}
			endpoint, err := BuildEndpoint(EndpointInput{
				HostType:  vector.HostType,
				Host:      vector.Host,
				UDPPort:   vector.UDPPort,
				Certhash:  vector.Certhash,
				PublicKey: publicKey,
			})
			if err != nil {
				t.Fatal(err)
			}
			if endpoint.Addr.String() != vector.ExpectedAddress || endpoint.PeerID.String() != vector.ExpectedPeerID {
				t.Fatalf("built endpoint = %s/%s", endpoint.Addr, endpoint.PeerID)
			}
			endpointPublicKeyBeforeInputMutation := append([]byte(nil), endpoint.PublicKey...)
			publicKey[0] ^= 0xff
			if !equalBytes(endpoint.PublicKey, endpointPublicKeyBeforeInputMutation) {
				t.Fatal("endpoint public key shares input storage")
			}
			endpoint.PublicKey[0] ^= 0xff
			if endpoint.PublicKey[0] == endpointPublicKeyBeforeInputMutation[0] {
				t.Fatal("endpoint public key is not independently writable")
			}
		})
	}

	for _, vector := range vectors.BuildInvalid {
		vector := vector
		t.Run("build-invalid-"+vector.Name, func(t *testing.T) {
			publicKey, err := hex.DecodeString(vector.PublicKeyHex)
			if err != nil {
				t.Fatal(err)
			}
			_, err = BuildEndpoint(EndpointInput{
				HostType:  vector.HostType,
				Host:      vector.Host,
				UDPPort:   vector.UDPPort,
				Certhash:  vector.Certhash,
				PublicKey: publicKey,
			})
			if err == nil {
				t.Fatal("unsafe builder input unexpectedly succeeded")
			}
			var endpointErr *Error
			if !errors.As(err, &endpointErr) {
				t.Fatalf("error is not *Error: %T", err)
			}
			if endpointErr.Code != vector.ExpectedErrorCode || endpointErr.Stage != vector.ExpectedStage {
				t.Fatalf("error = %s/%s, want %s/%s", endpointErr.Code, endpointErr.Stage, vector.ExpectedErrorCode, vector.ExpectedStage)
			}
		})
	}
}

func TestInvalidEndpointVectors(t *testing.T) {
	vectors := readEndpointVectors(t)
	for _, vector := range vectors.Invalid {
		vector := vector
		t.Run(vector.Name, func(t *testing.T) {
			var pin *EndpointPin
			if vector.PinPublicKeyHex != "" || vector.PinPeerID != "" {
				pin = &EndpointPin{}
				if vector.PinPublicKeyHex != "" {
					var err error
					pin.PublicKey, err = hex.DecodeString(vector.PinPublicKeyHex)
					if err != nil {
						t.Fatal(err)
					}
				}
				if vector.PinPeerID != "" {
					var err error
					pin.PeerID, err = peer.Decode(vector.PinPeerID)
					if err != nil {
						t.Fatal(err)
					}
				}
			}
			_, err := ParseEndpoint(vector.Input, pin)
			if err == nil {
				t.Fatal("endpoint unexpectedly parsed")
			}
			var endpointErr *Error
			if !errors.As(err, &endpointErr) {
				t.Fatalf("error is not *Error: %T", err)
			}
			if endpointErr.Code != vector.ExpectedErrorCode || endpointErr.Stage != vector.ExpectedStage {
				t.Fatalf("error = %s/%s, want %s/%s", endpointErr.Code, endpointErr.Stage, vector.ExpectedErrorCode, vector.ExpectedStage)
			}
			switch vector.ExpectedErrorCode {
			case CodeAddress:
				if !errors.Is(err, ErrWebRTCDirectAddress) {
					t.Fatal("errors.Is did not match address sentinel")
				}
			case CodeCerthash:
				if !errors.Is(err, ErrWebRTCDirectCerthash) {
					t.Fatal("errors.Is did not match certhash sentinel")
				}
			case CodePeerID:
				if !errors.Is(err, ErrWebRTCDirectPeerID) {
					t.Fatal("errors.Is did not match peer id sentinel")
				}
			}
		})
	}
}

func TestEndpointPinAndIdentityBoundaries(t *testing.T) {
	vectors := readEndpointVectors(t)
	valid := vectors.Valid[0]
	publicKey, err := hex.DecodeString(valid.PublicKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	peerID, err := peer.Decode(valid.PeerID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseEndpoint(valid.Input, &EndpointPin{PublicKey: publicKey, PeerID: peerID}); err != nil {
		t.Fatal(err)
	}
	wrong, err := identity.PublicKeyFromPeerID(peerID)
	if err != nil {
		t.Fatal(err)
	}
	wrong[0] ^= 0xff
	if _, err := ParseEndpoint(valid.Input, &EndpointPin{PublicKey: wrong}); !errors.Is(err, ErrWebRTCDirectPeerID) {
		t.Fatalf("wrong public-key pin error = %v", err)
	}
}
