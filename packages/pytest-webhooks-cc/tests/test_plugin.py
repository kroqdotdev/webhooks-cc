"""The plugin as a user's pytest sees it: loaded from the installed package."""

from __future__ import annotations

import re
from importlib import metadata

import pytest

import pytest_webhooks_cc

from .conftest import StubApi

FIXTURES = ("webhooks_cc", "webhooks_cc_endpoint")

USES_THE_ENDPOINT = """
def test_first(webhooks_cc, webhooks_cc_endpoint):
    assert webhooks_cc_endpoint.slug == "stub1"
    assert webhooks_cc_endpoint.url.endswith("/w/stub1")


def test_second(webhooks_cc_endpoint):
    assert webhooks_cc_endpoint.slug == "stub2"


def test_without_fixtures():
    pass
"""


def fixture_definitions(output: str) -> dict[str, int]:
    """How many times ``pytest --fixtures`` lists each webhooks.cc fixture."""
    return {
        name: len(re.findall(rf"^{name}(?: \[\w+ scope\])? -- ", output, flags=re.MULTILINE))
        for name in FIXTURES
    }


def test_the_version_matches_the_package() -> None:
    assert metadata.version("pytest-webhooks-cc") == pytest_webhooks_cc.__version__


def test_the_entry_point_names_the_plugin() -> None:
    [entry_point] = [
        entry_point
        for entry_point in metadata.distribution("pytest-webhooks-cc").entry_points
        if entry_point.group == "pytest11"
    ]
    assert entry_point.name == "pytest_webhooks_cc"
    assert entry_point.value == "pytest_webhooks_cc.plugin"


def test_pytest_loads_the_plugin_from_the_installed_package(pytester: pytest.Pytester) -> None:
    result = pytester.runpytest_subprocess("--trace-config")
    assert result.ret == pytest.ExitCode.NO_TESTS_COLLECTED
    # "registered third-party plugins" lists each distribution whose entry point
    # pytest loaded, and the module it loaded from it.
    version = re.escape(pytest_webhooks_cc.__version__)
    assert re.search(
        rf"^\s+pytest-webhooks-cc-{version} at .*pytest_webhooks_cc[/\\]plugin\.py$",
        result.stdout.str(),
        flags=re.MULTILINE,
    )


def test_the_fixtures_are_there_once_without_a_conftest(pytester: pytest.Pytester) -> None:
    result = pytester.runpytest_subprocess("--fixtures", "-v")
    assert result.ret == pytest.ExitCode.OK
    assert fixture_definitions(result.stdout.str()) == {name: 1 for name in FIXTURES}


def test_the_sdk_module_is_registered_once(pytester: pytest.Pytester) -> None:
    """Both packages are installed, and the fixture module is one plugin, not two."""
    pytester.makeconftest(
        """
        import webhooks_cc.pytest_plugin as sdk_fixtures


        def pytest_report_header(config):
            names = sorted(
                name
                for name, plugin in config.pluginmanager.list_name_plugin()
                if plugin is sdk_fixtures
            )
            return f"sdk fixtures registered as: {names}"
        """
    )
    result = pytester.runpytest_subprocess()
    result.stdout.fnmatch_lines(["sdk fixtures registered as: ['webhooks_cc']"])


