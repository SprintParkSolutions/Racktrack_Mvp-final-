# What RackTrack asks a switch, and why

Every value on the Network page comes from a question the phone put to the
switch over SNMP. This is the list of those questions, in the order they are
asked, with what each one is for and what happens when the switch will not
answer it.

Nothing here is vendor-specific. Every OID below is a standard MIB, so one code
path covers any managed switch. Unmanaged switches and patch panels answer none
of it, and those stay the camera's job permanently.

The reader is [`client/src/utils/snmpClient.js`](../client/src/utils/snmpClient.js).
The server has its own copy of the same conversation in
[`server/lib/netbox/collect.js`](../server/lib/netbox/collect.js), used when a
browser asks the server to read a switch it cannot reach itself.

---

## How we talk

| | |
|---|---|
| Transport | UDP to port 161, one datagram out, one back |
| Who sends it | **The phone.** Our server sits in a data centre with no route to a `10.x` or `192.168.x` address inside somebody's building. This is why every earlier attempt to probe switches from the server found nothing. |
| Versions | **v2c** with a community string, and **v3** at `noAuthNoPriv` with a user name. v3 with a password (`authNoPriv` / `authPriv`) is written and proven on the server and is not on the phone yet. |
| Verbs | `GET` for the single values, `GETBULK` for the tables, falling back to `GETNEXT` when a switch rejects bulk. Never `SET` — RackTrack does not write to switches. |
| Timeout | 3 s with one retry for the tables every switch has; **1.5 s and no retry** for the optional ones (below). |

A switch that does not implement a table does not say so — it says nothing at
all, and silence costs a full timeout. That is why the optional tables are
asked with a short fuse: a switch offering none of them costs a few seconds
rather than a minute, and an empty answer is filed as "not offered" rather than
failing the whole reading.

---

## The questions, in order

### 1. What are you? — answered in about 20 ms

| OID | Name | Why we ask |
|---|---|---|
| `1.3.6.1.2.1.1.1.0` | `sysDescr` | The make and model, for every switch we have tested. ENTITY-MIB is the proper place for it and returned nothing on any of them (see the note below), so the model is parsed out of this string. |
| `1.3.6.1.2.1.1.2.0` | `sysObjectID` | Starts `1.3.6.1.4.1.<enterprise>`; the enterprise number names the vendor without trusting marketing text. |
| `1.3.6.1.2.1.1.3.0` | `sysUpTime` | How long it has been running. A switch that rebooted an hour ago explains a lot. |
| `1.3.6.1.2.1.1.5.0` | `sysName` | The name somebody gave it, to match against the label on the front. |

This is one round trip. The screen paints the make and model here, before
anything else is asked — the identity is known in a fraction of a second and
there is no reason to hold it back for seven seconds while the rest arrives.

### 2. What are your ports? — the faceplate paints here

| OID | Name | Why we ask |
|---|---|---|
| `1.3.6.1.2.1.31.1.1.1.1` | `ifName` | The name written on the box: `Slot0/24`, `gigabitEthernet 1/0/6`. |
| `1.3.6.1.2.1.2.2.1.8` | `ifOperStatus` | Up or down. This plus the name is the whole faceplate, so it is drawn at this point and the rest fills in underneath. |

Then the remainder of the interface table:

| OID | Name | Why we ask |
|---|---|---|
| `1.3.6.1.2.1.2.2.1.2` | `ifDescr` | The fallback name, for switches that leave `ifName` empty. |
| `1.3.6.1.2.1.2.2.1.3` | `ifType` | Tells a socket from a VLAN interface. `6` is ethernet; 23, 24, 53, 131, 135, 136 and 161 are tunnels, loopbacks, VLANs and aggregates, and are dropped. |
| `1.3.6.1.2.1.2.2.1.7` | `ifAdminStatus` | Whether a down port is broken or switched off on purpose. |
| `1.3.6.1.2.1.31.1.1.1.15` | `ifHighSpeed` | Megabits. A gigabit port running at 100 Mb is a fault nobody has noticed. |
| `1.3.6.1.2.1.31.1.1.1.18` | `ifAlias` | The description an engineer typed on the port — the only human sentence a switch holds. |

