# Identity Profile V1

This repository uses the standard libp2p identity wire formats. The profile
only fixes which public key is accepted and how it is checked; it does not add
a protocol.

## Identity truth

The business identity is a secp256k1 scalar encoded as exactly 32 big-endian
bytes. The scalar must be in `1..n-1`. Its identity public key is exactly the
33-byte compressed SEC1 point beginning with `02` or `03`.

Peer IDs are created by the native Go or JavaScript libp2p public-key and
PeerId APIs. The resulting identity multihash embeds the libp2p protobuf public
key. Implementations must not hand-build that protobuf, multihash, or its
Base58 display value.

When an address includes `/p2p/<peer-id>`, that component must equal the PeerId
derived from the supplied public key. A connection's authenticated remote
public key and PeerId are the identity truth; Identify application fields are
not a replacement for the security-upgraded connection.

## Standard protocols

V1 uses standard secp256k1 identity keys, Noise, Identify with Signed Peer
Records, Yamux, and the transport and application stream protocol selected by
the caller. Noise's X25519 key is generated and managed by the libp2p Noise
implementation. The business key is not used as a Noise key or as a data
encryption key.

The only identity signatures permitted through the SDK seam are the standard
Noise static-key signature and the standard Signed Peer Record signature. The
SDK has no private identity protocol, private Noise field, custom PeerId, or
business message envelope.