def test_the_fixtures_are_there_when_only_this_plugin_is_loaded(
    pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With entry points off, naming this plugin is enough: it brings the fixtures."""
    monkeypatch.setenv("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")

    without = pytester.runpytest_subprocess("--fixtures", "-v")
    assert fixture_definitions(without.stdout.str()) == dict.fromkeys(FIXTURES, 0)

    result = pytester.runpytest_subprocess("-p", "pytest_webhooks_cc", "--fixtures", "-v")
    assert result.ret == pytest.ExitCode.OK
    assert fixture_definitions(result.stdout.str()) == dict.fromkeys(FIXTURES, 1)


@pytest.mark.parametrize(
    "plugins",
    [
        ("-p", "pytest_webhooks_cc", "-p", "webhooks_cc"),
        ("-p", "webhooks_cc", "-p", "pytest_webhooks_cc"),
    ],
)
def test_naming_both_plugins_starts_cleanly_with_warnings_as_errors(
    pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch, plugins: tuple[str, ...]
) -> None:
    """In either order, the SDK module is not imported before pytest can rewrite it.

    Importing it when this plugin is imported made pytest warn that it could not
    rewrite ``webhooks_cc``, which ``filterwarnings = error`` turns into a crash.
    """
    monkeypatch.setenv("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
    pytester.makeini("[pytest]\nfilterwarnings = error\n")
    pytester.makepyfile("def test_plain():\n    pass\n")

    result = pytester.runpytest_subprocess(*plugins, "-W", "error")
    assert result.ret == pytest.ExitCode.OK, result.stdout.str() + result.stderr.str()
    assert "PytestAssertRewriteWarning" not in result.stdout.str() + result.stderr.str()


def test_blocking_the_sdk_plugin_keeps_the_fixtures_off(pytester: pytest.Pytester) -> None:
    """``-p no:webhooks_cc`` means no fixtures; this plugin does not bring them back."""
    result = pytester.runpytest_subprocess("-p", "no:webhooks_cc", "--fixtures", "-v")
    assert result.ret == pytest.ExitCode.OK
    assert fixture_definitions(result.stdout.str()) == dict.fromkeys(FIXTURES, 0)


def test_without_a_key_the_tests_are_skipped_and_the_reason_is_shown(
    pytester: pytest.Pytester,
) -> None:
    pytester.makepyfile(USES_THE_ENDPOINT)
    result = pytester.runpytest_subprocess()
    result.assert_outcomes(passed=1, skipped=2)
    result.stdout.fnmatch_lines(
        [
            "collected 3 items",
            "webhooks.cc: WHK_API_KEY is not set, so 2 tests that use the webhooks.cc fixtures"
            " will be skipped",
        ]
    )


def test_one_skipped_test_is_counted_as_one(pytester: pytest.Pytester) -> None:
    pytester.makepyfile("def test_only(webhooks_cc):\n    pass\n")
    result = pytester.runpytest_subprocess()
    result.assert_outcomes(skipped=1)
    result.stdout.fnmatch_lines(
        [
            "webhooks.cc: WHK_API_KEY is not set, so 1 test that uses the webhooks.cc fixtures"
            " will be skipped"
        ]
    )


def test_nothing_is_said_when_no_test_uses_the_fixtures(pytester: pytest.Pytester) -> None:
    pytester.makepyfile("def test_plain():\n    pass\n")
    result = pytester.runpytest_subprocess()
    result.assert_outcomes(passed=1)
    result.stdout.no_fnmatch_line("*webhooks.cc*")


def test_with_a_key_each_test_gets_an_endpoint_that_is_deleted(
    pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch, stub_api: StubApi
) -> None:
    monkeypatch.setenv("WHK_API_KEY", "whcc_made_up_for_this_test")
    monkeypatch.setenv("WHK_BASE_URL", stub_api.url)
    monkeypatch.setenv("WHK_WEBHOOK_URL", stub_api.url)
    pytester.makepyfile(USES_THE_ENDPOINT)

    result = pytester.runpytest_subprocess()

    result.assert_outcomes(passed=3)
    output = result.stdout.str() + result.stderr.str()
    assert "webhooks.cc:" not in output
    assert "whcc_made_up_for_this_test" not in output
    assert stub_api.calls == [
        ("POST", "/api/endpoints"),
        ("DELETE", "/api/endpoints/stub1"),
        ("POST", "/api/endpoints"),
        ("DELETE", "/api/endpoints/stub2"),
    ]
    # Each endpoint is named after its test, so a leftover is easy to trace.
    assert stub_api.names == ["test_first", "test_second"]
    assert stub_api.keys == {"Bearer whcc_made_up_for_this_test"}


def test_a_failing_test_still_deletes_its_endpoint(
    pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch, stub_api: StubApi
) -> None:
    monkeypatch.setenv("WHK_API_KEY", "whcc_made_up_for_this_test")
    monkeypatch.setenv("WHK_BASE_URL", stub_api.url)
    pytester.makepyfile("def test_fails(webhooks_cc_endpoint):\n    assert False\n")

    result = pytester.runpytest_subprocess()

    result.assert_outcomes(failed=1)
    assert stub_api.calls == [("POST", "/api/endpoints"), ("DELETE", "/api/endpoints/stub1")]
