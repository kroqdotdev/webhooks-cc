"""The plugin pytest loads through this package's ``pytest11`` entry point.

It defines no fixtures of its own. ``webhooks_cc`` and ``webhooks_cc_endpoint``
are defined once, in the SDK (:mod:`webhooks_cc.pytest_plugin`), and the SDK
registers them through an entry point named ``webhooks_cc``. This plugin:

- registers that module under the same name when pytest did not load it, as
  with ``PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`` and ``-p pytest_webhooks_cc``, so
  the fixtures exist either way and never twice;
- says after collection how many tests will be skipped for want of an API key,
  because a skip is silent unless pytest runs with ``-rs``.
"""

from __future__ import annotations

import os
from collections.abc import Sequence

import pytest
from webhooks_cc import pytest_plugin as sdk_fixtures
from webhooks_cc.client import API_KEY_ENV

#: The name the SDK's own entry point registers the fixtures under, which is
#: also the name ``-p no:webhooks_cc`` blocks.
SDK_PLUGIN_NAME = "webhooks_cc"

#: Every test that uses a webhooks.cc fixture uses this one: the endpoint
#: fixture, and any fixture built on the client, asks for it.
CLIENT_FIXTURE = "webhooks_cc"


def pytest_configure(config: pytest.Config) -> None:
    """Register the SDK's fixtures unless they are registered or switched off."""
    manager = config.pluginmanager
    if manager.is_registered(sdk_fixtures) or manager.is_blocked(SDK_PLUGIN_NAME):
        return
    manager.register(sdk_fixtures, SDK_PLUGIN_NAME)


def pytest_report_collectionfinish(
    config: pytest.Config, items: Sequence[pytest.Item]
) -> str | None:
    """One line under "collected N items" when tests will be skipped without a key."""
    if os.environ.get(API_KEY_ENV) or not config.pluginmanager.is_registered(sdk_fixtures):
        return None
    waiting = sum(1 for item in items if CLIENT_FIXTURE in getattr(item, "fixturenames", ()))
    if waiting == 0:
        return None
    tests = "1 test that uses" if waiting == 1 else f"{waiting} tests that use"
    return (
        f"webhooks.cc: {API_KEY_ENV} is not set, "
        f"so {tests} the webhooks.cc fixtures will be skipped"
    )