> **A vendor that lies.** The TP-Link SG2428P reports `Vlan-interface1` as
> ifType 6, ethernetCsmacd — the same type as the 28 sockets on its front.
> Believing it made a 28-port switch a 29-port switch, so an interface whose
> *name* reads as a VLAN, loopback, tunnel or aggregate is dropped as well.

### 3. Optional — asked with a short fuse

| OID | Name | Why we ask | When it is missing |
|---|---|---|---|
| `1.3.6.1.2.1.47.1.1.1.1.11` | `entPhysicalSerialNum` | The serial number, stated by the device about itself. No photograph of a sticker competes with this. | Returned no rows on any lab switch. The reading says "no serial number"; the camera or a person supplies one. |
| `1.3.6.1.2.1.2.2.1.6` | `ifPhysAddress` | Each port's own MAC. Also used to drop the switch's own addresses out of the forwarding table below. | The port simply has no MAC listed. |
| `1.3.6.1.2.1.10.7.2.1.19` | `dot3StatsDuplexStatus` | Half or full duplex. A half-duplex gigabit link is a fault. | Not shown. |
| `1.0.8802.1.1.2.1.3.7.1.3` | `lldpLocPortId` | **Which socket LLDP means.** LLDP numbers our ports its own way — on the TP-Links neither the ifIndex (49153+) nor anything a person would recognise. This table is the translation. | Falls back to the interface table, then to the bare number. |
| `1.0.8802.1.1.2.1.4.1.1.9` | `lldpRemSysName` | The neighbour's name. | See the note below. |
| `1.0.8802.1.1.2.1.4.1.1.7` | `lldpRemPortId` | Which of *their* ports our cable lands on. Two ends agreeing is a proven cable. | The neighbour is listed without it. |
| `1.0.8802.1.1.2.1.4.1.1.5` | `lldpRemChassisId` | The neighbour's identity when it sends no name. | — |
| `1.3.6.1.2.1.17.1.4.1.2` | `dot1dBasePortIfIndex` | Bridge port numbers are their own numbering and only sometimes equal ifIndex. This translates them, rather than the two being assumed the same. | The forwarding table's port numbers are used as-is. |
| `1.3.6.1.2.1.17.7.1.2.2.1.2` | `dot1qTpFdbPort` | **The forwarding table** — every MAC the switch has learned, and the port it learned it on. This is how a port says what is plugged into it. | Falls back to the older BRIDGE-MIB below. |
| `1.3.6.1.2.1.17.4.3.1.2` | `dot1dTpFdbPort` | The same table on switches without the VLAN-aware version. | The reading says "no forwarding table". |
| `1.3.6.1.2.1.4.22.1.2` | `ipNetToMediaPhysAddress` | The ARP cache, which puts an IP address to some of the MACs above. | The devices are listed by MAC alone. |

> **A neighbour with no name.** One of the lab switches reports three LLDP
> neighbours whose `lldpRemSysName` is empty — they send only a chassis id.
> Taking the name column as the list meant the screen said there were none.
> The list is now the union of the name, port and chassis columns, and a
> nameless neighbour is shown by its chassis id and filed on the server as
> `chassisId`, never as a name it did not claim.

### A word on ENTITY-MIB

Nothing here says these switches *cannot* answer ENTITY-MIB. Two different
statements are easy to confuse, and only one of them is ours to make:

* **What the vendor documents.** Neither TP-Link nor D-Link lists ENTITY-MIB
  among the supported MIBs for these models. Their documented support is
  MIB-II, the Bridge and P/Q-Bridge MIBs, RMON, IF-MIB, Ether-Like, 802.1p,
  the RADIUS and Ping/Traceroute MIBs, and each vendor's private MIB —
  ENTITY-MIB is not on either list.
* **What we measured.** On these units, with this firmware, over this SNMPv3
  user, a walk of `entPhysicalSerialNum` and `entPhysicalModelName` returned
  no rows.

So the honest phrasing is *"not documented by the vendor, and returned nothing
here"* — not *"not supported"*. A firmware revision could answer tomorrow, and
we would take it: the walk is still sent on every read, and a serial that
arrives is used ahead of anything the camera guessed.

What follows from that is a design rule, not a complaint: **ENTITY-MIB is never
a dependency.** Model comes from `sysDescr` when ENTITY-MIB is silent, serial
is left empty and said to be empty, and no screen waits on it.

### Documented MIB support, per device

