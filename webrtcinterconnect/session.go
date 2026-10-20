package webrtcinterconnect

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
	manet "github.com/multiformats/go-multiaddr/net"
	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

// session is one signaling attempt between two peers.
type session struct {
	t            *Transport
	role         Role
	connectionID string
	attemptID    string
	localPeer    peer.ID
	remotePeer   peer.ID

	ctx    context.Context
	cancel context.CancelFunc

	mu                 sync.Mutex
	pc                 *webrtc.PeerConnection
	dc                 *webrtc.DataChannel
	sequence           int64
	lastRemoteSeq      int64
	remoteDescSet      bool
	queuedRemote       []webrtc.ICECandidateInit
	localDescPublished bool
	queuedLocal        []Signal
	closed             bool
	finished           bool
	failure            error
	detached           bool

	channelReady  chan struct{}
	channelOnce   sync.Once
	connected     chan struct{}
	connectedOnce sync.Once
	answerReady   chan struct{}
	answerOnce    sync.Once
	done          chan struct{}
	doneOnce      sync.Once
}

func newSession(t *Transport, role Role, connectionID, attemptID string, remote peer.ID, parent context.Context, timeout time.Duration) *session {
	ctx, cancel := context.WithTimeout(parent, timeout)
	s := &session{
		t:             t,
		role:          role,
		connectionID:  connectionID,
		attemptID:     attemptID,
		localPeer:     t.self,
		remotePeer:    remote,
		ctx:           ctx,
		cancel:        cancel,
		lastRemoteSeq: -1,
		channelReady:  make(chan struct{}),
		connected:     make(chan struct{}),
		answerReady:   make(chan struct{}),
		done:          make(chan struct{}),
	}
	go func() {
		select {
		case <-ctx.Done():
			s.mu.Lock()
			finished := s.finished
			s.mu.Unlock()
			if !finished {
				s.close()
			}
		case <-s.done:
		}
	}()
	return s
}

// finish stops the setup timeout watcher after a successful upgrade while
// keeping the established connection alive.
func (s *session) finish() {
	s.mu.Lock()
	s.finished = true
	s.mu.Unlock()
	s.cancel()
	s.t.finishSession(s)
}

func (s *session) nextSequence() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	value := s.sequence
	s.sequence++
	return value
}

func (s *session) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

func (s *session) setFailure(err error) {
	s.mu.Lock()
	if s.failure == nil && err != nil {
		s.failure = err
	}
	s.mu.Unlock()
	s.doneOnce.Do(func() { close(s.done) })
}

func (s *session) close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	pc := s.pc
	s.mu.Unlock()
	s.cancel()
	if pc != nil {
		_ = pc.Close()
	}
	s.doneOnce.Do(func() { close(s.done) })
	s.t.removeSession(s)
}

func (s *session) wait(ctx context.Context, ch <-chan struct{}) error {
	select {
	case <-ch:
		return nil
	case <-s.done:
		s.mu.Lock()
		err := s.failure
		s.mu.Unlock()
		if err == nil {
			err = errSessionClosed
		}
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *session) createPeerConnection() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pc != nil {
		return nil
	}
	engine := webrtc.SettingEngine{}
	engine.DetachDataChannels()
	engine.SetSCTPMaxMessageSize(uint32(s.t.options.DataChannelMaxMessageBytes))
	// Browsers hide host IPs behind mDNS (.local) candidates; accept and
	// resolve them instead of discarding, while still gathering plain IPs
	// locally (browser interop needs both directions).
	engine.SetICEMulticastDNSMode(ice.MulticastDNSModeQueryOnly)
	if s.t.options.IncludeLoopbackCandidates {
		engine.SetIncludeLoopbackCandidate(true)
	}
	api := webrtc.NewAPI(webrtc.WithSettingEngine(engine))
	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: toPionICEServers(s.t.options.ICEServers)})
	if err != nil {
		return interconnectError(CodeDial, StageConnect, "WebRTC peer connection could not be created", err)
	}
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) { s.publishLocalCandidate(candidate) })
	if os.Getenv("KM_WEBRTC_DEBUG") == "1" {
		pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
			fmt.Fprintf(os.Stderr, "webrtc: ice state %s\n", state)
		})
		pc.OnICEGatheringStateChange(func(state webrtc.ICEGatheringState) {
			fmt.Fprintf(os.Stderr, "webrtc: ice gathering %s\n", state)
		})
	}
	pc.OnDataChannel(func(channel *webrtc.DataChannel) { s.acceptChannel(channel) })
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateConnected:
			s.connectedOnce.Do(func() { close(s.connected) })
		case webrtc.PeerConnectionStateFailed:
			s.setFailure(interconnectError(CodeDial, StageConnect, "WebRTC peer connection failed", nil))
		case webrtc.PeerConnectionStateClosed:
			if !s.isClosed() {
				s.setFailure(interconnectError(CodeShutdown, StageConnect, "WebRTC peer connection closed before upgrade", nil))
			}
		}
	})
	s.pc = pc
	return nil
}

