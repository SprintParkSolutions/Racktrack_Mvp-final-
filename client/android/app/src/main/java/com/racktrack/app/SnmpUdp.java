package com.racktrack.app;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * One UDP round trip, for SNMP.
 *
 * The whole reason this exists: a WebView cannot open a UDP socket, and the
 * server cannot reach a switch that lives on the customer's own network. The
 * phone can reach both, so the phone has to be the one that asks. This is the
 * smallest piece of native code that makes that possible — send these bytes to
 * this address, hand back whatever comes home.
 *
 * It knows nothing about SNMP. The protocol is built and parsed in JavaScript,
 * ported from the engine already proven against real switches; this class only
 * moves bytes. Keeping it that dumb means the part most likely to need fixing
 * is the part we can change without shipping a new APK.
 *
 * SEND ONLY, RECEIVE ONLY. There is no listen, no bind to a fixed port, no
 * broadcast. A read-only tool stays read-only at the transport layer, the same
 * way the SNMP engine has no SET operation anywhere in it.
 */
@CapacitorPlugin(name = "SnmpUdp")
public class SnmpUdp extends Plugin {

    /**
     * A datagram socket blocks, and Android kills any network call made on the
     * main thread. One small pool keeps the WebView responsive while a switch
     * takes its time answering, and lets several ports be read at once.
     */
    private final ExecutorService pool = Executors.newFixedThreadPool(4);

    /**
     * An SNMP reply has to fit in a single datagram. Agents keep to about 1500
     * bytes, but a GETBULK of a long interface table can legitimately come back
     * larger, and a reply that overflows the buffer is silently truncated
     * rather than reported. 64 KB is the most UDP can carry, so nothing is
     * lost to a buffer that was too small to notice.
     */
    private static final int MAX_DATAGRAM = 65535;

    @PluginMethod
    public void query(PluginCall call) {
        final String host = call.getString("host");
        final int port = call.getInt("port", 161);
        final int timeoutMs = call.getInt("timeoutMs", 3000);
        final String dataB64 = call.getString("data");

        if (host == null || host.trim().isEmpty()) {
            call.reject("No address given.", "no_host");
            return;
        }
        if (dataB64 == null) {
            call.reject("Nothing to send.", "no_data");
            return;
        }

        pool.execute(() -> {
            DatagramSocket socket = null;
            try {
                final byte[] out = Base64.decode(dataB64, Base64.DEFAULT);

                // Resolved before the socket is opened so a name that does not
                // exist reports as an address problem rather than a timeout.
                final InetAddress address = InetAddress.getByName(host.trim());

                socket = new DatagramSocket();
                socket.setSoTimeout(Math.max(500, timeoutMs));
                socket.send(new DatagramPacket(out, out.length, address, port));

                final byte[] buf = new byte[MAX_DATAGRAM];
                final DatagramPacket in = new DatagramPacket(buf, buf.length);
                socket.receive(in);

                final byte[] reply = new byte[in.getLength()];
                System.arraycopy(in.getData(), in.getOffset(), reply, 0, in.getLength());

                final JSObject result = new JSObject();
                result.put("data", Base64.encodeToString(reply, Base64.NO_WRAP));
                result.put("bytes", reply.length);
                result.put("from", in.getAddress().getHostAddress());
                call.resolve(result);

            } catch (SocketTimeoutException e) {
                // By far the most common outcome, and the one that needs the
                // clearest words: silence is not an error message, so say what
                // silence usually means rather than echoing the exception.
                call.reject(
                    "The switch did not answer in time. It may be unreachable from this "
                        + "network, SNMP may be switched off, or the community string may be "
                        + "wrong — a switch ignores a bad community rather than refusing it.",
                    "timeout"
                );
            } catch (java.net.UnknownHostException e) {
                call.reject("No device found at that address.", "unknown_host");
            } catch (SecurityException e) {
                call.reject("The app is not permitted to use the network.", "denied");
            } catch (Exception e) {
                final String m = e.getMessage();
                call.reject(m == null ? e.getClass().getSimpleName() : m, "failed");
            } finally {
                if (socket != null && !socket.isClosed()) socket.close();
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        pool.shutdownNow();
        super.handleOnDestroy();
    }
}
