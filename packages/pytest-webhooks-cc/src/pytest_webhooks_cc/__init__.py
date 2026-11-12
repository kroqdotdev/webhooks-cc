"""pytest plugin for webhooks.cc.

Installing ``pytest-webhooks-cc`` gives every test the ``webhooks_cc`` and
``webhooks_cc_endpoint`` fixtures, with nothing to import and no conftest:

.. code-block:: python

    def test_checkout_sends_a_webhook(webhooks_cc, webhooks_cc_endpoint):
        checkout(webhook_url=webhooks_cc_endpoint.url)
        request = webhooks_cc.requests.wait_for(webhooks_cc_endpoint.slug, timeout="30s")
        assert request.json()["type"] == "checkout.session.completed"

The fixtures are the ones the ``webhooks-cc`` SDK ships
(:mod:`webhooks_cc.pytest_plugin`); the plugin itself is in
:mod:`pytest_webhooks_cc.plugin`.
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
