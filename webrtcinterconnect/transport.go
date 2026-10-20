package webrtcinterconnect

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"sort"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	tpt "github.com/libp2p/go-libp2p/core/transport"
	ma "github.com/multiformats/go-multiaddr"
	manet "github.com/multiformats/go-multiaddr/net"
)

// BuildAddress returns the interconnect address `/webrtc/p2p/<peer-id>`.
func BuildAddress(peerID peer.ID) ma.Multiaddr {
	address, err := ma.NewMultiaddr(fmt.Sprintf("/webrtc/p2p/%s", peerID.String()))
	if err != nil {
		// Peer IDs produced by libp2p always encode to valid multiaddrs.
		panic(fmt.Sprintf("webrtcinterconnect: invalid peer id address: %v", err))
	}
	return address
}

// ParseAddress extracts the target peer ID from `/webrtc/p2p/<peer-id>`.
func ParseAddress(address ma.Multiaddr) (peer.ID, error) {
	if address == nil {
		return "", interconnectError(CodeAddress, StageValidate, "WebRTC interconnect address is required", nil)
	}
	components := address.Protocols()
	if len(components) != 2 || components[0].Code != ma.P_WEBRTC || components[1].Code != ma.P_P2P {
		return "", interconnectError(CodeAddress, StageValidate, "WebRTC interconnect address must be /webrtc/p2p/<peer-id>", nil)
	}
	value, err := address.ValueForProtocol(ma.P_P2P)
	if err != nil {
		return "", interconnectError(CodeAddress, StageValidate, "WebRTC interconnect peer id is invalid", err)
	}
	peerID, err := peer.Decode(value)
	if err != nil {
		return "", interconnectError(CodeAddress, StageValidate, "WebRTC interconnect peer id is invalid", err)
	}
	return peerID, nil
}

type earlySignalEntry struct {
	envelope  Envelope
	expiresAt time.Time
}

type completedAttempt struct {
	attemptID string
	expiresAt time.Time
}

// Transport implements the go-libp2p transport half of the interconnect.
type Transport struct {
	options  Options
	upgrader tpt.Upgrader
	rcmgr    network.ResourceManager
	self     peer.ID

	ctx    context.Context
	cancel context.CancelFunc

	mu               sync.Mutex
	sessions         map[string]*session
	earlySignals     map[string][]earlySignalEntry
	earlyCount       int
	completed        map[string]completedAttempt
	queuedSessionIDs []sessionIDs
	unsubscribe      func()
	listener         *inboundListener
	closed           bool
}

var _ tpt.Transport = (*Transport)(nil)

// New creates an interconnect transport with an already available upgrader,
// resource manager and local peer id. Tests use this directly; hosts use
// Factory through libp2p.Transport.
func New(options Options, upgrader tpt.Upgrader, rcmgr network.ResourceManager, self peer.ID) (*Transport, error) {
	resolved, err := options.withDefaults()
	if err != nil {
		return nil, err
	}
	if upgrader == nil {
		return nil, interconnectError(CodeNotConfigured, StageValidate, "WebRTC interconnect upgrader is required", nil)
	}
	if rcmgr == nil {
		rcmgr = &network.NullResourceManager{}
	}
	ctx, cancel := context.WithCancel(context.Background())
	t := &Transport{
		options:      resolved,
		upgrader:     upgrader,
		rcmgr:        rcmgr,
		self:         self,
		ctx:          ctx,
		cancel:       cancel,
		sessions:     map[string]*session{},
		earlySignals: map[string][]earlySignalEntry{},
		completed:    map[string]completedAttempt{},
	}
	unsubscribe, err := resolved.Signaling.Subscribe(t.receive)
	if err != nil {
		cancel()
		return nil, interconnectError(CodeNotConfigured, StageValidate, "WebRTC interconnect signaling subscribe failed", err)
	}
	t.unsubscribe = unsubscribe
	return t, nil
}