Vendor documentation, not our measurement — useful for deciding what is worth
asking next.

| Device | SNMP | Documented MIBs | For RackTrack |
|---|---|---|---|
| TP-Link TL-SG2428P | v1 / v2c / v3 | MIB-II, Bridge, P/Q-Bridge, RMON, RADIUS auth + acct, Ping/Traceroute, TP-Link private | MIB-II for identity, Bridge for the forwarding table, **P/Q-Bridge for VLANs**, RMON for traffic |
| D-Link DGS-1210-52P | v1 / v2c / v3 | MIB-II, IF-MIB, Bridge, SNMPv2, RMON + RMONv2, Ether-Like, 802.1p, RADIUS auth + acct, Ping/Traceroute, D-Link private, Zone Defense | MIB-II and IF-MIB for ports, Bridge for the forwarding table, Ether-Like for duplex, RMON for traffic, **Power-Ethernet where the unit exposes PoE** |
| D-Link DGS-1024C | none — unmanaged | — | **Cannot be read at all.** It has no SNMP agent, so it stays the camera's job permanently. Adding it to the Network page will always end in "did not answer". |

The VLAN tables came back empty on the units in the lab even though P/Q-Bridge
is documented for the TP-Link — worth re-testing on a switch that has VLANs
configured before concluding anything about it.

---

## What we do **not** ask, and why

| | |
|---|---|
| **Anything that writes.** | No `SET`, ever. RackTrack reads switches; it does not configure them. |
| **VLAN names and PVIDs** (`dot1qVlanStaticName`, `dot1qPvid`) | Asked by the server's collector; returned no rows on the lab switches, so the phone does not spend a timeout on them. P/Q-Bridge *is* documented for the TP-Link, and the lab has no VLANs configured — so this is a "test it properly", not a "they cannot". |
| **PoE** (`POWER-ETHERNET-MIB`) | No answer from any lab switch. The DGS-1210-52**P** and TL-SG2428**P** are PoE models, so this is worth another look on a unit actually powering something. |
| **CPU, memory, temperature** (`HOST-RESOURCES-MIB`, `ENTITY-SENSOR-MIB`) | No answer from any lab switch, and RackTrack is not a monitoring tool. |
| **Traffic counters** (`ifHCInOctets`, `ifInErrors`) | **Available on every port** — deliberately not read. One sample is a number, not a rate; showing it as though it meant something would be a lie. Reading it twice, a known interval apart, would give a real per-port throughput. |
| **CDP** (Cisco's LLDP) | No Cisco gear in the lab yet. One walk when there is. |
| **Vendor private MIBs** | Both vendors publish one. Everything RackTrack needs so far has a standard equivalent, and a private MIB is one code path per vendor forever. Worth it only for something no standard MIB carries. |

---

## What the lab actually answers

Measured against the three switches on 7 September 2026, rows returned. This
is what these units did on this day — not what their firmware is capable of.

| | D-Link DGS-1210-52 | TP-Link SG2428P (.11) | TP-Link SG2428P (.12) |
|---|---|---|---|
| ports | 52 | 28 | 28 |
| forwarding table | 20 | 12 | 16 |
| ARP cache | 5 | 2 | 2 |
| port MAC / duplex | 52 / 52 | 29 / 28 | 29 / 28 |
| LLDP neighbours | 0 | 0 | **3** |
| ENTITY-MIB | 0 rows | 0 rows | 0 rows |
| VLAN tables | 0 | 0 | 0 |
| PoE / CPU / memory / temperature | 0 | 0 | no answer |
| **identity on screen** | 10 ms | 19 ms | 19 ms |
| **faceplate on screen** | 61 ms | 1.2 s | 1.3 s |
| **everything in** | 0.36 s | 6.6 s | 6.5 s |

The SG2428P answers about 280 ms per request, which is the whole difference
between the two columns; the D-Link answers in about 10 ms.

## Running this yourself

`client/src/utils/liveprobe.test.js` runs the shipping reader against the lab
switches over a real UDP socket, with the native plugin replaced by a Node
datagram socket doing exactly what `SnmpUdp.java` and `SnmpUdp.swift` do — so
everything above the socket is the code that ships. It is skipped unless asked
for:

```
cd client && RT_LIVE=1 npx vitest run src/utils/liveprobe.test.js
```
