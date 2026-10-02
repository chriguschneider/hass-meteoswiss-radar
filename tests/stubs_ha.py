"""Shared Home Assistant stub layer for unit tests without HA installed.

Import this module before importing any component module (e.g. sensor.py,
binary_sensor.py).  It calls sys.modules.setdefault for every HA module the
entity layer depends on; because setdefault only wins the race once, the
first test file collected (alphabetically test_binary_sensor.py) installs
the full stub set and later files' own setdefault calls become no-ops.

Reuses the same surface contracts as test_proxy.py and test_nowcast.py for
modules those files already cover (aiohttp, homeassistant.core, etc.) so
all three test files stay compatible when collected in any order.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from enum import StrEnum
from types import ModuleType
from unittest.mock import MagicMock


# ---------------------------------------------------------------------------
# aiohttp stubs (same surface as test_proxy.py / test_nowcast.py)
# ---------------------------------------------------------------------------


class _ClientError(Exception):
    """Stand-in for aiohttp.ClientError."""


class _FakeResponse:
    """Stand-in for aiohttp.web.Response."""

    def __init__(
        self,
        *,
        body: bytes | None = None,
        content_type: str | None = None,
        charset: str | None = None,
        headers: dict | None = None,
        status: int = 200,
    ) -> None:
        self.status = status
        self.body = body
        self._explicit_headers = headers or {}
        self.compression_enabled = False

    def enable_compression(self) -> None:
        self.compression_enabled = True


class _FakeFileResponse:
    """Stand-in for aiohttp.web.FileResponse."""

    def __init__(self, path, *, headers: dict | None = None, **_kw) -> None:  # noqa: ANN001
        self.path = path
        self.status = 200
        self._explicit_headers = headers or {}
        self.compression_enabled = False

    def enable_compression(self) -> None:
        self.compression_enabled = True


class _FakeWeb:
    Response = _FakeResponse
    FileResponse = _FakeFileResponse


# ---------------------------------------------------------------------------
# HA core stubs
# ---------------------------------------------------------------------------


def callback(func):  # noqa: ANN001, ANN201
    """Identity decorator — stand-in for homeassistant.core.callback."""
    return func


# ---------------------------------------------------------------------------
# HA component / config stubs
# ---------------------------------------------------------------------------


class _HAView:
    pass


class _ConfigFlow:
    def __init_subclass__(cls, domain: str | None = None, **kwargs: object) -> None:
        super().__init_subclass__(**kwargs)


# ---------------------------------------------------------------------------
# HA update coordinator stubs
# ---------------------------------------------------------------------------


class _UpdateFailed(Exception):
    pass


class _DataUpdateCoordinator:
    def __init__(self, hass, logger, name, update_interval) -> None:  # noqa: ANN001
        self.hass = hass
        self.data = None

    def __class_getitem__(cls, item):  # noqa: ANN003
        return cls


class _CoordinatorEntity:
    def __init__(self, coordinator) -> None:  # noqa: ANN001
        super().__init__()
        self.coordinator = coordinator

    def __class_getitem__(cls, item):  # noqa: ANN003
        return cls

    def async_write_ha_state(self) -> None:
        pass

    def _handle_coordinator_update(self) -> None:
        self.async_write_ha_state()


# ---------------------------------------------------------------------------
# HA sensor / binary_sensor stubs
# ---------------------------------------------------------------------------


class _SensorEntity:
    pass


class _BinarySensorEntity:
    pass


class _SensorDeviceClass(StrEnum):
    DURATION = "duration"
    TIMESTAMP = "timestamp"
    ENUM = "enum"


class _SensorStateClass(StrEnum):
    MEASUREMENT = "measurement"


class _UnitOfTime(StrEnum):
    MINUTES = "min"


@dataclass(frozen=True, kw_only=True)
class _SensorEntityDescription:
    key: str = ""
    translation_key: str | None = None
    icon: str | None = None
    device_class: object = None
    state_class: object = None
    native_unit_of_measurement: object = None
    # ENUM sensors carry their allowed states here; HA rejects a state that is
    # not listed, which is what makes the status sensor's values translatable.
    options: object = None


class _DeviceInfo:
    def __init__(self, **kwargs: object) -> None:
        self._data = kwargs


# ---------------------------------------------------------------------------
# sys.modules registration
# ---------------------------------------------------------------------------


def _make_stubs() -> dict[str, ModuleType]:
    aiohttp = ModuleType("aiohttp")
    aiohttp.ClientError = _ClientError  # type: ignore[attr-defined]
    aiohttp.ClientTimeout = MagicMock(return_value=object())  # type: ignore[attr-defined]
    aiohttp.web = _FakeWeb  # type: ignore[attr-defined]

    ha = ModuleType("homeassistant")

    ha_core = ModuleType("homeassistant.core")
    ha_core.HomeAssistant = object  # type: ignore[attr-defined]
    ha_core.callback = callback  # type: ignore[attr-defined]

    ha_comp = ModuleType("homeassistant.components")

    ha_http = ModuleType("homeassistant.components.http")
    ha_http.HomeAssistantView = _HAView  # type: ignore[attr-defined]
    ha_http.StaticPathConfig = MagicMock()  # type: ignore[attr-defined]

    ha_frontend = ModuleType("homeassistant.components.frontend")
    ha_frontend.add_extra_js_url = lambda *a, **kw: None  # type: ignore[attr-defined]
    ha_frontend.remove_extra_js_url = lambda *a, **kw: None  # type: ignore[attr-defined]

    ha_sensor = ModuleType("homeassistant.components.sensor")
    ha_sensor.SensorDeviceClass = _SensorDeviceClass  # type: ignore[attr-defined]
    ha_sensor.SensorEntity = _SensorEntity  # type: ignore[attr-defined]
    ha_sensor.SensorEntityDescription = _SensorEntityDescription  # type: ignore[attr-defined]
    ha_sensor.SensorStateClass = _SensorStateClass  # type: ignore[attr-defined]

    ha_binary = ModuleType("homeassistant.components.binary_sensor")
    ha_binary.BinarySensorEntity = _BinarySensorEntity  # type: ignore[attr-defined]

    ha_const = ModuleType("homeassistant.const")
    ha_const.UnitOfTime = _UnitOfTime  # type: ignore[attr-defined]

    ha_cfg = ModuleType("homeassistant.config_entries")
    ha_cfg.ConfigEntry = object  # type: ignore[attr-defined]
    ha_cfg.ConfigFlow = _ConfigFlow  # type: ignore[attr-defined]
    ha_cfg.ConfigFlowResult = dict  # type: ignore[attr-defined]

    ha_helpers = ModuleType("homeassistant.helpers")

    ha_entity = ModuleType("homeassistant.helpers.entity")
    ha_entity.DeviceInfo = _DeviceInfo  # type: ignore[attr-defined]

    ha_update = ModuleType("homeassistant.helpers.update_coordinator")
    ha_update.UpdateFailed = _UpdateFailed  # type: ignore[attr-defined]
    ha_update.DataUpdateCoordinator = _DataUpdateCoordinator  # type: ignore[attr-defined]
    ha_update.CoordinatorEntity = _CoordinatorEntity  # type: ignore[attr-defined]

    ha_client = ModuleType("homeassistant.helpers.aiohttp_client")
    ha_client.async_get_clientsession = MagicMock()  # type: ignore[attr-defined]

    return {
        "aiohttp": aiohttp,
        "homeassistant": ha,
        "homeassistant.core": ha_core,
        "homeassistant.components": ha_comp,
        "homeassistant.components.http": ha_http,
        "homeassistant.components.frontend": ha_frontend,
        "homeassistant.components.sensor": ha_sensor,
        "homeassistant.components.binary_sensor": ha_binary,
        "homeassistant.const": ha_const,
        "homeassistant.config_entries": ha_cfg,
        "homeassistant.helpers": ha_helpers,
        "homeassistant.helpers.entity": ha_entity,
        "homeassistant.helpers.update_coordinator": ha_update,
        "homeassistant.helpers.aiohttp_client": ha_client,
    }


_STUBS = _make_stubs()
for _name, _mod in _STUBS.items():
    sys.modules.setdefault(_name, _mod)