// Factory returns a constructor suitable for libp2p.Transport(...).
func Factory(options Options) func(tpt.Upgrader, network.ResourceManager, peer.ID) (tpt.Transport, error) {
	return func(upgrader tpt.Upgrader, rcmgr network.ResourceManager, self peer.ID) (tpt.Transport, error) {
		return New(options, upgrader, rcmgr, self)
	}
}

// Protocols returns the multiaddr protocols this transport serves.
func (t *Transport) Protocols() []int { return []int{ma.P_WEBRTC} }

// Proxy always returns false; the interconnect is not a proxy transport.
func (t *Transport) Proxy() bool { return false }

// CanDial reports whether addr is an interconnect address. The swarm strips
// the /p2p component before dialing, so `/webrtc` is dialable too.
func (t *Transport) CanDial(addr ma.Multiaddr) bool {
	return isListenAddress(addr)
}

// Listen registers the virtual inbound listener. There is no network socket:
// inbound sessions arrive through the signaling adapter. Listen accepts
// `/webrtc` (the canonical listen address) and `/webrtc/p2p/<peer-id>`.
func (t *Transport) Listen(addr ma.Multiaddr) (tpt.Listener, error) {
	if !isListenAddress(addr) {
		return nil, interconnectError(CodeAddress, StageValidate, "WebRTC interconnect listen address must be /webrtc", nil)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil, tpt.ErrListenerClosed
	}
	if t.listener != nil {
		return t.listener, nil
	}
	t.listener = newInboundListener(addr)
	return t.listener, nil
}

type sessionIDsContextKey struct{}

// QueueSessionIDs makes the next outbound dial use the given session
// identifiers. It exists for swarm-driven dials (host.Connect/NewStream),
// whose context does not reach the transport; browser interop queues the
// ChannelProtocol session id right before connecting to the buyer.
func (t *Transport) QueueSessionIDs(connectionID, attemptID string) error {
	if err := validateIdentifier(connectionID, "connectionId"); err != nil {
		return err
	}
	if err := validateIdentifier(attemptID, "attemptId"); err != nil {
		return err
	}
	t.mu.Lock()
	t.queuedSessionIDs = append(t.queuedSessionIDs, sessionIDs{connectionID: connectionID, attemptID: attemptID})
	t.mu.Unlock()
	return nil
}

func (t *Transport) takeQueuedSessionIDs() (sessionIDs, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.queuedSessionIDs) == 0 {
		return sessionIDs{}, false
	}
	next := t.queuedSessionIDs[0]
	t.queuedSessionIDs = t.queuedSessionIDs[1:]
	return next, true
}

type sessionIDs struct {
	connectionID string
	attemptID    string
}

// WithSessionIDs attaches caller-chosen session identifiers to a dial context.
// Browser interop uses the ChannelProtocol WebRTC session id as the connection
// id so both sides route signals under the same name. The identifiers apply to
// the next dial performed with this context.
func WithSessionIDs(ctx context.Context, connectionID, attemptID string) (context.Context, error) {
	if err := validateIdentifier(connectionID, "connectionId"); err != nil {
		return ctx, err
	}
	if err := validateIdentifier(attemptID, "attemptId"); err != nil {
		return ctx, err
	}
	return context.WithValue(ctx, sessionIDsContextKey{}, sessionIDs{connectionID: connectionID, attemptID: attemptID}), nil
}

func sessionIDsFrom(ctx context.Context) (string, string, bool) {
	if ctx == nil {
		return "", "", false
	}
	value, ok := ctx.Value(sessionIDsContextKey{}).(sessionIDs)
	if !ok {
		return "", "", false
	}
	return value.connectionID, value.attemptID, true
}

