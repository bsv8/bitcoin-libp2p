# Demo-only Hello protocol

The examples use `/bitcoin-libp2p/demo/hello/1.0.0` as an application-owned
stream protocol. It is not registered by either SDK and is not part of the
identity or signer contract.

Each client opens a new stream on an already authenticated libp2p connection,
writes one non-empty UTF-8 message of at most 1 KiB, and half-closes its write
side. The server validates the complete message and replies with:

```text
hello, <original message>
```

The server then closes the stream. Empty, non-UTF-8, or oversized messages are
reset without stopping the host. The examples open two streams on the same
connection so that the second stream visibly reuses the Noise/Yamux session.

The payload never carries a public key, PeerId, signature, or token. An
application must obtain the remote identity from the authenticated libp2p
connection instead of trusting a business message.
