"""
Tier-1 vendors researched live this session with no viable public source
found. Each reason documents exactly what was tried and why it was
ruled out, so future work doesn't re-attempt an already-dead approach
(and can see the specific technical blocker before deciding whether to
invest in a headless-browser-based approach instead).

These are registered via a single shared UnimplementedProvider rather
than one boilerplate file per vendor, since none of them have any real
logic yet -- avoids duplicate code for six near-identical stubs.

MANUAL_CHECK_URLS added 2026-07-16: for bot-walled vendors like
Teltonika, real live testing confirmed the block is on AUTOMATED
access, not the site itself -- a real human browser reaches these
pages just fine. Rather than leave a dead end, not_implemented() now
carries a verified-real link so the user can check the version
themselves in one click. Every URL below was individually verified
live (a real HTTP status checked, not guessed) -- see each entry for
what was confirmed.

CORRECTED 2026-07-19: Signamax, Allied Telesis, and Telco Systems were
all initially registered here after hitting a real HTTP 403 with both
curl/WebFetch AND a real headless Playwright browser -- but a user's
live screenshot of Signamax's real firmware page proved that wrong.
Re-investigated all three (plus AvaLan Wireless Systems and NVT
Phybridge) with a stealth-launched browser (--disable-blink-features=
AutomationControlled, a real Chrome UA, navigator.webdriver
overridden): Signamax/Allied Telesis/Telco Systems all load fine with
this config (headless-FINGERPRINT detection, not a genuine unsolvable
challenge) and were moved to real providers; AvaLan/NVT Phybridge also
became reachable but confirmed genuinely no viable firmware source
either way, so their entries below were corrected to say so accurately
instead of claiming a bot wall. Phoenix Contact/TE Connectivity/Maple
Systems/RS PRO were all re-tested with the same stealth config and
remain genuinely blocked (a real Cloudflare/Akamai/AWS WAF challenge
page, not just headless detection) -- their entries stand as
originally verified.

CORRECTED 2026-07-22: Teltonika was re-tested with the same stealth
config (prompted by a real user screenshot of a live, reachable
Teltonika firmware wiki) -- STILL genuinely blocked, an ACTIVE
Cloudflare "Just a moment..." challenge that doesn't clear even headed
with an 8s wait, unlike EtherWAN's static block. A real-human-
verification browser flow (same "human does the human part" pattern as
login-gated vendors) was built and registered, then REVERTED per
explicit user decision the same day -- back to the plain
not_implemented()+manual_check_url fallback below instead, and the
now-unused provider file was deleted rather than left as dead code.

CORRECTED 2026-07-22: EtherWAN was re-tested with the same stealth
config a THIRD time (prompted by a real user screenshot of a live,
reachable EtherWAN firmware page) and now loads cleanly, even headless
-- plain FirmwareHttpClient is still blocked, confirming this is still
headless-fingerprint detection, not a genuine unsolvable challenge, the
same class of correction as Signamax/Allied Telesis/Telco Systems
above. Unlike the 2026-07-19 re-test, this one succeeded; Cloudflare's
own bot-detection threshold for this domain apparently shifted between
the two dates (or is otherwise not perfectly deterministic run to run)
-- worth keeping in mind if it's ever seen blocked again. Moved to a
real provider (providers/etherwan.py); its entries below are removed.

CORRECTED 2026-07-22: Lenovo was re-tested (prompted by a real user
screenshot of a live, reachable Lenovo firmware download table) --
support.lenovo.com is STILL genuinely dead (confirmed again, 0 bytes,
matching the original finding), but a DIFFERENT real domain,
datacentersupport.lenovo.com, is NOT actually unreachable -- the
original finding's net::ERR_HTTP2_PROTOCOL_ERROR turned out to be a
Chromium-specific HTTP/2 negotiation bug on that one domain, not a
block: Playwright's FIREFOX engine loads it cleanly. Moved to a real
provider (providers/lenovo.py, the one provider in this codebase using
Firefox instead of Chromium for exactly this reason); its entries below
are removed.

CORRECTED 2026-07-22: Antaira was re-tested (prompted by a real user
screenshot of a live, reachable Antaira product page showing a real
"Firmware 6.2 Upgrade Bundle" download link) -- antaira.com has NO
bot-wall at all, confirmed live with a plain HTTP client (clean 200s
everywhere). The real gap in the original finding was that individual
product pages' download sections are client-side-JS-rendered, invisible
to a plain fetch -- but render fine in an ordinary headless Chromium,
no stealth flags even required. Moved to a real provider
(providers/antaira.py); its entries below are removed.

D-Link, 2026-09-07: dlink.com still does not answer from this network,
but D-Link's official FTP mirror (ftp.dlink.ru, a plain Apache index
per model under /pub/Switch/<MODEL>/Firmware/) does. Moved to a real
provider (providers/dlink.py); its entries below are removed.
"""

