# @bsv8/bitcoin-libp2p

Standard libp2p secp256k1 identity for TypeScript with a non-extractable
identity adapter and two typed signing purposes: Noise static-key signing and
Signed Peer Record signing.

The host receives only the public key and a protected `TypedSigner`; it never
receives the business raw private key. See the repository documentation for
the protocol and signer contract.