// Dial performs the initiator flow and returns an upgraded libp2p connection.
// The swarm strips the /p2p component before dialing, so the target peer ID
// is taken from the address when present and from p otherwise.
func (t *Transport) Dial(ctx context.Context, raddr ma.Multiaddr, p peer.ID) (tpt.CapableConn, error) {
	target, err := targetPeer(raddr, p)
	if err != nil {
		return nil, err
	}
	connectionID, attemptID := randomID(), randomID()
	if customID, customAttempt, ok := sessionIDsFrom(ctx); ok {
		connectionID, attemptID = customID, customAttempt
	} else if queued, ok := t.takeQueuedSessionIDs(); ok {
		connectionID, attemptID = queued.connectionID, queued.attemptID
	}
	sess := newSession(t, RoleInitiator, connectionID, attemptID, target, ctx, t.options.ConnectionTimeout)
	t.registerSession(sess)
	raw, err := sess.runOutbound(sess.ctx)
	if err != nil {
		sess.close()
		return nil, wrapDialError(err)
	}
	upgraded, err := t.upgrade(sess.ctx, raw, network.DirOutbound, target)
	if err != nil {
		sess.close()
		return nil, err
	}
	sess.finish()
	return upgraded, nil
}

// DialSession is Dial with caller-provided session identifiers. Browser
// interop uses the ChannelProtocol WebRTC session id as the connection id, so
// both sides route signals to the same session under its own name.
func (t *Transport) DialSession(ctx context.Context, raddr ma.Multiaddr, p peer.ID, connectionID, attemptID string) (tpt.CapableConn, error) {
	if err := validateIdentifier(connectionID, "connectionId"); err != nil {
		return nil, err
	}
	if err := validateIdentifier(attemptID, "attemptId"); err != nil {
		return nil, err
	}
	target, err := targetPeer(raddr, p)
	if err != nil {
		return nil, err
	}
	sess := newSession(t, RoleInitiator, connectionID, attemptID, target, ctx, t.options.ConnectionTimeout)
	t.registerSession(sess)
	raw, err := sess.runOutbound(sess.ctx)
	if err != nil {
		sess.close()
		return nil, wrapDialError(err)
	}
	upgraded, err := t.upgrade(sess.ctx, raw, network.DirOutbound, target)
	if err != nil {
		sess.close()
		return nil, err
	}
	sess.finish()
	return upgraded, nil
}

func wrapDialError(err error) error {
	var interconnect *Error
	if errors.As(err, &interconnect) {
		return err
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return interconnectError(CodeTimeout, StageConnect, "WebRTC interconnect connection timed out", err)
	}
	return interconnectError(CodeDial, StageConnect, "WebRTC interconnect connection failed", err)
}

// Close stops the transport, its sessions and the signaling subscription.
func (t *Transport) Close() error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil
	}
	t.closed = true
	unsubscribe := t.unsubscribe
	listener := t.listener
	sessions := make([]*session, 0, len(t.sessions))
	for _, sess := range t.sessions {
		sessions = append(sessions, sess)
	}
	t.mu.Unlock()
	if unsubscribe != nil {
		unsubscribe()
	}
	if listener != nil {
		_ = listener.Close()
	}
	for _, sess := range sessions {
		sess.close()
	}
	t.cancel()
	return nil
}

func (t *Transport) upgrade(ctx context.Context, conn manet.Conn, dir network.Direction, remote peer.ID) (tpt.CapableConn, error) {
	scope, err := t.rcmgr.OpenConnection(dir, false, conn.RemoteMultiaddr())
	if err != nil {
		_ = conn.Close()
		return nil, interconnectError(CodeDial, StageConnect, "WebRTC connection scope could not be opened", err)
	}
	upgraded, err := t.upgrader.Upgrade(ctx, t, conn, dir, remote, scope)
	if err != nil {
		scope.Done()
		_ = conn.Close()
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			return nil, interconnectError(CodeTimeout, StageConnect, "WebRTC interconnect upgrade timed out", err)
		}
		return nil, interconnectError(CodeAuth, StageAuthenticate, "WebRTC connection upgrade failed", err)
	}
	return upgraded, nil
}

func (t *Transport) registerSession(sess *session) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.sessions[sess.connectionID] = sess
}

