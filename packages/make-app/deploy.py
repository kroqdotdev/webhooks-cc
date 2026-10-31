"""Deploys this app to Make through its SDK apps API, as the Make Apps Editor
does: creates the app and its components the first time, then writes every
section from the .imljson files.

  MAKE_API_TOKEN   a Make API token with sdk-apps:read and sdk-apps:write
  MAKE_ZONE        the API base of the account's zone (default eu1)
  MAKE_APP_STATE   where the remote names are kept between runs
                   (default ~/.config/webhooks-cc/make-app-state.json)

Usage: python3 deploy.py [--base-url URL]
  --base-url points the app at another host (a tunnel to a dev server while
  testing); run again without it to point it back at https://webhooks.cc.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

ZONE = os.environ.get("MAKE_ZONE", "https://eu1.make.com/api/v2")
APP_NAME_HINT = "webhooks-cc"
ROOT = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.expanduser(
    os.environ.get("MAKE_APP_STATE", "~/.config/webhooks-cc/make-app-state.json")
)
TOKEN = os.environ.get("MAKE_API_TOKEN", "").strip()
if not TOKEN:
    raise SystemExit("MAKE_API_TOKEN is not set")

# Module types by the "type" key of each module file.
MODULE_TYPE_IDS = {"trigger": 1, "action": 4, "search": 9, "instant_trigger": 10}


def call(method, path, body=None, content_type="application/json", raw=False):
    data = None
    # Make's edge refuses Python's default user agent (Cloudflare error 1010).
    headers = {
        "Authorization": "Token " + TOKEN,
        "imt-vsce-localmode": "true",
        "User-Agent": "webhooks-cc-make-deploy/1.0",
    }
    if body is not None:
        data = body.encode() if raw else json.dumps(body).encode()
        headers["Content-Type"] = content_type
    req = urllib.request.Request(ZONE + path, data=data, method=method, headers=headers)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                text = res.read().decode()
                return json.loads(text) if text.strip().startswith(("{", "[")) else text
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:400]
            if e.code == 429 and attempt < 3:
                time.sleep(5)
                continue
            raise SystemExit(f"{method} {path} -> {e.code}: {detail}")


def load(rel):
    return json.load(open(os.path.join(ROOT, rel)))


def section(path, value):
    call("PUT", path, json.dumps(value, indent=2), content_type="application/jsonc", raw=True)


def main():
    base_url = None
    if "--base-url" in sys.argv:
        base_url = sys.argv[sys.argv.index("--base-url") + 1]
    state = json.load(open(STATE)) if os.path.exists(STATE) else {}

    if "app" not in state:
        created = call("POST", "/sdk/apps", {
            "name": APP_NAME_HINT,
            "label": "webhooks.cc",
            "description": "Capture webhooks and inbound email, read the fields you need from each email, and send them on.",
            "theme": "#0f5c4c",
            "language": "en",
            "countries": [],
            "private": True,
            "audience": "global",
        })
        app = created["app"]
        state["app"] = {"name": app["name"], "version": app["version"]}
        json.dump(state, open(STATE, "w"), indent=2)
        print("created app", app["name"], "v", app["version"])
    name, version = state["app"]["name"], state["app"]["version"]
    app_path = f"/sdk/apps/{name}/{version}"

    base = load("base.imljson")
    if base_url:
        base["baseUrl"] = base_url.rstrip("/") + "/api"
    section(f"{app_path}/base", base)
    print("base set", "(dev override)" if base_url else "(production)")

    # Connection (not versioned).
    conn_file = load("connections/api-key.imljson")
    if "connection" not in state:
        created = call("POST", f"/sdk/apps/{name}/connections", {"type": conn_file["type"], "label": conn_file["label"]})
        state["connection"] = created["appConnection"]["name"]
        json.dump(state, open(STATE, "w"), indent=2)
    conn = state["connection"]
    conn_api = conn_file["communication"]
    if base_url:
        # The connection check has a full URL (connections do not use the
        # base), so a dev deploy points it at the same host.
        conn_api = json.loads(json.dumps(conn_api).replace("https://webhooks.cc", base_url.rstrip("/")))
    section(f"/sdk/apps/connections/{conn}/api", conn_api)
    section(f"/sdk/apps/connections/{conn}/parameters", conn_file["parameters"])
    print("connection", conn)

    # Webhook (not versioned).
    hook_file = load("webhooks/new-email.imljson")
    if "webhook" not in state:
        created = call("POST", f"/sdk/apps/{name}/webhooks", {"type": hook_file["type"], "label": hook_file["label"], "connection": conn})
        state["webhook"] = created["appWebhook"]["name"]
        json.dump(state, open(STATE, "w"), indent=2)
    hook = state["webhook"]
    section(f"/sdk/apps/webhooks/{hook}/api", hook_file["communication"])
    section(f"/sdk/apps/webhooks/{hook}/parameters", hook_file["parameters"])
    section(f"/sdk/apps/webhooks/{hook}/attach", hook_file["attach"])
    section(f"/sdk/apps/webhooks/{hook}/detach", hook_file["detach"])
    print("webhook", hook)

    # RPCs (versioned).
    state.setdefault("rpcs", {})
    for fname in sorted(os.listdir(os.path.join(ROOT, "rpcs"))):
        rpc = load(f"rpcs/{fname}")
        if rpc["name"] not in state["rpcs"]:
            call("POST", f"{app_path}/rpcs", {"name": rpc["name"], "label": rpc["label"], "connection": conn})
            state["rpcs"][rpc["name"]] = True
            json.dump(state, open(STATE, "w"), indent=2)
        section(f"{app_path}/rpcs/{rpc['name']}/api", rpc["communication"])
        print("rpc", rpc["name"])

    # Modules (versioned).
    state.setdefault("modules", {})
    for fname in sorted(os.listdir(os.path.join(ROOT, "modules"))):
        mod = load(f"modules/{fname}")
        if mod["name"] not in state["modules"]:
            body = {
                "name": mod["name"],
                "label": mod["label"],
                "description": mod["description"],
                "typeId": MODULE_TYPE_IDS[mod["type"]],
                "connection": conn,
                "moduleInitMode": "blank",
            }
            if mod["type"] == "instant_trigger":
                body["webhook"] = hook
            call("POST", f"{app_path}/modules", body)
            state["modules"][mod["name"]] = True
            json.dump(state, open(STATE, "w"), indent=2)
        mpath = f"{app_path}/modules/{mod['name']}"
        if "communication" in mod:
            section(f"{mpath}/api", mod["communication"])
        section(f"{mpath}/parameters", mod.get("parameters", []))
        if "expect" in mod:
            section(f"{mpath}/expect", mod["expect"])
        if "interface" in mod:
            section(f"{mpath}/interface", mod["interface"])
        if "samples" in mod:
            section(f"{mpath}/samples", mod["samples"])
        print("module", mod["name"], mod["type"])


if __name__ == "__main__":
    main()