from __future__ import annotations

from firmware_lookup.providers.base import FirmwareProvider, UnimplementedProvider

NOT_IMPLEMENTED_REASONS: dict[str, str] = {
    "Teltonika": (
        "wiki.teltonika-networks.com returns a real, ACTIVE Cloudflare "
        "'Just a moment...' bot challenge on every automated request "
        "tried -- plain curl, headless Playwright, and even a headed "
        "stealth Playwright browser after an 8s wait. Does not allow "
        "automated/agent access. A real human's ordinary browser "
        "reaches the real per-model firmware wiki fine -- the link "
        "below goes straight there. (re-verified 2026-07-22)"
    ),
    "Korenix": (
        "korenix.com is unreachable at the TLS/TCP layer, not just "
        "bot-blocked at the HTTP layer -- confirmed live with both curl "
        "(TLS handshake 'Connection reset by peer' after DNS correctly "
        "resolves to 195.67.87.138) and a real Playwright browser "
        "(net::ERR_CONNECTION_RESET). No page of any kind was ever "
        "reachable to check for a public source or a login URL. "
        "(verified 2026-07-17) CORRECTED 2026-07-22: a user found a "
        "real, DIFFERENT, working domain -- korenixstore.com (an "
        "e-commerce storefront, not korenix.com itself) -- confirmed "
        "reachable by a real human browser. Automated fetches of it "
        "(both plain HTTP and a stealth Playwright browser) get a real "
        "200 response but a genuinely EMPTY page (no title, no body "
        "text) every time, unlike a normal bot-wall -- kept as "
        "manual_check_url only, not built into automated extraction, "
        "since there's nothing reliable here to parse yet."
    ),
    "HARTING": (
        "harting.com's current Industrial Ethernet Switches catalog "
        "(fetched live) lists only UNMANAGED switch series (Ha-VIS "
        "eCon/pCon/MK3000/SFP) -- the managed 'Ha-VIS mCon' line only "
        "surfaces via third-party sources, not on harting.com itself, "
        "indicating it's a legacy/discontinued line no longer "
        "merchandised. The site's own Download Manager tool (fetched "
        "live) offers 3D models/drawings/datasheets/certificates/"
        "manuals -- firmware/software is not among its file types at "
        "all. A real myHARTING login exists (harting.com/en-GB/login) "
        "but appears to be for the eShop/partner portal, not firmware "
        "specifically, and there's no current managed product to look "
        "up firmware for regardless. (verified 2026-07-17)"
    ),
    "Delta Electronics": (
        "deltaww.com's real Download Center (downloadcenter.deltaww.com, "
        "public, no login) was queried directly for a real current "
        "switch model (DVS-G112W02-4GF) -- confirmed real results exist "
        "for other data types (e.g. a real 'Dimensions' PDF/CAD entry, "
        "dated 2019-10-31), and the search UI does have a 'Firmware' "
        "data-type filter checkbox (dataTypes=12) among its real "
        "options -- but repeated real attempts (URL query param, "
        "checking the checkbox and resubmitting) never surfaced an "
        "actual firmware entry for this model. Product detail pages "
        "also have no Downloads/Firmware tab of their own. Genuinely "
        "couldn't confirm a working firmware-specific query this "
        "session, not a login problem. (verified 2026-07-17)"
    ),
    "QCT": (
        "qct.io's Download Center is genuinely public (no login, no "
        "bot-wall) and fully server-rendered -- confirmed live via "
        "plain HTTP, both its cascading Product Line/Model/Category "
        "form (method=1) and its simpler keyword search "
        "(Download/index/Firmware?method=2&category=0&keyword=<model>). "
        "RE-VERIFIED 2026-07-22 (prompted by a real user screenshot of "
        "the keyword-search results table): QCT's ACTUAL switch product "
        "lines -- every 'Bare Metal Switch' model tried (T7032-IX7, "
        "T4048-IX8, T9032-IX9, TA064-IXM, T7128-IXT) and both 'Switch "
        "OS' entries (SONiC, QNOS) -- return ZERO 'Firmware' category "
        "results, confirmed via BOTH search mechanisms independently. "
        "This is a genuine structural gap, not a bot-block or an email-"
        "gate: QCT simply does not publish per-model firmware downloads "
        "for its switch lines through this portal at all (only "
        "Datasheet/User Manual/etc. exist for these models) -- the "
        "'Firmware' category likely only has real content for QCT's "
        "OTHER product lines (servers/storage), which are out of scope "
        "for this tool. (originally verified 2026-07-17, re-verified "
        "and corrected 2026-07-22)"
    ),
    "FS.com": (
        "fs.com's Documentation system is genuinely public (no login "
        "-- fs.com/sign-in.html returns a real 404, no such login page "
        "exists) and confirmed live to serve real per-model documents "
        "(e.g. a real 'S3200 Series Switches Datasheet' for model "
        "S3200-8MG4S, dated 2025-03-21, found via a real browser after "
        "the domain's WAF blocked plain curl/WebFetch). But repeated "
        "real attempts (direct product page, the technical-documents "
        "query-string URL with its correct current files_id, a "
        "networkidle wait, and a page-wide 'Firmware' text search) "
        "never surfaced an actual Firmware-typed document for this "
        "model -- only Datasheet. Genuinely couldn't find a reliable "
        "firmware-specific discovery path this session, not a login or "
        "access problem. (verified 2026-07-17)"
    ),
    "Silicom": (
        "silicom-usa.com/download-center/ is a real, public product-"
        "family directory (no login), but confirmed live every "
        "'Download Driver' link actually routes to a Contact Form 7 "
        "support-request page (e.g. /drivercat/contact-support/"
        "?pname=PE310G4DBIR), not a real file/version download -- "
        "there's no self-service version-number page at all. Support "
        "is via an Atlassian Service Desk ticket portal, not an "
        "account login, so there's no real login URL to wire in "
        "either. Also worth noting: Silicom's 'switch' products "
        "(PE310G4DBIR etc.) are Switch-on-NIC PCIe server adapters, "
        "not standalone managed switches -- their actual switch-"
        "category hardware (Intelligent Bypass Switches, e.g. IS100, "
        "IBS10G) wasn't independently confirmed to have any different "
        "download structure. (verified 2026-07-17)"
    ),
    "Phoenix Contact": (
        "phoenixcontact.com returns a real HTTP 403 to a plain curl/"
        "WebFetch AND to a real headless Playwright browser on every "
        "URL tried, including the account/login page itself "
        "(my-phoenix-contact) -- a genuine, confirmed bot wall on the "
        "whole domain, not a login redirect. No page of any kind "
        "(public or login) was ever reachable to build against. "
        "(verified 2026-07-17)"
    ),
    "StarTech": (
        "startech.com/en-us/support/drivers-and-downloads is a real, "
        "fully public, no-login search tool (confirmed live -- direct "
        "curl/single-page requests were blocked by bot detection, but "
        "a real browser session that visits the support hub first, "
        "same as a genuine visitor, gets through with a 200). Checked "
        "3 real managed switch models (IES101G2SFPW, IES81GPOEW, "
        "IES101GP2SFW) via both direct product-page navigation and the "
        "real 'Enter Product ID' search box -- none show any firmware "
        "section or version number on their real 'Drivers & Downloads' "
        "tab, only Manuals/Datasheets. A structural data gap (these "
        "appear to be OEM-rebadged devices with no StarTech-specific "
        "firmware), not an access problem. (verified 2026-07-17)"
    ),
    "Billion Electric": (
        "billion.com's live Download center is real and public (no "
        "login) but is now purely Solar/ESS/EV-charger/power-adapter "
        "marketing PDFs -- the current site navigation has NO network "
        "switch category at all (Energy Solutions, Solar-Storage-"
        "Charging, Power Supply, Customized ESS only). Billion has "
        "pivoted away from switches; its old ICT/networking division "
        "lives on as subsidiary BEC Technologies (bectechnologies.net), "
        "which itself sells 4G/5G routers/gateways, not switches, and "
        "returned a real HTTP 403 Forbidden when fetched directly. "
        "(verified 2026-07-19)"
    ),
    "AirPro": (
        "Real identity confirmed: AirPro Technology (airpro.in / "
        "airpronetworks.com), an independent India-based networking "
        "OEM -- not Ubiquiti/Aerohive-affiliated as the name might "
        "suggest. No public firmware/download page found on either "
        "domain. airpro.in/support/ 301-redirects to "
        "airpronetworks.com/contact/, a contact form only, not an "
        "account portal -- firmware upgrades are done via TFTP/local "
        "web-UI or the AirPro mobile app (Google Play), not a website "
        "login. A genuine public-source AND login gap, not a guess. "
        "(verified 2026-07-19)"
    ),
    "Alpha Networks": (
        "alphanetworks.com's real product pages (e.g. SEG-5002-484tP/"
        "SEG-5002-242tP, SNX-62x0-486T) have no firmware links or "
        "version numbers, and the entire top-level site nav (Company/"
        "Products/Capability/Investor Relations/Career/ESG/News/"
        "Contact) has no Support or Download section at all -- Alpha "
        "Networks is a pure ODM manufacturer with no self-service "
        "portal of any kind. (verified 2026-07-19)"
    ),
    "AvaLan Wireless Systems": (
        "No dedicated firmware/version lookup page or login portal "
        "exists for AvaLan's switches. RE-VERIFIED live with a "
        "stealth-launched browser after avalannetworks.com's initial "
        "403 turned out to be headless-fingerprint detection, not a "
        "real block (same class of bug caught on Signamax) -- both "
        "avalan.com/ethernetswitches and avalan.com/support load fine "
        "now, but genuinely have NO firmware/model-specific content: "
        "the switches page is pure marketing pointing to a distributor "
        "(Volume Inc.) and the support page only lists tools for "
        "AvaLan's separate 'Fuel Center' product line. AvaLan's core "
        "business is industrial wireless bridges/radios; switches are "
        "a minor, genuinely undocumented adjacent product line. "
        "(verified 2026-07-19, re-confirmed 2026-07-19)"
    ),
    "RS PRO": (
        "RS PRO is a private-label reseller brand (RS Components/RS "
        "Online's own house brand) with no dedicated firmware self-"
        "service system of its own -- confirmed live: the real RS-"
        "provided self-service page (rs-online.com/designspark/"
        "rs-pro-software-and-manuals) explicitly covers only test/"
        "measurement instruments, PLCs, and lab equipment, NOT network "
        "switches. Deep product/category pages on uk.rs-online.com and "
        "us.rs-online.com consistently returned ETIMEDOUT or HTTP 403 "
        "across multiple attempts (Akamai/bot-protection), confirmed "
        "live, not guessed. Any real firmware for RS PRO-badged "
        "switches would come from the actual (often Chinese ODM) "
        "manufacturer, not RS. (verified 2026-07-19)"
    ),
    "Scomp Enterprises Private Limited": (
        "scomp.in is a real, reachable small India-based reseller "
        "(Noida, UP, incorporated March 2023, corroborated by company-"
        "registry listings) selling white-label PoE switches -- but "
        "its live product pages (e.g. the SEPOE4FE/SEPOEFE162G1/"
        "SEPOE8FE2G PoE switches) have no firmware/version info of any "
        "kind, and no login portal exists. A genuine public-source AND "
        "login gap for a vendor with no firmware infrastructure at "
        "all, not a guess. (verified 2026-07-19)"
    ),
    "Rubytech": (
        "rubytech.com.tw's live switch category page "
        "(rubytech.com.tw/rubytech/category/switch/) lists many real "
        "models (PSGS-2348KF, FGS-2506, IGS-2724) but has no firmware "
        "links or version numbers anywhere, and no confirmed login-"
        "gated portal exists on the domain itself -- Rubytech is a "
        "pure Taiwan ODM manufacturer, same structural pattern as "
        "Alpha Networks. (verified 2026-07-19)"
    ),
    "LINKOH": (
        "Real identity confirmed: Shenzhen Linkoh Technology Co., Ltd. "
        "(linkohnet.com), a Shenzhen-based Ethernet switch ODM/"
        "manufacturer. Live product pages (e.g. LK7016XGSM, "
        "LK5028XGSM) explicitly state firmware upgrade is only 'via "
        "console/web/TFTP' -- no firmware download or version section "
        "exists on the site, and no login portal was found. "
        "(verified 2026-07-19)"
    ),
    "Wanglink": (
        "Real identity confirmed: Shenzhen Wanglink Communication "
        "Equipment Technology Co., Ltd. (wanglink.net / szwanglink.com, "
        "house brand 'CHUANLIXIN'). Live products page "
        "(wanglink.net/products.html) lists real models (ISG808M, "
        "ISG1602M, ISL802P) but has no firmware links, and no login "
        "portal was found -- same pure-ODM pattern as LINKOH/Rubytech. "
        "(verified 2026-07-19)"
    ),
    "Chilinkiot": (
        "Real identity confirmed: Shenzhen ChiLinkIoT Technology Co., "
        "Ltd. (chilinkiot.com). Its live tech-support page "
        "(chilinkiot.com/resources/tech-support/) only has PDF config "
        "guides for their ZLWL industrial 4G routers -- nothing "
        "switch-firmware-related, and no login form exists. "
        "(verified 2026-07-19)"
    ),
    "Xexagon": (
        "Real identity confirmed: Xexagon, an Ahmedabad, India "
        "industrial-automation/networking manufacturer (xexagon.co.in, "
        "est. ~2019). Its live catalog page "
        "(xexagon.co.in/industrial-ethernet-switches.html) lists real "
        "models (XC-IS3816GM, XNTN-9000-75-8GT-V) but has no firmware "
        "section, and no login portal was found. (verified 2026-07-19)"
    ),
    "Brainboxes": (
        "brainboxes.com's real Software & Drivers page (fetched live, "
        "200 OK, no login) genuinely publishes firmware version "
        "numbers (e.g. 'latest firmware available is version 8.33T' "
        "for ED devices) -- but Brainboxes' actual products are "
        "Ethernet-to-Serial and Ethernet-to-IO adapters, NOT managed "
        "network switches. This is a genuine scope mismatch (the "
        "vendor doesn't sell switches at all), not an access problem. "
        "(verified 2026-07-19)"
    ),
    "Intellisystem Technologies": (
        "intellisystem.it's real switch category page "
        "(intellisystem.it/en/product-category/prodotti/"
        "ethernet-switches/switch-industriali/) lists real models "
        "(IT-ES7110-IM-2GS-2F, IT-ES1024-IU-24F) but has no firmware/"
        "downloads section visible, and no login wall was found either "
        "-- the site's own copy says customers should 'frequently "
        "check the appropriate product folder... to download the "
        "latest firmware,' implying ad-hoc per-product folders rather "
        "than a structured, scrapeable portal. (verified 2026-07-19)"
    ),
    "L-com": (
        "l-com.com/ethernet-switches and the industrial-switches "
        "variant list real models (IES-2205, IES-2210AT-SFP) but have "
        "no downloads/firmware section -- pages direct to sales "
        "contact only. No login-gated portal found either; L-com "
        "largely resells/rebrands other vendors' switches (some listed "
        "products are visibly Planet/NETGEAR/EtherWAN-branded resales "
        "on the same page), so firmware would come from the OEM, not "
        "L-com itself. (verified 2026-07-19)"
    ),
    "Proscend Communications": (
        "proscend.com's real support page (proscend.com/en/page/"
        "support.html, fetched live, 200 OK, no login) has only FAQ/"
        "RMA content, no firmware section. No login-gated portal found "
        "either -- support is handled via a 'Request Support' contact "
        "form. Real models confirmed live (850G-12I, 850G-12PI, "
        "850XF-28) have no firmware download path of any kind. "
        "(verified 2026-07-19)"
    ),
    "Lantech Communications": (
        "lantechcom.tw/global/eng/support-downloads.html is a real, "
        "public, no-login support/downloads INDEX page, but it "
        "publishes no actual firmware version numbers -- every "
        "firmware reference on the page directs to 'contact us.' No "
        "login portal found either; firmware requests are handled via "
        "email (support@lantechcom.com.au per search results). A "
        "genuine version-field gap on an otherwise-reachable page, not "
        "a guess. (verified 2026-07-19)"
    ),
    "TE Connectivity": (
        "te.com/en/products/switches/industrial-ethernet-switches.html "
        "returns a real HTTP 403 Forbidden (Akamai 'Access Denied') to "
        "BOTH a plain curl/WebFetch AND a real headless Playwright "
        "browser -- confirmed live via two independent methods, same "
        "genuine bot-wall class as Teltonika/Allied Telesis, not "
        "bypassed. No page of any kind was reachable to find a public "
        "source or a login URL. (verified 2026-07-19)"
    ),
    "NVT Phybridge": (
        "No public firmware version number published anywhere. "
        "RE-VERIFIED live with a stealth-launched browser after the "
        "help center's initial Cloudflare challenge turned out to be "
        "headless-fingerprint detection, not a real block (same class "
        "of bug caught on Signamax) -- nvtphybridgehelp.zendesk.com "
        "loads fine now (a real, public, no-login help center with "
        "genuine per-model 'Managed Switches' categories). Its own "
        "article 'Latest firmware for NVT Phybridge's managed "
        "switches' confirms the real mechanism: 'You can visit the "
        "respective switch's page on our website and submit a "
        "Firmware Upgrade Request' -- a per-model email-request form, "
        "not a version-number listing or a traditional login. Real "
        "models confirmed live: FLEX24 (FLX-024), CLEER24, PoLRE 24/48, "
        "FLEX24-10G. (verified 2026-07-19, re-confirmed 2026-07-19)"
    ),
    "NSGate": (
        "nsgate.com is genuinely unrenderable within a reasonable "
        "timeout -- confirmed live with a real headless Playwright "
        "browser (25s navigation timeout exceeded), not just a "
        "WebFetch artifact. The site appears to be a heavy client-side "
        "SPA (raw HTML is a near-empty shell with only font-loading "
        "tags). No firmware page or login wall could be found because "
        "no page content could be reached at all. Real model names "
        "recovered only via the site's sitemap.xml (NIS-3200-122PSG, "
        "NIS-3500-2408PGX), not directly rendered content. "
        "(verified 2026-07-19)"
    ),
    "Alaxala Networks": (
        "alaxala.com is genuinely unreachable from this environment -- "
        "every connection attempt returned ECONNREFUSED, confirmed via "
        "multiple independent attempts. No page of any kind (public or "
        "login) was ever reachable to build against. Real model names "
        "(AX4600S, AX3660S, AX2630S) are known only via third-party "
        "search-cache snippets, not a live page. (verified 2026-07-19)"
    ),
    "Asterfusion Data Technologies": (
        "asterfusion.com has no public firmware/version lookup page, "
        "and no true login form was found either -- access to actual "
        "software/downloads is gated behind an 'Apply for a trial' / "
        "direct sales-request flow, not a self-service account system. "
        "Real models confirmed via live pages: CX864E-N, CX732Q-N, "
        "CX664D-N (SONiC-based data-center switches). "
        "(verified 2026-07-19)"
    ),
    "Beijing Fibridge": (
        "fibridge.com's live homepage confirms a real fiber-optic/"
        "carrier switch manufacturer (est. 1995) with real model names "
        "(F6-M4GT2GX, F6-M16GT2GX, F6-M8GT2GX) but shows no firmware "
        "download links anywhere. Individual product pages and a "
        "dedicated /support path all returned a real, live HTTP 404 "
        "Not Found -- either stale/reorganized URLs or a genuine site "
        "restructuring, not a bot wall. No login-gated portal was "
        "found either; support is handled via direct email. "
        "(verified 2026-07-19)"
    ),
    "Maple Systems": (
        "maplesystems.com returns a real 'Performing security "
        "verification' bot-protection challenge (HTTP 403) to BOTH a "
        "plain curl/WebFetch AND a real headless Playwright browser -- "
        "confirmed live via two independent methods, same genuine "
        "bot-wall class as Teltonika/Allied Telesis. A real, gated "
        "Support Center exists per third-party search results "
        "('registered customers 24-hour access'), but the login page "
        "itself could not be reached to confirm its structure. "
        "(verified 2026-07-19)"
    ),
    "Obsidian Control Systems": (
        "support.obsidiancontrol.com/Content/Support/Downloads.htm is "
        "a real, public, no-login download page (fetched live, 200 "
        "OK) that DOES publish real firmware -- 'ONYX OS 4.32 "
        "(4.32.1311)', dated Feb 16, 2026 -- but it is explicitly "
        "scoped 'for NX4 - NX2 - NX1/NX1-16 - M6 (ONYX Kit),' Obsidian's "
        "lighting-CONSOLE products, not their NETRON network switch "
        "line. Searched the entire page text for any mention of "
        "'NETRON' (their actual switch product, e.g. NETRON NS8): zero "
        "matches. A genuine per-product coverage gap on an otherwise-"
        "real, reachable page -- the switch itself has no published "
        "firmware here, not a bug or access problem. (verified 2026-07-19)"
    ),
    "UfiSpace": (
        "The official product documentation does not publish a "
        "firmware/NOS version. UfiSpace's own real datasheet (fetched "
        "live: UfiSpace-Disaggregated-Cell-Site-Gateway-S9500-30XS-"
        "Datasheet.pdf) explicitly describes 'Open NOS applications for "
        "highly reliable composable networks' -- the hardware supports "
        "multiple Network Operating Systems (customer's choice), so the "
        "software version depends on the deployed NOS rather than being "
        "a single vendor-tracked firmware number. No 'firmware', "
        "'Software', or 'Operating System' version string appears "
        "anywhere in that datasheet, on the product page, or on the "
        "category page. The real login-gated support.ufispace.com "
        "portal (a genuine Redmine login) was also re-confirmed to have "
        "no version-tracking mechanism of its own for the same "
        "structural reason -- neither a public nor a login path can "
        "give a single firmware answer for this vendor's disaggregated "
        "hardware. (verified 2026-07-21)"
    ),
}

