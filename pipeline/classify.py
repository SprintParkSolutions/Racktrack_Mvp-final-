"""
One rule, stated once: a network box with fewer than ten ports is a router.

The detector has only the front of the box to go on and calls small network
boxes "Switch" because they look like small switches. Once the ports have
been counted we know better. The rule used to live in runner.py alone, so a
map edited afterwards — a port count somebody corrected, an active-learning
memory applied after analysis — could quietly put "Switch" back. Every writer
of a device's class calls this now, and the annotated images are redrawn
after it runs, so the picture says what the map says.

Only a device we reclassified is ever reclassified back: class_source is the
marker, and a person's own correction (or the detector's other classes) is
left alone.
"""

ROUTER_PORT_CEILING = 10
ROUTER_SOURCE = f"ports<{ROUTER_PORT_CEILING}"


def router_rule(dev):
    """Apply the rule in place and return the device.

    Switch with 0 < port_count < 10        -> Router   (marked class_source)
    Router we marked, now port_count >= 10 -> Switch   (marker removed)
    Anything else is untouched. A device whose ports were never counted is
    left alone — demote_if_no_ports has its own answer for that one.
    """
    if not isinstance(dev, dict):
        return dev
    count = dev.get("port_count")
    if not isinstance(count, int) or count <= 0:
        return dev
    cls = dev.get("class_name")
    if cls == "Switch" and count < ROUTER_PORT_CEILING:
        dev["class_name"] = "Router"
        dev["class_source"] = ROUTER_SOURCE
    elif (
        cls == "Router"
        and dev.get("class_source") == ROUTER_SOURCE
        and count >= ROUTER_PORT_CEILING
    ):
        dev["class_name"] = "Switch"
        dev.pop("class_source", None)
    return dev
