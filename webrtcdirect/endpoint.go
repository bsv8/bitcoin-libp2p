// Package webrtcdirect validates and normalizes WebRTC Direct endpoints.
//
// It only handles endpoint data. It does not create a libp2p host or listener,
// prove UDP/DNS/firewall reachability, or access a private key.
package webrtcdirect

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"

	"github.com/bsv8/bitcoin-libp2p/identity"
	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
	"github.com/multiformats/go-multibase"
	mh "github.com/multiformats/go-multihash"
)

const (
	StageValidate = "validate"

	CodeAddress  = "ERR_WEBRTC_DIRECT_ADDRESS"
	CodeCerthash = "ERR_WEBRTC_DIRECT_CERTHASH"
	CodePeerID   = "ERR_WEBRTC_DIRECT_PEER_ID"
)

var (
	// ErrWebRTCDirectAddress 表示地址结构、主机、端口或组件顺序错误。
	ErrWebRTCDirectAddress = errors.New(CodeAddress)
	// ErrWebRTCDirectCerthash 表示 certhash 缺失、编码错误或算法/长度不支持。
	ErrWebRTCDirectCerthash = errors.New(CodeCerthash)
	// ErrWebRTCDirectPeerID 表示 PeerId 非 secp256k1 或身份 pin 不一致。
	ErrWebRTCDirectPeerID = errors.New(CodePeerID)

	// Short aliases make errors.Is checks convenient while retaining the stable
	// ERR_WEBRTC_DIRECT_* sentinel names above.
	ErrAddress  = ErrWebRTCDirectAddress
	ErrCerthash = ErrWebRTCDirectCerthash
	ErrPeerID   = ErrWebRTCDirectPeerID
)

// Error is a stable endpoint validation error with an optional underlying cause.
type Error struct {
	Code  string
	Stage string
	Cause error
}

func (e *Error) Error() string {
	if e.Cause == nil {
		return e.Code + ": " + e.Stage
	}
	return e.Code + ": " + e.Stage + ": " + e.Cause.Error()
}

func (e *Error) Unwrap() error { return e.Cause }

func (e *Error) Is(target error) bool {
	switch e.Code {
	case CodeAddress:
		return target == ErrWebRTCDirectAddress
	case CodeCerthash:
		return target == ErrWebRTCDirectCerthash
	case CodePeerID:
		return target == ErrWebRTCDirectPeerID
	default:
		return false
	}
}

// Endpoint 是规范化后的完整 WebRTC Direct 地址。
type Endpoint struct {
	// Addr 是包含主机、UDP、webrtc-direct、certhash 和 p2p 的完整地址。
	Addr ma.Multiaddr
	// HostType 是 ip4/ip6/dns/dns4/dns6 之一。
	HostType string
	// Host 是 IP 地址或 DNS 名称；DNS 仅在实际拨号阶段解析。
	Host string
	// UDPPort 是 1..65535 范围内的 UDP 端口。
	UDPPort uint16
	// Certhash 是规范化的 base64url multibase 证书指纹。
	Certhash string
	// CerthashDigest 是 SHA2-256 multihash 中 32 字节 digest 的副本。
	CerthashDigest []byte
	// PeerID 是地址声明的 secp256k1 PeerId。
	PeerID peer.ID
	// PublicKey 是从 PeerID 取回的 33 字节压缩公钥副本。
	PublicKey []byte
}

// EndpointPin 是可选的长期业务身份 pin。空值表示对应字段未提供。
type EndpointPin struct {
	// PublicKey 是期望的 33 字节压缩 secp256k1 公钥。
	PublicKey []byte
	// PeerID 是期望的 PeerId。
	PeerID peer.ID
}

// EndpointInput 是构造 endpoint 的输入；PublicKey 与 PeerID 至少提供一个。
type EndpointInput struct {
	// HostType 是 ip4/ip6/dns/dns4/dns6 之一。
	HostType string
	// Host 是 IP 地址或 DNS 名称。
	Host string
	// UDPPort 是 1..65535 范围内的监听端口。
	UDPPort uint16
	// Certhash 是服务端当前 DTLS 证书指纹。
	Certhash string
	// PublicKey 是业务公钥；未提供 PeerID 时据此派生 PeerId。
	PublicKey []byte
	// PeerID 是地址 PeerId；未提供 PublicKey 时据此提取公钥。
	PeerID peer.ID
}

