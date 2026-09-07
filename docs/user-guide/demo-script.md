# RackTrack demo script

Sign in as **owner** on the phone. Stand at the office rack. Six steps, about eight minutes.

## 1. Scan the rack
**Do:** Scan → take a photo of the rack front.
**You see:** every device boxed with its U position, and the labels read off the front (SP-RI-U15-SW04 and so on).
**Where it comes from:** the camera. Our own trained model finds the devices and units; OCR reads the labels. A box with fewer than ten ports is called a router, everything else a switch, patch panel or server.

## 2. Read the switches (Network tab)
**Do:** Network → the three switches are already listed (D-Link core at .100, two TP-Links at .11 and .12) → Read.
**You see:** each switch as a numbered card: make and model, serial, uptime, and every port in two rows, green where something is plugged in. Tap a port for its speed, the device on it and its addresses.
**Where it comes from:** the switch itself, asked over SNMP by the phone, on the rack's own network. Nothing is typed in and nothing is guessed. Each switch is placed in the rack by matching its port count to the box the camera found; you can change the place.

## 3. What each switch is (Switches tab)
**Do:** Switches → pick a switch.
**You see:** firmware version and build, serial, address, port count; the specifications; the firmware check; SFP advice for its ports.
**Where it comes from:** identity and firmware from the switch (its own MIB). Latest firmware from the maker's own download list: TP-Link's Omada support site and D-Link's official firmware mirror. Where a maker keeps firmware behind a sign-in, the app says so and links to the page. If you type a make or model, your word wins everywhere.

## 4. The report
**Do:** More → Report.
**You see:** one document for the rack: ports in use of the total, devices, switches read, cables, addresses, then every device top-down with its ports.
**Where it comes from:** the camera and the switches joined together. Download it as CSV, JSON or PDF. Share it to Teams or email (sent from the RackTrack mailbox with the PDF attached) or as a link that works for five minutes without an account.

## 5. Export to NetBox
**Do:** Report → Export → NetBox → Preview → Write.
**You see:** what will be created, updated and left alone, then the rack, devices, interfaces and cables appear in NetBox.
**Where it comes from:** the same report. NetBox is provided for every account (Data Sources shows "RackTrack NetBox · in use"); an organisation can add its own NetBox with URL, username and password and that one is used instead.

## 6. Drift
**Do:** More → Drift.
**You see:** what changed on each switch since the last read: ports that came up or went down, new devices, addresses that moved.
**Where it comes from:** the readings the phone filed, compared over time.

## Where the data comes from, in one table

| Source | What it gives us |
|---|---|
| Camera photo | devices, U positions, labels, port counts |
| The switch, over SNMP | ports up/down, speeds, addresses seen, neighbours, serial, firmware, uptime |
| Maker's download site | latest firmware version |
| You | names, places in the rack, corrections |
| NetBox | where the rack is written |
| Teams / Outlook | how the report is sent |

## If asked
- **Passwords on the switch?** Read-only SNMP, community or v3 user, entered once per rack.
- **Is anything made up?** No. Where a fact is not read, the app says it is not read.
- **Does the phone need the internet?** Only for the firmware check, sharing and NetBox. Reading the switches works on the rack's network alone.