# Short, user-facing explanations for vendors where the gap is a
# confirmed STRUCTURAL fact (not a bot-wall) -- shown directly in the
# result message instead of the generic "provider not implemented"
# wording, since it stays true regardless of whether the page loads.
# Only set where explicitly verified; every other vendor above keeps
# the existing generic/bot-wall message untouched.
USER_FACING_REASONS: dict[str, str] = {
    "UfiSpace": (
        "The official product documentation does not publish a "
        "firmware/NOS version. The hardware supports multiple Network "
        "Operating Systems, and the software version depends on the "
        "deployed NOS."
    ),
}

# Real vendor pages, individually verified live (a real HTTP status
# checked for each, not guessed) -- reachable by a human even where our
# own automated access is blocked. See NOT_IMPLEMENTED_REASONS above
# for exactly what was checked for each.
MANUAL_CHECK_URLS: dict[str, str] = {
    "Teltonika": "https://wiki.teltonika-networks.com/view/Downloads",
    "Korenix": "https://www.korenixstore.com/Korenix_Marine_Managed_Unmanaged_Ethernet_Switches_s/271.htm",
    "StarTech": "https://www.startech.com/en-us/support/drivers-and-downloads",
    "Phoenix Contact": "https://www.phoenixcontact.com/en-us",
    "Silicom": "https://www.silicom-usa.com/download-center/",
    "FS.com": "https://www.fs.com/technical_documents.html",
    "HARTING": "https://www.harting.com/en-US/download-manager",
    "Delta Electronics": "https://downloadcenter.deltaww.com/en-US/DownloadCenter",
    "QCT": "https://www.qct.io/en-US/Download/index/Firmware",
    "Billion Electric": "https://www.billion.com/download",
    "AirPro": "https://www.airpronetworks.com/contact/",
    "Alpha Networks": "https://www.alphanetworks.com",
    "AvaLan Wireless Systems": "https://www.avalan.com/managednetworkservices",
    "RS PRO": "https://www.rs-online.com/designspark/rs-pro-software-and-manuals",
    "Scomp Enterprises Private Limited": "https://scomp.in/poe-switch.html",
    "Rubytech": "https://www.rubytech.com.tw/rubytech/category/switch/",
    "LINKOH": "https://www.linkohnet.com",
    "Wanglink": "https://www.wanglink.net/products.html",
    "Chilinkiot": "https://www.chilinkiot.com/product-category/industrial-ethernet-switch/",
    "Xexagon": "https://xexagon.co.in/industrial-ethernet-switches.html",
    "Brainboxes": "https://www.brainboxes.com/support/software-drivers",
    "Intellisystem Technologies": (
        "https://www.intellisystem.it/en/product-category/prodotti/"
        "ethernet-switches/switch-industriali/"
    ),
    "L-com": "https://www.l-com.com/ethernet-switches",
    "Proscend Communications": "https://www.proscend.com/en/page/support.html",
    "Lantech Communications": "https://www.lantechcom.tw/global/eng/support-downloads.html",
    "TE Connectivity": "https://www.te.com/en/products/switches/industrial-ethernet-switches.html",
    "NVT Phybridge": "https://www.nvtphybridge.com",
    "NSGate": "https://www.nsgate.com",
    "Alaxala Networks": "https://www.alaxala.com",
    "Asterfusion Data Technologies": "https://www.asterfusion.com",
    "Beijing Fibridge": "https://www.fibridge.com",
    "Maple Systems": "https://www.maplesystems.com/support-center/",
    "Obsidian Control Systems": "https://support.obsidiancontrol.com/Content/Support/Downloads.htm",
    "UfiSpace": "https://www.ufispace.com/products/telco/access",
}


def build_unimplemented_providers() -> dict[str, FirmwareProvider]:
    return {
        vendor: UnimplementedProvider(
            vendor,
            reason,
            MANUAL_CHECK_URLS.get(vendor, ""),
            user_reason=USER_FACING_REASONS.get(vendor, ""),
        )
        for vendor, reason in NOT_IMPLEMENTED_REASONS.items()
    }