func (t *Transport) removeSession(sess *session) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.sessions[sess.connectionID] == sess {
		delete(t.sessions, sess.connectionID)
	}
}

func (t *Transport) finishSession(sess *session) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.sessions[sess.connectionID] == sess {
		delete(t.sessions, sess.connectionID)
	}
	t.completed[sess.connectionID] = completedAttempt{
		attemptID: sess.attemptID,
		expiresAt: time.Now().Add(t.options.SignalLifetime),
	}
	t.pruneLocked(time.Now())
}

func (t *Transport) registerCompleted(connectionID, attemptID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.completed[connectionID] = completedAttempt{attemptID: attemptID, expiresAt: time.Now().Add(t.options.SignalLifetime)}
}

// receive routes an inbound envelope. It is safe to call from any goroutine.
func (t *Transport) receive(raw Envelope) {
	if t.isClosed() {
		return
	}
	if raw.To != t.self.String() {
		return
	}
	t.mu.Lock()
	if completed, ok := t.completed[raw.ConnectionID]; ok && completed.attemptID == raw.AttemptID {
		t.mu.Unlock()
		return
	}
	sess := t.sessions[raw.ConnectionID]
	if sess == nil && raw.Signal.Type != SignalOffer {
		if isEarlySignalType(raw.Signal.Type) {
			t.bufferEarlySignalLocked(raw)
		}
		t.mu.Unlock()
		return
	}
	if sess == nil {
		remote, err := peer.Decode(raw.From)
		if err != nil {
			t.mu.Unlock()
			return
		}
		sess = newSession(t, RoleResponder, raw.ConnectionID, raw.AttemptID, remote, t.ctx, t.options.ConnectionTimeout)
		t.sessions[raw.ConnectionID] = sess
	}
	t.mu.Unlock()
	if sess.attemptID != raw.AttemptID || sess.remotePeer.String() != raw.From {
		return
	}
	if raw.Signal.Type == SignalOffer {
		early := t.takeEarlySignals(raw.ConnectionID, raw.AttemptID, raw.From)
		if err := sess.receiveOffer(t.ctx, raw, early); err != nil {
			sess.close()
			return
		}
		go t.completeInbound(sess)
		return
	}
	if err := sess.receive(raw); err != nil {
		sess.close()
	}
}

func (t *Transport) completeInbound(sess *session) {
	conn, err := sess.waitInbound(sess.ctx)
	if err != nil {
		sess.close()
		return
	}
	upgraded, err := t.upgrade(sess.ctx, conn, network.DirInbound, sess.remotePeer)
	if err != nil {
		sess.close()
		return
	}
	sess.finish()
	if err := t.deliverInbound(upgraded); err != nil {
		_ = upgraded.Close()
	}
}

func (t *Transport) deliverInbound(conn tpt.CapableConn) error {
	t.mu.Lock()
	listener := t.listener
	closed := t.closed
	t.mu.Unlock()
	if closed || listener == nil {
		return interconnectError(CodeShutdown, StageShutdown, "WebRTC interconnect has no inbound listener", nil)
	}
	select {
	case listener.conns <- conn:
		return nil
	case <-listener.closed:
		return tpt.ErrListenerClosed
	}
}

func (t *Transport) isClosed() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.closed
}

func isEarlySignalType(signalType SignalType) bool {
	return signalType == SignalICECandidate || signalType == SignalEndOfCandidates
}

// isListenAddress accepts `/webrtc` and `/webrtc/p2p/<peer-id>`.
func isListenAddress(address ma.Multiaddr) bool {
	if address == nil {
		return false
	}
	components := address.Protocols()
	if len(components) == 1 {
		return components[0].Code == ma.P_WEBRTC
	}
	if len(components) == 2 {
		return components[0].Code == ma.P_WEBRTC && components[1].Code == ma.P_P2P
	}
	return false
}

