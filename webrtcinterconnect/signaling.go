package webrtcinterconnect

import "context"

// SignalAdapter moves interconnect envelopes through the caller's message
// service. It must not be tied to any specific transport; the SDK never
// imports SatSubscription, ChannelProtocol or business code.
type SignalAdapter interface {
	// Send delivers one envelope to its target. Implementations should return
	// an error when delivery is unknown or failed.
	Send(ctx context.Context, envelope Envelope) error

	// Subscribe registers a listener for inbound envelopes. The returned
	// function unsubscribes. The listener may be called from any goroutine.
	Subscribe(listener func(Envelope)) (unsubscribe func(), err error)
}