func (s *session) acceptChannel(channel *webrtc.DataChannel) {
	if channel.Label() != DataChannelLabel {
		_ = channel.Close()
		return
	}
	s.mu.Lock()
	if s.dc != nil && s.dc != channel {
		s.mu.Unlock()
		_ = channel.Close()
		return
	}
	s.dc = channel
	s.mu.Unlock()
	channel.OnOpen(func() { s.channelOnce.Do(func() { close(s.channelReady) }) })
	channel.OnClose(func() {
		if !s.isClosed() {
			s.setFailure(interconnectError(CodeShutdown, StageConnect, "WebRTC data channel closed before upgrade", nil))
		}
	})
	channel.OnError(func(err error) {
		if err != nil {
			s.setFailure(interconnectError(CodeDial, StageConnect, "WebRTC data channel error", err))
		}
	})
}

func (s *session) publishLocalCandidate(candidate *webrtc.ICECandidate) {
	if s.isClosed() {
		return
	}
	var signal Signal
	if candidate == nil {
		signal = Signal{Type: SignalEndOfCandidates}
	} else {
		init := candidate.ToJSON()
		signal = Signal{Type: SignalICECandidate, Candidate: ptrCandidate(fromPionCandidate(init))}
	}
	if err := s.publish(signal); err != nil {
		s.setFailure(err)
	}
}

func ptrCandidate(candidate ICECandidate) *ICECandidate { return &candidate }

func (s *session) publish(signal Signal) error {
	if s.isClosed() {
		return nil
	}
	s.mu.Lock()
	if !s.localDescPublished && signal.Type != SignalOffer && signal.Type != SignalAnswer {
		s.queuedLocal = append(s.queuedLocal, signal)
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	if err := s.sendEnvelope(s.ctx, newEnvelope(s, signal)); err != nil {
		return err
	}
	if signal.Type == SignalOffer || signal.Type == SignalAnswer {
		s.mu.Lock()
		s.localDescPublished = true
		queued := s.queuedLocal
		s.queuedLocal = nil
		s.mu.Unlock()
		for _, queuedSignal := range queued {
			if err := s.publish(queuedSignal); err != nil {
				return err
			}
		}
	}
	return nil
}

// runOutbound performs the initiator flow and returns the raw DataChannel
// connection once the channel is open and the peer connection is connected.
func (s *session) runOutbound(ctx context.Context) (manet.Conn, error) {
	if err := s.createPeerConnection(); err != nil {
		return nil, err
	}
	channel, err := s.pc.CreateDataChannel(DataChannelLabel, nil)
	if err != nil {
		return nil, interconnectError(CodeDial, StageConnect, "WebRTC data channel could not be created", err)
	}
	s.acceptChannel(channel)
	offer, err := s.pc.CreateOffer(nil)
	if err != nil {
		return nil, interconnectError(CodeDial, StageConnect, "WebRTC offer could not be created", err)
	}
	if err := s.pc.SetLocalDescription(offer); err != nil {
		return nil, interconnectError(CodeDial, StageConnect, "WebRTC offer could not be applied", err)
	}
	local := s.pc.LocalDescription()
	if local == nil {
		return nil, interconnectError(CodeDial, StageConnect, "WebRTC local description is missing", nil)
	}
	if err := s.publish(Signal{Type: SignalOffer, SDP: local.SDP}); err != nil {
		return nil, err
	}
	if err := s.wait(ctx, s.answerReady); err != nil {
		return nil, err
	}
	if err := s.wait(ctx, s.channelReady); err != nil {
		return nil, err
	}
	if err := s.wait(ctx, s.connected); err != nil {
		return nil, err
	}
	return s.detach()
}

// waitInbound completes the responder flow and returns the raw DataChannel
// connection once the channel is open and the peer connection is connected.
func (s *session) waitInbound(ctx context.Context) (manet.Conn, error) {
	if err := s.wait(ctx, s.channelReady); err != nil {
		return nil, err
	}
	if err := s.wait(ctx, s.connected); err != nil {
		return nil, err
	}
	return s.detach()
}

func (s *session) detach() (manet.Conn, error) {
	s.mu.Lock()
	if s.detached {
		s.mu.Unlock()
		return nil, errSessionClosed
	}
	channel := s.dc
	s.detached = true
	s.mu.Unlock()
	if channel == nil {
		return nil, interconnectError(CodeDial, StageConnect, "WebRTC data channel is not ready", nil)
	}
	conn, err := newDataChannelConn(
		channel,
		BuildAddress(s.localPeer),
		BuildAddress(s.remotePeer),
		s.t.options.DataChannelMaxMessageBytes,
		s.t.options.DataChannelMaxBufferedBytes,
	)
	if err != nil {
		return nil, interconnectError(CodeDial, StageConnect, "WebRTC data channel could not be detached", err)
	}
	return conn, nil
}

func (s *session) deliverRemoteCandidate(candidate webrtc.ICECandidateInit) error {
	s.mu.Lock()
	if !s.remoteDescSet {
		s.queuedRemote = append(s.queuedRemote, candidate)
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	return s.pc.AddICECandidate(candidate)
}

func (s *session) flushRemoteCandidates() error {
	s.mu.Lock()
	queued := s.queuedRemote
	s.queuedRemote = nil
	s.mu.Unlock()
	for _, candidate := range queued {
		if err := s.pc.AddICECandidate(candidate); err != nil {
			return err
		}
	}
	return nil
}

// receiveOffer applies an offer and publishes the answer. Early ICE signals
// captured before the offer are delivered between remote description and answer.
func (s *session) receiveOffer(_ context.Context, envelope Envelope, early []Envelope) error {
	if s.isClosed() {
		return nil
	}
	if s.role != RoleResponder {
		return interconnectError(CodeSignal, StageSignal, "initiator received an unexpected offer", nil)
	}
	if envelope.AttemptID != s.attemptID || envelope.From != s.remotePeer.String() {
		return nil
	}
	s.mu.Lock()
	if envelope.Sequence <= s.lastRemoteSeq {
		s.mu.Unlock()
		return nil
	}
	s.lastRemoteSeq = envelope.Sequence
	s.mu.Unlock()
	if err := ValidateEnvelope(envelope, s.t.options.MaxSignalBytes); err != nil {
		return err
	}
	if err := s.createPeerConnection(); err != nil {
		return err
	}
	if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: envelope.Signal.SDP}); err != nil {
		return interconnectError(CodeSignal, StageConnect, "WebRTC offer could not be applied", err)
	}
	s.mu.Lock()
	s.remoteDescSet = true
	s.mu.Unlock()
	for _, entry := range early {
		if entry.Signal.Type != SignalICECandidate || entry.Signal.Candidate == nil {
			continue
		}
		if err := s.deliverRemoteCandidate(toPionCandidate(*entry.Signal.Candidate)); err != nil {
			return interconnectError(CodeSignal, StageConnect, "WebRTC ICE candidate could not be applied", err)
		}
	}
	if err := s.flushRemoteCandidates(); err != nil {
		return interconnectError(CodeSignal, StageConnect, "WebRTC ICE candidate could not be applied", err)
	}
	answer, err := s.pc.CreateAnswer(nil)
	if err != nil {
		return interconnectError(CodeSignal, StageConnect, "WebRTC answer could not be created", err)
	}
	if err := s.pc.SetLocalDescription(answer); err != nil {
		return interconnectError(CodeSignal, StageConnect, "WebRTC answer could not be applied", err)
	}
	local := s.pc.LocalDescription()
	if local == nil {
		return interconnectError(CodeSignal, StageConnect, "WebRTC local description is missing", nil)
	}
	return s.publish(Signal{Type: SignalAnswer, SDP: local.SDP})
}