// targetPeer resolves the dial target from the address and/or the requested
// peer id, rejecting mismatches.
func targetPeer(address ma.Multiaddr, requested peer.ID) (peer.ID, error) {
	if !isListenAddress(address) {
		return "", interconnectError(CodeAddress, StageValidate, "WebRTC interconnect address must be /webrtc/p2p/<peer-id>", nil)
	}
	var fromAddress peer.ID
	if parsed, err := ParseAddress(address); err == nil {
		fromAddress = parsed
	}
	switch {
	case fromAddress != "" && requested != "" && fromAddress != requested:
		return "", interconnectError(CodeAddress, StageValidate, "WebRTC dial address does not match the requested peer", nil)
	case fromAddress != "":
		return fromAddress, nil
	case requested != "":
		return requested, nil
	default:
		return "", interconnectError(CodeAddress, StageValidate, "WebRTC dial address is missing a target peer", nil)
	}
}

func (t *Transport) bufferEarlySignalLocked(envelope Envelope) {
	now := time.Now()
	t.pruneLocked(now)
	if t.earlyCount >= t.options.MaxEarlySignals {
		return
	}
	queue := t.earlySignals[envelope.ConnectionID]
	if len(queue) >= t.options.maxEarlySignalsPerConnection() {
		return
	}
	expiresAt := time.UnixMilli(envelope.ExpiresAtMs)
	if lifetime := now.Add(t.options.SignalLifetime); expiresAt.After(lifetime) {
		expiresAt = lifetime
	}
	if !expiresAt.After(now) {
		return
	}
	t.earlySignals[envelope.ConnectionID] = append(queue, earlySignalEntry{envelope: envelope, expiresAt: expiresAt})
	t.earlyCount++
}

func (t *Transport) takeEarlySignals(connectionID, attemptID, from string) []Envelope {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	t.pruneLocked(now)
	queue := t.earlySignals[connectionID]
	if len(queue) == 0 {
		return nil
	}
	t.earlyCount -= len(queue)
	delete(t.earlySignals, connectionID)
	result := make([]Envelope, 0, len(queue))
	for _, entry := range queue {
		if entry.expiresAt.After(now) && entry.envelope.AttemptID == attemptID && entry.envelope.From == from && isEarlySignalType(entry.envelope.Signal.Type) {
			result = append(result, entry.envelope)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Sequence < result[j].Sequence })
	return result
}

func (t *Transport) pruneLocked(now time.Time) {
	for connectionID, queue := range t.earlySignals {
		active := queue[:0]
		for _, entry := range queue {
			if entry.expiresAt.After(now) {
				active = append(active, entry)
			} else {
				t.earlyCount--
			}
		}
		if len(active) == 0 {
			delete(t.earlySignals, connectionID)
		} else {
			t.earlySignals[connectionID] = active
		}
	}
	for connectionID, completed := range t.completed {
		if !completed.expiresAt.After(now) {
			delete(t.completed, connectionID)
		}
	}
}

// inboundListener is a virtual listener fed by completed inbound sessions.
type inboundListener struct {
	addr      ma.Multiaddr
	conns     chan tpt.CapableConn
	closed    chan struct{}
	closeOnce sync.Once
}

func newInboundListener(addr ma.Multiaddr) *inboundListener {
	return &inboundListener{
		addr:   addr,
		conns:  make(chan tpt.CapableConn, 8),
		closed: make(chan struct{}),
	}
}

func (l *inboundListener) Accept() (tpt.CapableConn, error) {
	select {
	case conn := <-l.conns:
		return conn, nil
	case <-l.closed:
		return nil, tpt.ErrListenerClosed
	}
}

func (l *inboundListener) Close() error {
	l.closeOnce.Do(func() { close(l.closed) })
	return nil
}

func (l *inboundListener) Addr() net.Addr { return multiaddrAddr{l.addr} }

func (l *inboundListener) Multiaddr() ma.Multiaddr { return l.addr }

func randomID() string {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		panic(fmt.Sprintf("webrtcinterconnect: random id generation failed: %v", err))
	}
	return base64.RawURLEncoding.EncodeToString(buffer)
}
