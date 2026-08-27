# Security Model V1

The SDK separates public identity material from signing authority. A host
receives a 33-byte public key and a narrow typed signer. It never receives or
stores the business raw private key. The Go and TypeScript adapters expose the
upstream private-key shape only at the required seam; their `Raw`/`raw` access
always fails with `non-extractable`.

## Allowed signer purposes

The signer exposes only:

- `SignNoiseStaticKey`: exactly 32 bytes of the standard X25519 static public
  key. The adapter adds the fixed `noise-libp2p-static-key:` prefix for the
  standard libp2p payload.
- `SignPeerRecord`: a validated structured record containing the current PeerId,
  legal multiaddrs, and sequence number. Domain, payload type, protobuf
  encoding, hash, and DER format are fixed by the SDK.

There is no public `Sign(bytes)`, `SignDigest`, arbitrary domain, or raw-key
getter. Every response is parsed as strict low-S DER and verified locally with
the public key bound when the adapter was constructed. A changed signer key,
unknown purpose, invalid input, cancellation, or failed verification fails the
current operation closed.

Worker, HSM, or remote implementations own their session/owner/epoch/lease
state. Before and after an asynchronous request they must verify that state and
the active public key still match. AbortSignal/Context cancellation terminates
the SDK's wait; the SDK does not prescribe a transport or message protocol for
that service.

The test-only local signer is included to make vectors and single-process tests
repeatable. Its fixture key has no production funds or permissions and must not
be copied into a browser Window or a host process in production.
