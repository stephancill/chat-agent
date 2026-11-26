#!/usr/bin/env python3
"""Deploy the Worker through stupid vault's Cloudflare proxy, without wrangler auth.

Usage:
  npm run build
  APRON_TOKEN=... OPENROUTER_API_KEY=... ADMIN_TOKEN=... \
    python3 scripts/vault_deploy.py --account <account_id> --vault-skill <path to skills/stupid-vault>

Secrets are optional on redeploys: any of APRON_TOKEN, OPENROUTER_API_KEY,
ADMIN_TOKEN left unset keeps the Worker's existing value. Each Cloudflare API
call is approved in the stupid vault app.
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import tomllib
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRETS = ["APRON_TOKEN", "OPENROUTER_API_KEY", "ADMIN_TOKEN"]


def vault(skill: str, method: str, url: str, body: str | None = None, content_type: str | None = None, hint: str = "") -> dict:
    cmd = [sys.executable, os.path.join(skill, "scripts", "vault_proxy.py"), "--approval-timeout", "600", "-X", method]
    if hint:
        cmd += ["--consent-hint", hint]
    if content_type:
        cmd += ["-H", f"content-type: {content_type}"]
    if body is not None:
        cmd += ["--data-binary", body]
    cmd.append(url)
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"vault request failed ({out.returncode}): {out.stderr.strip()}")
    try:
        data = json.loads(out.stdout)
    except json.JSONDecodeError:
        sys.exit(f"unexpected response: {out.stdout[:500]}\n{out.stderr.strip()[-500:]}")
    if not data.get("success", False):
        sys.exit(f"Cloudflare API error: {json.dumps(data)[:2000]}\n{out.stderr.strip()[-500:]}")
    return data


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--account", required=True)
    ap.add_argument("--vault-skill", required=True)
    args = ap.parse_args()

    with open(os.path.join(ROOT, "wrangler.toml"), "rb") as f:
        cfg = tomllib.load(f)
    name = cfg["name"]
    api = f"https://api.cloudflare.com/client/v4/accounts/{args.account}/workers/scripts/{name}"

    with open(os.path.join(ROOT, "dist", "index.js"), "rb") as f:
        script = f.read()

    bindings = [{"type": "durable_object_namespace", "name": b["name"], "class_name": b["class_name"]} for b in cfg["durable_objects"]["bindings"]]
    bindings += [{"type": "plain_text", "name": k, "text": v} for k, v in cfg.get("vars", {}).items()]
    keep = []
    for s in SECRETS:
        if os.environ.get(s):
            bindings.append({"type": "secret_text", "name": s, "text": os.environ[s]})
        else:
            keep.append(s)

    metadata = {
        "main_module": "index.js",
        "compatibility_date": cfg["compatibility_date"],
        "bindings": bindings,
        "keep_bindings": ["secret_text"] if keep else [],
        "observability": {"enabled": True},
    }
    tags = [m["tag"] for m in cfg.get("migrations", [])]
    if tags:
        # Cloudflare skips migrations already applied (by old_tag/new_tag).
        steps = [{k: v for k, v in m.items() if k != "tag"} for m in cfg["migrations"]]
        metadata["migrations"] = {"new_tag": tags[-1], "steps": steps}

    boundary = f"----chatagent{uuid.uuid4().hex}"
    parts = [
        (f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n').encode()
        + json.dumps(metadata).encode()
        + b"\r\n",
        (f'--{boundary}\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\nContent-Type: application/javascript+module\r\n\r\n').encode()
        + script
        + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    body = base64.b64encode(b"".join(parts)).decode()

    print(f"Uploading {name} ({len(script)} bytes); secrets set: {[s for s in SECRETS if s not in keep]}, kept: {keep}")
    res = vault(args.vault_skill, "PUT", api, body, f"multipart/form-data; boundary={boundary}", f"Deploy Worker {name} (chat-agent Apron bot)")
    print("uploaded:", res["result"].get("id"), res["result"].get("modified_on"))

    crons = cfg.get("triggers", {}).get("crons", [])
    vault(args.vault_skill, "PUT", f"{api}/schedules", json.dumps([{"cron": c} for c in crons]), "application/json", f"Set cron for {name}")
    print("schedules:", crons)

    vault(args.vault_skill, "POST", f"{api}/subdomain", json.dumps({"enabled": True, "previews_enabled": False}), "application/json", f"Enable workers.dev for {name}")
    sub = vault(args.vault_skill, "GET", f"https://api.cloudflare.com/client/v4/accounts/{args.account}/workers/subdomain", hint="Read workers.dev subdomain")
    print(f"URL: https://{name}.{sub['result']['subdomain']}.workers.dev")


if __name__ == "__main__":
    main()
