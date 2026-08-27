# bitcoin-libp2p

```text
npm install bitcoin-libp2p@0.1.0
```

Standard libp2p secp256k1 identity for TypeScript with a non-extractable
identity adapter and two typed signing purposes: Noise static-key signing and
Signed Peer Record signing.

The host receives only the public key and a protected `TypedSigner`; it never
receives the business raw private key. See the repository documentation for
the protocol and signer contract.

Public ESM entry points are the package root plus `/identity`, `/signer` and
`/libp2p`; each entry point publishes its corresponding TypeScript declarations.
