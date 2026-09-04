import UIKit
import Capacitor

/**
 * The app's bridge view controller — exists to register app-local plugins.
 *
 * Capacitor discovers plugins from capacitor.config.json's packageClassList,
 * which `cap sync` builds from installed npm packages. A plugin that lives in
 * this target rather than in a package is never on that list, so it has to be
 * registered here, before the WebView loads.
 *
 * It MUST be registerPluginInstance, not registerPluginType. The Type variant
 * begins `if autoRegisterPlugins { return }` — with auto-registration on, which
 * is the default, it silently does nothing. Build 48 shipped with that call and
 * the JS side reported "SnmpUdp is not implemented on ios" exactly as build 47
 * had, with no log line anywhere to say why. The Instance variant has no such
 * guard: it stores the plugin, calls load(on:), and exports its JS header into
 * the WebView's content controller immediately.
 *
 * This is the iOS twin of MainActivity.registerPlugin() on Android.
 */
class RackTrackViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SnmpUdp())
    }
}
