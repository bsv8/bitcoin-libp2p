package webrtcinterconnect

import (
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"time"

	ma "github.com/multiformats/go-multiaddr"
	manet "github.com/multiformats/go-multiaddr/net"
	"github.com/pion/datachannel"
	"github.com/pion/webrtc/v4"
)

// multiaddrAddr adapts a multiaddr to net.Addr.
type multiaddrAddr struct{ addr ma.Multiaddr }

func (a multiaddrAddr) Network() string { return "webrtc" }
func (a multiaddrAddr) String() string  { return a.addr.String() }

// dataChannelConn adapts a detached pion DataChannel to manet.Conn so the
// standard libp2p upgrader can run Noise/Yamux over it.
type dataChannelConn struct {
	raw         datachannel.ReadWriteCloserDeadliner
	channel     *webrtc.DataChannel
	localAddr   ma.Multiaddr
	remoteAddr  ma.Multiaddr
	maxMessage  int
	maxBuffered int

	mu            sync.Mutex
	writeDeadline time.Time
	pendingRead   []byte
}

var _ manet.Conn = (*dataChannelConn)(nil)

func newDataChannelConn(
	channel *webrtc.DataChannel,
	localAddr, remoteAddr ma.Multiaddr,
	maxMessage, maxBuffered int,
) (*dataChannelConn, error) {
	raw, err := channel.DetachWithDeadline()
	if err != nil {
		return nil, err
	}
	return &dataChannelConn{
		raw:         raw,
		channel:     channel,
		localAddr:   localAddr,
		remoteAddr:  remoteAddr,
		maxMessage:  maxMessage,
		maxBuffered: maxBuffered,
	}, nil
}

func (c *dataChannelConn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	c.mu.Lock()
	if len(c.pendingRead) > 0 {
		n := copy(p, c.pendingRead)
		c.pendingRead = c.pendingRead[n:]
		c.mu.Unlock()
		return n, nil
	}
	c.mu.Unlock()

	// pion DataChannels are message oriented: a Read with a buffer smaller
	// than the next SCTP message returns io.ErrShortBuffer while leaving the
	// message queued. Retry with a larger buffer and serve the byte stream
	// from an internal buffer so Noise/Yamux see a regular net.Conn.
	readBuffer := make([]byte, 64*1024)
	for {
		n, err := c.raw.Read(readBuffer)
		if errors.Is(err, io.ErrShortBuffer) {
			size := n + 1
			if size < 64*1024 {
				size = 64 * 1024
			}
			readBuffer = make([]byte, size)
			continue
		}
		if err != nil {
			return 0, err
		}
		if n == 0 {
			continue
		}
		copied := copy(p, readBuffer[:n])
		if copied < n {
			c.mu.Lock()
			c.pendingRead = append(c.pendingRead[:0], readBuffer[copied:n]...)
			c.mu.Unlock()
		}
		return copied, nil
	}
}

// Write chunks into DataChannel message-sized writes and waits while the
// local SCTP buffer is above the configured limit.
func (c *dataChannelConn) Write(p []byte) (int, error) {
	total := 0
	for total < len(p) {
		chunk := p[total:]
		if len(chunk) > c.maxMessage {
			chunk = chunk[:c.maxMessage]
		}
		for c.channel.BufferedAmount() > uint64(c.maxBuffered) {
			if c.writeExpired() {
				return total, os.ErrDeadlineExceeded
			}
			time.Sleep(5 * time.Millisecond)
		}
		n, err := c.raw.Write(chunk)
		total += n
		if err != nil {
			return total, err
		}
		if n != len(chunk) {
			return total, errors.New("webrtc interconnect short data channel write")
		}
	}
	return total, nil
}

func (c *dataChannelConn) writeExpired() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.writeDeadline.IsZero() && !time.Now().Before(c.writeDeadline)
}

func (c *dataChannelConn) Close() error { return c.raw.Close() }

func (c *dataChannelConn) LocalAddr() net.Addr  { return multiaddrAddr{c.localAddr} }
func (c *dataChannelConn) RemoteAddr() net.Addr { return multiaddrAddr{c.remoteAddr} }

func (c *dataChannelConn) LocalMultiaddr() ma.Multiaddr  { return c.localAddr }
func (c *dataChannelConn) RemoteMultiaddr() ma.Multiaddr { return c.remoteAddr }

func (c *dataChannelConn) SetDeadline(t time.Time) error {
	if err := c.raw.SetReadDeadline(t); err != nil {
		return err
	}
	return c.raw.SetWriteDeadline(t)
}

func (c *dataChannelConn) SetReadDeadline(t time.Time) error {
	return c.raw.SetReadDeadline(t)
}

func (c *dataChannelConn) SetWriteDeadline(t time.Time) error {
	c.mu.Lock()
	c.writeDeadline = t
	c.mu.Unlock()
	return c.raw.SetWriteDeadline(t)
}

func toPionICEServers(servers []ICEServer) []webrtc.ICEServer {
	if len(servers) == 0 {
		return nil
	}
	out := make([]webrtc.ICEServer, 0, len(servers))
	for _, server := range servers {
		out = append(out, webrtc.ICEServer{
			URLs:       append([]string(nil), server.URLs...),
			Username:   server.Username,
			Credential: server.Credential,
		})
	}
	return out
}

func toPionCandidate(candidate ICECandidate) webrtc.ICECandidateInit {
	return webrtc.ICECandidateInit{
		Candidate:        candidate.Candidate,
		SDPMid:           candidate.SDPMid,
		SDPMLineIndex:    candidate.SDPMLineIndex,
		UsernameFragment: candidate.UsernameFragment,
	}
}

func fromPionCandidate(init webrtc.ICECandidateInit) ICECandidate {
	return ICECandidate{
		Candidate:        init.Candidate,
		SDPMid:           init.SDPMid,
		SDPMLineIndex:    init.SDPMLineIndex,
		UsernameFragment: init.UsernameFragment,
	}
}

var errSessionClosed = errors.New("webrtc interconnect session closed")