// ParseEndpoint 解析并校验严格的 WebRTC Direct multiaddr。
func ParseEndpoint(address string, pin *EndpointPin) (*Endpoint, error) {
	addr, err := ma.NewMultiaddr(address)
	if err != nil {
		return nil, endpointError(classifyRawAddressError(address), fmt.Errorf("address is not a valid multiaddr: %w", err))
	}
	components := ma.Split(addr)
	if err := checkComponentShape(components); err != nil {
		return nil, err
	}

	hostType := components[0].Protocol().Name
	host := components[0].Value()
	if !isHostType(hostType) || !validHost(hostType, host) {
		return nil, endpointError(CodeAddress, errors.New("invalid host component"))
	}
	port, err := parsePort(components[1].Value())
	if err != nil {
		return nil, endpointError(CodeAddress, err)
	}
	cert, err := decodeCerthash(components[3].Value())
	if err != nil {
		return nil, err
	}
	peerID, err := peer.Decode(components[4].Value())
	if err != nil {
		return nil, endpointError(CodePeerID, fmt.Errorf("peer id is malformed: %w", err))
	}
	publicKey, err := identity.PublicKeyFromPeerID(peerID)
	if err != nil {
		return nil, endpointError(CodePeerID, err)
	}
	if err := validatePin(pin, publicKey, peerID); err != nil {
		return nil, err
	}

	normalizedAddr, err := makeAddress(hostType, host, port, cert.certhash, peerID)
	if err != nil {
		return nil, endpointError(CodeAddress, err)
	}
	return &Endpoint{
		Addr:           normalizedAddr,
		HostType:       hostType,
		Host:           host,
		UDPPort:        port,
		Certhash:       cert.certhash,
		CerthashDigest: append([]byte(nil), cert.digest...),
		PeerID:         peerID,
		PublicKey:      append([]byte(nil), publicKey...),
	}, nil
}

// BuildEndpoint 从字段构造并校验规范 WebRTC Direct endpoint。
func BuildEndpoint(input EndpointInput) (*Endpoint, error) {
	if !isHostType(input.HostType) || !validHost(input.HostType, input.Host) {
		return nil, endpointError(CodeAddress, errors.New("host type or host is invalid"))
	}
	if input.UDPPort == 0 {
		return nil, endpointError(CodeAddress, errors.New("UDP port must be in 1..65535"))
	}
	cert, err := decodeCerthash(input.Certhash)
	if err != nil {
		return nil, err
	}

	publicKey, peerID, err := identityForInput(input.PublicKey, input.PeerID)
	if err != nil {
		return nil, endpointError(CodePeerID, err)
	}
	normalizedAddr, err := makeAddress(input.HostType, input.Host, input.UDPPort, cert.certhash, peerID)
	if err != nil {
		return nil, endpointError(CodeAddress, err)
	}
	return &Endpoint{
		Addr:           normalizedAddr,
		HostType:       input.HostType,
		Host:           input.Host,
		UDPPort:        input.UDPPort,
		Certhash:       cert.certhash,
		CerthashDigest: append([]byte(nil), cert.digest...),
		PeerID:         peerID,
		PublicKey:      append([]byte(nil), publicKey...),
	}, nil
}

type decodedCerthash struct {
	certhash string
	digest   []byte
}

func decodeCerthash(value string) (decodedCerthash, error) {
	_, raw, err := multibase.Decode(value)
	if err != nil {
		return decodedCerthash{}, endpointError(CodeCerthash, fmt.Errorf("certhash multibase decode failed: %w", err))
	}
	decoded, err := mh.Decode(raw)
	if err != nil {
		return decodedCerthash{}, endpointError(CodeCerthash, fmt.Errorf("certhash multihash decode failed: %w", err))
	}
	if decoded.Code != mh.SHA2_256 || len(decoded.Digest) != 32 {
		return decodedCerthash{}, endpointError(CodeCerthash, errors.New("certhash must be SHA2-256 with a 32-byte digest"))
	}
	canonical, err := multibase.Encode(multibase.Base64url, raw)
	if err != nil {
		return decodedCerthash{}, endpointError(CodeCerthash, fmt.Errorf("certhash canonical encoding failed: %w", err))
	}
	return decodedCerthash{certhash: canonical, digest: append([]byte(nil), decoded.Digest...)}, nil
}

// go-multiaddr validates certhash and p2p values while parsing. Recover the
// stable high-level category before returning its lower-level parse cause.
func classifyRawAddressError(address string) string {
	if value, ok := rawComponentValue(address, "certhash"); ok && !isWellFormedCerthash(value) {
		return CodeCerthash
	}
	if value, ok := rawComponentValue(address, "p2p"); ok {
		if _, err := peer.Decode(value); err != nil {
			return CodePeerID
		}
	}
	return CodeAddress
}

func rawComponentValue(address, name string) (string, bool) {
	parts := strings.Split(strings.Trim(address, "/"), "/")
	for index := 0; index+1 < len(parts); index++ {
		if parts[index] == name {
			return parts[index+1], true
		}
	}
	return "", false
}

func isWellFormedCerthash(value string) bool {
	_, raw, err := multibase.Decode(value)
	if err != nil {
		return false
	}
	_, err = mh.Decode(raw)
	return err == nil
}

func checkComponentShape(components []ma.Component) error {
	if len(components) != 5 {
		if !hasProtocol(components, ma.P_CERTHASH) {
			return endpointError(CodeCerthash, errors.New("address is missing /certhash"))
		}
		if !hasProtocol(components, ma.P_P2P) {
			return endpointError(CodePeerID, errors.New("address is missing /p2p"))
		}
		return endpointError(CodeAddress, errors.New("address must have exactly five components"))
	}
	expected := []int{0, ma.P_UDP, ma.P_WEBRTC_DIRECT, ma.P_CERTHASH, ma.P_P2P}
	for index, component := range components {
		if index == 0 {
			if !isHostProtocol(component.Code()) {
				return endpointError(CodeAddress, errors.New("address host component is invalid"))
			}
			continue
		}
		if component.Code() != expected[index] {
			return endpointError(CodeAddress, errors.New("address has invalid component order or hybrid transport"))
		}
	}
	return nil
}

