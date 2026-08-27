package golibp2p

import (
	"fmt"
	"sync"
	"time"

	"github.com/bsv8/bitcoin-libp2p/signer"
	libp2p "github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/p2p/muxer/yamux"
	"github.com/libp2p/go-libp2p/p2p/security/noise"
	"github.com/libp2p/go-libp2p/p2p/transport/quicreuse"
	"github.com/libp2p/go-libp2p/p2p/transport/tcp"
	ma "github.com/multiformats/go-multiaddr"
)

// Service is an application-owned handler installer. The SDK never registers
// a production identity protocol or a test echo protocol.
type Service func(host.Host) error

type HostConfig struct {
	Signer signer.Signer

	// ListenAddrs, MuxerOptions and TransportOptions are deliberately
	// caller-owned. The SDK supplies standard Noise, Yamux and Identify while
	// allowing an application to choose its transport and business handlers.
	ListenAddrs      []ma.Multiaddr
	MuxerOptions     []libp2p.Option
	TransportOptions []libp2p.Option
	Services         []Service
	SignTimeout      time.Duration
}

type managedHost struct {
	host.Host
	identity *Identity
	once     sync.Once
}

func (h *managedHost) Close() error {
	h.once.Do(h.identity.Close)
	return h.Host.Close()
}

func NewHost(config HostConfig) (host.Host, error) {
	identityOptions := make([]IdentityOption, 0, 1)
	if config.SignTimeout > 0 {
		identityOptions = append(identityOptions, WithSignTimeout(config.SignTimeout))
	}
	identityAdapter, err := NewIdentityAdapter(config.Signer, identityOptions...)
	if err != nil {
		return nil, err
	}
	options := []libp2p.Option{
		libp2p.Identity(identityAdapter),
		libp2p.Security(noise.ID, noise.New),
		libp2p.Muxer(yamux.ID, yamux.DefaultTransport),
		// QUIC/WebTransport/WebRTC constructors in go-libp2p v0.49 may
		// derive transport material from PrivKey.Raw. TCP is the safe default;
		// callers can explicitly inject another transport after reviewing its
		// key boundary.
		libp2p.Transport(tcp.NewTCPTransport),
		// go-libp2p wires the default QUIC key providers even when no QUIC
		// transport is selected. Replacing that unused provider keeps the
		// non-extractable TCP path from asking Identity.Raw().
		libp2p.QUICReuse(func() (*quicreuse.ConnManager, error) { return nil, nil }),
	}
	options = append(options, config.MuxerOptions...)
	if len(config.ListenAddrs) > 0 {
		options = append(options, libp2p.ListenAddrs(config.ListenAddrs...))
	}
	options = append(options, config.TransportOptions...)
	h, err := libp2p.New(options...)
	if err != nil {
		identityAdapter.Close()
		return nil, fmt.Errorf("create standard Noise host: %w", err)
	}
	for _, service := range config.Services {
		if service == nil {
			continue
		}
		if err := service(h); err != nil {
			identityAdapter.Close()
			_ = h.Close()
			return nil, fmt.Errorf("install service: %w", err)
		}
	}
	return &managedHost{Host: h, identity: identityAdapter}, nil
}
