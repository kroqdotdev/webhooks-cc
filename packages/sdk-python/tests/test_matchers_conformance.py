"""The shared matcher and duration vectors."""

from __future__ import annotations

import re
from typing import Any

import pytest

from tests.conformance import load, vector_id
from webhooks_cc import matchers
from webhooks_cc.durations import parse_duration
from webhooks_cc.models import Request

MATCHERS = load("matchers")
DURATIONS = load("durations")
REQUESTS = {name: Request.from_dict(data) for name, data in MATCHERS["requests"].items()}


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def build(spec: dict[str, Any]) -> matchers.Matcher:
    fn = spec["fn"]
    args = spec["args"]
    if fn == "isEmailRequest":
        return matchers.is_email_request
    if fn in ("matchAll", "matchAny"):
        return getattr(matchers, _snake(fn))(*(build(arg) for arg in args))
    if fn == "matchEmail":
        criteria = dict(args[0]) if args else {}
        if "from" in criteria:
            criteria["from_"] = criteria.pop("from")
        return matchers.match_email(**criteria)
    return getattr(matchers, _snake(fn))(*args)


@pytest.mark.parametrize("vector", MATCHERS["vectors"], ids=vector_id)
def test_matcher(vector: dict[str, Any]) -> None:
    matcher = build(vector["matcher"])
    assert matcher(REQUESTS[vector["request"]]) is vector["expected"]


@pytest.mark.parametrize("vector", DURATIONS["vectors"], ids=lambda vector: repr(vector["input"]))
def test_duration(vector: dict[str, Any]) -> None:
    if "error" in vector["expected"]:
        with pytest.raises(ValueError):
            parse_duration(vector["input"])
    else:
        assert parse_duration(vector["input"]) == vector["expected"]["ms"]