func hasProtocol(components []ma.Component, code int) bool {
	for _, component := range components {
		if component.Code() == code {
			return true
		}
	}
	return false
}

func isHostProtocol(code int) bool {
	switch code {
	case ma.P_IP4, ma.P_IP6, ma.P_DNS, ma.P_DNS4, ma.P_DNS6:
		return true
	default:
		return false
	}
}

func isHostType(value string) bool {
	switch value {
	case "ip4", "ip6", "dns", "dns4", "dns6":
		return true
	default:
		return false
	}
}

// validHost rejects values that could be interpreted as extra multiaddr
// components, then lets the standard multiaddr transcoder validate IP values.
// DNS names deliberately use a conservative ASCII hostname grammar so the
// builder and parser have the same component boundary and hostname policy.
func validHost(hostType, host string) bool {
	if host == "" || strings.Contains(host, "/") {
		return false
	}
	for _, character := range host {
		if unicode.IsSpace(character) || unicode.IsControl(character) {
			return false
		}
	}
	if hostType == "dns" || hostType == "dns4" || hostType == "dns6" {
		return validDNSName(host)
	}
	_, err := ma.NewComponent(hostType, host)
	return err == nil
}

func validDNSName(host string) bool {
	if len(host) > 253 || strings.HasPrefix(host, ".") || strings.HasSuffix(host, ".") || strings.Contains(host, "..") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || !isDNSLabel(label) {
			return false
		}
	}
	return true
}

func isDNSLabel(label string) bool {
	if !isDNSLabelChar(label[0], false) || !isDNSLabelChar(label[len(label)-1], false) {
		return false
	}
	for index := 1; index < len(label)-1; index++ {
		if !isDNSLabelChar(label[index], true) {
			return false
		}
	}
	return true
}

func isDNSLabelChar(character byte, allowHyphen bool) bool {
	return character >= 'a' && character <= 'z' ||
		character >= 'A' && character <= 'Z' ||
		character >= '0' && character <= '9' ||
		allowHyphen && character == '-'
}

func parsePort(value string) (uint16, error) {
	if value == "" {
		return 0, errors.New("UDP port is missing")
	}
	port, err := strconv.ParseUint(value, 10, 16)
	if err != nil || port == 0 {
		return 0, errors.New("UDP port must be in 1..65535")
	}
	return uint16(port), nil
}

func identityForInput(publicKey []byte, peerID peer.ID) ([]byte, peer.ID, error) {
	var key []byte
	var err error
	if len(publicKey) > 0 {
		key, err = identity.PublicKeyBytes(publicKey)
		if err != nil {
			return nil, "", err
		}
	}
	if peerID != "" {
		if err := peerID.Validate(); err != nil {
			return nil, "", err
		}
		fromID, err := identity.PublicKeyFromPeerID(peerID)
		if err != nil {
			return nil, "", err
		}
		if key != nil && !equalBytes(key, fromID) {
			return nil, "", errors.New("public key and PeerId do not match")
		}
		key = fromID
	} else if key != nil {
		peerID, err = identity.PeerIDFromPublicKey(key)
		if err != nil {
			return nil, "", err
		}
	} else {
		return nil, "", errors.New("public key or PeerId is required")
	}
	return append([]byte(nil), key...), peerID, nil
}

func validatePin(pin *EndpointPin, publicKey []byte, peerID peer.ID) error {
	if pin == nil {
		return nil
	}
	key, id, err := identityForInput(pin.PublicKey, pin.PeerID)
	if err != nil {
		return endpointError(CodePeerID, err)
	}
	if !equalBytes(key, publicKey) || id != peerID {
		return endpointError(CodePeerID, errors.New("identity pin does not match address PeerId"))
	}
	return nil
}

func makeAddress(hostType, host string, port uint16, certhash string, peerID peer.ID) (ma.Multiaddr, error) {
	hostComponent, err := ma.NewComponent(hostType, host)
	if err != nil {
		return nil, err
	}
	udpComponent, err := ma.NewComponent("udp", strconv.FormatUint(uint64(port), 10))
	if err != nil {
		return nil, err
	}
	webrtcComponent, err := ma.NewComponent("webrtc-direct", "")
	if err != nil {
		return nil, err
	}
	certhashComponent, err := ma.NewComponent("certhash", certhash)
	if err != nil {
		return nil, err
	}
	peerComponent, err := ma.NewComponent("p2p", peerID.String())
	if err != nil {
		return nil, err
	}
	address := ma.Join(hostComponent, udpComponent, webrtcComponent, certhashComponent, peerComponent)
	if err := checkComponentShape(ma.Split(address)); err != nil {
		return nil, err
	}
	return address, nil
}

func endpointError(code string, cause error) error {
	return &Error{Code: code, Stage: StageValidate, Cause: cause}
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