// receive applies a non-offer signal to an existing session.
func (s *session) receive(envelope Envelope) error {
	if s.isClosed() {
		return nil
	}
	if envelope.AttemptID != s.attemptID || envelope.From != s.remotePeer.String() {
		return nil
	}
	s.mu.Lock()
	if envelope.Sequence <= s.lastRemoteSeq {
		s.mu.Unlock()
		return nil
	}
	s.lastRemoteSeq = envelope.Sequence
	s.mu.Unlock()
	if err := ValidateEnvelope(envelope, s.t.options.MaxSignalBytes); err != nil {
		return err
	}
	switch envelope.Signal.Type {
	case SignalClose:
		s.close()
		return nil
	case SignalOffer:
		if s.role != RoleResponder {
			return interconnectError(CodeSignal, StageSignal, "initiator received an unexpected offer", nil)
		}
		return s.receiveOffer(s.ctx, envelope, nil)
	case SignalAnswer:
		if s.role != RoleInitiator {
			return interconnectError(CodeSignal, StageSignal, "responder received an unexpected answer", nil)
		}
		if err := s.acceptAnswer(envelope.Signal.SDP); err != nil {
			return err
		}
		s.answerOnce.Do(func() { close(s.answerReady) })
		return nil
	case SignalICECandidate:
		if envelope.Signal.Candidate == nil {
			return nil
		}
		if err := s.deliverRemoteCandidate(toPionCandidate(*envelope.Signal.Candidate)); err != nil {
			return interconnectError(CodeSignal, StageConnect, "WebRTC ICE candidate could not be applied", err)
		}
		return nil
	default:
		return nil
	}
}

func (s *session) acceptAnswer(sdp string) error {
	if err := s.createPeerConnection(); err != nil {
		return err
	}
	if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}); err != nil {
		return interconnectError(CodeSignal, StageConnect, "WebRTC answer could not be applied", err)
	}
	s.mu.Lock()
	s.remoteDescSet = true
	s.mu.Unlock()
	if err := s.flushRemoteCandidates(); err != nil {
		return interconnectError(CodeSignal, StageConnect, "WebRTC ICE candidate could not be applied", err)
	}
	return nil
}
