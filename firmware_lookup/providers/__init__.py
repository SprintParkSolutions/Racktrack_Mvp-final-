"""Provider registry assembly -- merges all tiers into one PROVIDERS dict."""

from __future__ import annotations

from firmware_lookup.providers.base import FirmwareProvider


def build_providers() -> dict[str, FirmwareProvider]:
    from firmware_lookup.providers.adtran import AdtranProvider
    from firmware_lookup.providers.advantech import AdvantechProvider
    from firmware_lookup.providers.aerohive import AerohiveProvider
    from firmware_lookup.providers.alcatel_lucent_enterprise import (
        AlcatelLucentEnterpriseProvider,
    )
    from firmware_lookup.providers.allied_telesis import AlliedTelesisProvider
    from firmware_lookup.providers.amg_systems import AmgSystemsProvider
    from firmware_lookup.providers.antaira import AntairaProvider
    from firmware_lookup.providers.araknis_networks import AraknisNetworksProvider
    from firmware_lookup.providers.arista import AristaProvider
    from firmware_lookup.providers.aruba import ArubaProvider
    from firmware_lookup.providers.avaya import AvayaProvider
    from firmware_lookup.providers.beckhoff import BeckhoffProvider
    from firmware_lookup.providers.beijer_electronics import BeijerElectronicsProvider
    from firmware_lookup.providers.belden import BeldenProvider
    from firmware_lookup.providers.buffalo import BuffaloProvider
    from firmware_lookup.providers.cdata import CDataProvider
    from firmware_lookup.providers.celestica import CelesticaProvider
    from firmware_lookup.providers.cerio import CerioProvider
    from firmware_lookup.providers.ciena import CienaProvider
    from firmware_lookup.providers.cisco import CiscoProvider
    from firmware_lookup.providers.datto import DattoProvider
    from firmware_lookup.providers.dell import DellProvider
    from firmware_lookup.providers.dlink import DLinkProvider
    from firmware_lookup.providers.draytek import DraytekProvider
    from firmware_lookup.providers.edgecore import EdgecoreProvider
    from firmware_lookup.providers.edimax import EdimaxProvider
    from firmware_lookup.providers.engenius import EnGeniusProvider
    from firmware_lookup.providers.etherwan import EtherWANProvider
    from firmware_lookup.providers.extreme import ExtremeProvider
    from firmware_lookup.providers.fortinet import FortinetProvider
    from firmware_lookup.providers.h3c import H3CProvider
    from firmware_lookup.providers.hikvision import HikvisionProvider
    from firmware_lookup.providers.huawei import HuaweiProvider
    from firmware_lookup.providers.icp_das import IcpDasProvider
    from firmware_lookup.providers.ip_infusion import IPInfusionProvider
    from firmware_lookup.providers.juniper import JuniperProvider
    from firmware_lookup.providers.kyland import KylandProvider
    from firmware_lookup.providers.lantronix import LantronixProvider
    from firmware_lookup.providers.lenovo import LenovoProvider
    from firmware_lookup.providers.linksys import LinksysProvider
    from firmware_lookup.providers.micas_networks import MicasNetworksProvider
    from firmware_lookup.providers.microsens import MicrosensProvider
    from firmware_lookup.providers.mikrotik import MikroTikProvider
    from firmware_lookup.providers.moxa import MoxaProvider
    from firmware_lookup.providers.netgear import NetgearProvider
    from firmware_lookup.providers.nokia import NokiaProvider
    from firmware_lookup.providers.nomadix import NomadixProvider
    from firmware_lookup.providers.noviflow import NoviFlowProvider
    from firmware_lookup.providers.nvidia import NvidiaProvider
    from firmware_lookup.providers.omnitron_systems import OmnitronSystemsProvider
    from firmware_lookup.providers.oracle import OracleProvider
    from firmware_lookup.providers.oring import OringProvider
    from firmware_lookup.providers.perle import PerleProvider
    from firmware_lookup.providers.planet import PlanetProvider
    from firmware_lookup.providers.qnap import QnapProvider
    from firmware_lookup.providers.red_lion import RedLionProvider
    from firmware_lookup.providers.ruckus import RuckusProvider
    from firmware_lookup.providers.ruijie import RuijieProvider
    from firmware_lookup.providers.schneider_electric import SchneiderElectricProvider
    from firmware_lookup.providers.schweitzer_engineering_labs import (
        SchweitzerEngineeringLabsProvider,
    )
    from firmware_lookup.providers.signamax import SignamaxProvider
    from firmware_lookup.providers.supermicro import SupermicroProvider
    from firmware_lookup.providers.tejas_networks import TejasNetworksProvider
    from firmware_lookup.providers.telco_systems import TelcoSystemsProvider
    from firmware_lookup.providers.totolink import TotolinkProvider
    from firmware_lookup.providers.tplink import TPLinkProvider
    from firmware_lookup.providers.trendnet import TrendnetProvider
    from firmware_lookup.providers.ubiquiti import UbiquitiProvider
    from firmware_lookup.providers.unimplemented import build_unimplemented_providers
    from firmware_lookup.providers.versa_networks import VersaNetworksProvider
    from firmware_lookup.providers.vertiv import VertivProvider
    from firmware_lookup.providers.wago import WagoProvider
    from firmware_lookup.providers.westermo import WestermoProvider
    from firmware_lookup.providers.yamaha import YamahaProvider
    from firmware_lookup.providers.yokogawa import YokogawaProvider
    from firmware_lookup.providers.zte import ZTEProvider
    from firmware_lookup.providers.zyxel import ZyxelProvider

    providers: dict[str, FirmwareProvider] = {
        "MikroTik": MikroTikProvider(),
        "Ubiquiti": UbiquitiProvider(),
        "NVIDIA": NvidiaProvider(),
        "TP-Link": TPLinkProvider(),
        "MOXA": MoxaProvider(),
        "NETGEAR": NetgearProvider(),
        "Fortinet": FortinetProvider(),
        "Cisco": CiscoProvider(),
        "Juniper": JuniperProvider(),
        "Arista": AristaProvider(),
        "Aruba": ArubaProvider(),
        "Dell": DellProvider(),
        "Huawei": HuaweiProvider(),
        "H3C": H3CProvider(),
        "Nokia": NokiaProvider(),
        "RUCKUS": RuckusProvider(),
        "Extreme": ExtremeProvider(),
        "PLANET": PlanetProvider(),
        "Edgecore": EdgecoreProvider(),
        "Buffalo": BuffaloProvider(),
        "Zyxel": ZyxelProvider(),
        "Adtran": AdtranProvider(),
        "Advantech": AdvantechProvider(),
        "Alcatel-Lucent Enterprise": AlcatelLucentEnterpriseProvider(),
        "Avaya": AvayaProvider(),
        "DrayTek": DraytekProvider(),
        "TRENDnet": TrendnetProvider(),
        "Ruijie": RuijieProvider(),
        "Lantronix": LantronixProvider(),
        "Perle": PerleProvider(),
        "Supermicro": SupermicroProvider(),
        "ORing": OringProvider(),
        "Kyland": KylandProvider(),
        "TOTOLINK": TotolinkProvider(),
        "C-Data": CDataProvider(),
        "Westermo": WestermoProvider(),
        "IP Infusion": IPInfusionProvider(),
        "MICROSENS": MicrosensProvider(),
        "QNAP": QnapProvider(),
        "Red Lion": RedLionProvider(),
        "Ciena": CienaProvider(),
        "Hikvision": HikvisionProvider(),
        "Schneider Electric": SchneiderElectricProvider(),
        "ZTE": ZTEProvider(),
        "Vertiv": VertivProvider(),
        "Tejas Networks": TejasNetworksProvider(),
        "Versa Networks": VersaNetworksProvider(),
        "Yamaha": YamahaProvider(),
        "WAGO": WagoProvider(),
        "Belden": BeldenProvider(),
        "Beckhoff": BeckhoffProvider(),
        "Edimax": EdimaxProvider(),
        "NoviFlow": NoviFlowProvider(),
        "Aerohive": AerohiveProvider(),
        "Celestica": CelesticaProvider(),
        "Schweitzer Engineering Laboratories": SchweitzerEngineeringLabsProvider(),
        "ICP DAS": IcpDasProvider(),
        "EnGenius": EnGeniusProvider(),
        "CERIO Corporation": CerioProvider(),
        "AMG Systems": AmgSystemsProvider(),
        "Beijer Electronics": BeijerElectronicsProvider(),
        "Omnitron Systems": OmnitronSystemsProvider(),
        "Araknis Networks": AraknisNetworksProvider(),
        "Nomadix": NomadixProvider(),
        "Micas Networks": MicasNetworksProvider(),
        "Datto": DattoProvider(),
        "Oracle": OracleProvider(),
        "Yokogawa": YokogawaProvider(),
        "Signamax": SignamaxProvider(),
        "Allied Telesis": AlliedTelesisProvider(),
        "Telco Systems": TelcoSystemsProvider(),
        "Linksys": LinksysProvider(),
        "EtherWAN": EtherWANProvider(),
        "Lenovo": LenovoProvider(),
        "Antaira": AntairaProvider(),
        "D-Link": DLinkProvider(),
    }
    providers.update(build_unimplemented_providers())
    return providers
