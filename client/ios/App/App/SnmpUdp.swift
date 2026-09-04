import Foundation
import Capacitor
import Darwin

/**
 * One UDP round trip, for SNMP. The iOS half of the Android plugin.
 *
 * The whole reason this exists: a WebView cannot open a UDP socket, and the
 * server cannot reach a switch that lives on the customer's own network. The
 * phone can reach both, so the phone has to be the one that asks. This is the
 * smallest piece of native code that makes that possible — send these bytes to
 * this address, hand back whatever comes home.
 *
 * It knows nothing about SNMP. The protocol is built and parsed in JavaScript,
 * ported from the engine already proven against real switches; this only moves
 * bytes. Keeping it that dumb means the part most likely to need fixing is the
 * part we can change without shipping a new build through review.
 *
 * Plain POSIX sockets rather than Network.framework, deliberately: it mirrors
 * the Android implementation line for line, so when one of them misbehaves the
 * other is a straight reference rather than a different design to hold in your
 * head at the same time.
 *
 * SEND ONLY, RECEIVE ONLY. No listening, no fixed port, no broadcast. A
 * read-only tool stays read-only at the transport layer, the same way the SNMP
 * engine has no SET operation anywhere in it.
 *
 * NOTE: needs NSLocalNetworkUsageDescription in Info.plist. Without it iOS 14
 * and later block traffic to a local address and the read simply never
 * arrives — no error, no prompt, nothing to debug.
 */
@objc(SnmpUdp)
public class SnmpUdp: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SnmpUdp"
    public let jsName = "SnmpUdp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "query", returnType: CAPPluginReturnPromise)
    ]

    /// Sockets block, and blocking the main thread freezes the WebView. Concurrent
    /// so several ports can be read at once without queueing behind one slow switch.
    private let queue = DispatchQueue(label: "ai.racktrack.snmp.udp", attributes: .concurrent)

    /// An SNMP reply has to fit in one datagram. Agents keep to about 1500 bytes,
    /// but a bulk read of a long interface table can legitimately be larger, and a
    /// reply that overflows the buffer is silently truncated rather than reported.
    /// 64 KB is the most UDP can carry, so nothing is lost to a small buffer.
    private static let maxDatagram = 65535

    @objc func query(_ call: CAPPluginCall) {
        guard let raw = call.getString("host")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            call.reject("No address given.", "no_host")
            return
        }
        guard let b64 = call.getString("data"), let payload = Data(base64Encoded: b64) else {
            call.reject("Nothing to send.", "no_data")
            return
        }
        let port = call.getInt("port") ?? 161
        let timeoutMs = max(500, call.getInt("timeoutMs") ?? 3000)

        queue.async {
            self.roundTrip(call: call, host: raw, port: port, timeoutMs: timeoutMs, payload: payload)
        }
    }

    private func roundTrip(call: CAPPluginCall, host: String, port: Int, timeoutMs: Int, payload: Data) {
        // Resolved before the socket is opened, so a name that does not exist
        // reports as an address problem rather than as a timeout. AF_UNSPEC so a
        // switch reachable only over IPv6 still answers.
        var hints = addrinfo(
            ai_flags: 0,
            ai_family: AF_UNSPEC,
            ai_socktype: SOCK_DGRAM,
            ai_protocol: IPPROTO_UDP,
            ai_addrlen: 0,
            ai_canonname: nil,
            ai_addr: nil,
            ai_next: nil
        )
        var info: UnsafeMutablePointer<addrinfo>?
        let rc = getaddrinfo(host, String(port), &hints, &info)
        guard rc == 0, let first = info else {
            call.reject("No device found at that address.", "unknown_host")
            return
        }
        defer { freeaddrinfo(info) }

        let fd = socket(first.pointee.ai_family, first.pointee.ai_socktype, first.pointee.ai_protocol)
        guard fd >= 0 else {
            call.reject("Could not open a network socket.", "failed")
            return
        }
        defer { close(fd) }

        // The receive timeout is what turns "no answer" into a result instead of
        // a hang. Set before the send so a reply that never comes is bounded.
        var tv = timeval(tv_sec: timeoutMs / 1000, tv_usec: Int32((timeoutMs % 1000) * 1000))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        let sent = payload.withUnsafeBytes { buf -> Int in
            sendto(fd, buf.baseAddress, payload.count, 0,
                   first.pointee.ai_addr, first.pointee.ai_addrlen)
        }
        guard sent >= 0 else {
            // EHOSTUNREACH / ENETUNREACH here almost always means the phone has no
            // route to that network at all — a different problem from silence, and
            // worth saying so rather than waiting out the timeout to say nothing.
            let code = errno
            if code == EHOSTUNREACH || code == ENETUNREACH {
                call.reject(
                    "This phone has no route to that address. It is probably on a "
                    + "different network from the switch, or the VPN is not carrying "
                    + "that subnet.",
                    "unreachable"
                )
            } else if code == EACCES || code == EPERM {
                call.reject(
                    "iOS refused the connection. If this is the first read, allow "
                    + "local network access when asked, or turn it on in Settings.",
                    "denied"
                )
            } else {
                call.reject(String(cString: strerror(code)), "failed")
            }
            return
        }

        var buffer = [UInt8](repeating: 0, count: SnmpUdp.maxDatagram)
        var fromLen = socklen_t(MemoryLayout<sockaddr_storage>.size)
        var from = sockaddr_storage()

        let received = withUnsafeMutablePointer(to: &from) { fromPtr -> Int in
            fromPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                recvfrom(fd, &buffer, SnmpUdp.maxDatagram, 0, sa, &fromLen)
            }
        }

        guard received > 0 else {
            let code = errno
            if received < 0 && (code == EAGAIN || code == EWOULDBLOCK) {
                // By far the most common outcome, and the one that needs the
                // clearest words: silence is not an error message, so say what
                // silence usually means rather than echoing the errno.
                call.reject(
                    "The switch did not answer in time. It may be unreachable from "
                    + "this network, SNMP may be switched off, or the community string "
                    + "may be wrong — a switch ignores a bad community rather than "
                    + "refusing it.",
                    "timeout"
                )
            } else {
                call.reject("The switch closed the connection without answering.", "failed")
            }
            return
        }

        let reply = Data(buffer[0..<received])
        call.resolve([
            "data": reply.base64EncodedString(),
            "bytes": reply.count,
            "from": SnmpUdp.describe(&from)
        ])
    }

    /// The address that actually answered, for the record. A reply from somewhere
    /// other than where we asked is worth being able to see.
    private static func describe(_ storage: inout sockaddr_storage) -> String {
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        let len = socklen_t(storage.ss_len)
        let ok = withUnsafePointer(to: &storage) { ptr -> Bool in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                getnameinfo(sa, len, &host, socklen_t(NI_MAXHOST), nil, 0, NI_NUMERICHOST) == 0
            }
        }
        return ok ? String(cString: host) : ""
    }
}
