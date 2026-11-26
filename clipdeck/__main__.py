"""Command line: `python -m clipdeck serve | clip | status | passcode`."""

from __future__ import annotations

import argparse
import json
import logging
import sys
import urllib.error
import urllib.request

from .config import Config


def _call(method: str, path: str, body: dict | None = None) -> dict:
    port = Config()["server"]["port"]
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def _open() -> int:
    """Start the service if it's not running, then open the library in its own app window."""
    import subprocess
    import time

    port = Config()["server"]["port"]
    url = f"http://localhost:{port}"
    try:
        _call("GET", "/api/me")
    except (urllib.error.URLError, OSError):
        subprocess.run(["systemctl", "--user", "start", "clipdeck"], check=False)
        for _ in range(40):
            try:
                _call("GET", "/api/me")
                break
            except (urllib.error.URLError, OSError):
                time.sleep(0.25)
    from .launch import open_window

    open_window(url)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="clipdeck")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("serve", help="run the recorder and the web library")
    c = sub.add_parser("clip", help="save a clip from the replay buffer")
    c.add_argument("--long", action="store_true", help=argparse.SUPPRESS)  # old shortcut flag; every clip is the whole buffer now
    c.add_argument("--seconds", type=float, help="save the last N seconds")
    sub.add_parser("record", help="start or stop a full recording")
    sub.add_parser("status", help="show recorder and mic status")
    sub.add_parser("passcode", help="show the phone login passcode and address")
    sub.add_parser("open", help="start Clipdeck if needed and open the library window")
    args = ap.parse_args()

    if args.cmd == "open":
        return _open()

    if args.cmd == "serve":
        import uvicorn

        from .server import create_app

        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
        cfg = Config()
        host = "0.0.0.0" if cfg["server"]["lan"] else "127.0.0.1"
        uvicorn.run(create_app(), host=host, port=int(cfg["server"]["port"]), log_level="warning",
                    timeout_graceful_shutdown=2)  # live-update connections never close on their own
        return 0

    try:
        if args.cmd == "clip":
            body = {"source": "hotkey_long" if args.long else "hotkey"}
            if args.seconds:
                body["seconds"] = args.seconds
            r = _call("POST", "/api/clip", body)
            print("Saving clip" if r.get("ok") else f"Not saved: {r.get('reason')}")
            return 0 if r.get("ok") else 1
        if args.cmd == "record":
            r = _call("POST", "/api/record", {"source": "hotkey"})
            print(("Recording" if r.get("recording") else "Stopped recording") if r.get("ok") else f"Can't record: {r.get('reason')}")
            return 0 if r.get("ok") else 1
        if args.cmd == "status":
            s = _call("GET", "/api/status")
            print(f"Replay: {s['recorder']['state']}  ({s['recorder']['buffer_seconds']}s buffer)")
            print(f"Mic:    {s['listener']['state']}")
            print(f"Game:   {s['game']}")
            print(f"Clips:  {s['stats']['clips']}")
            print(f"Phone:  {s['lan_url']}")
            return 0
        if args.cmd == "passcode":
            s = _call("GET", "/api/status")
            print(f"Open {s['lan_url']} on your phone and enter {Config()['server']['passcode']}")
            return 0
    except urllib.error.URLError:
        print("Clipdeck isn't running. Start it: systemctl --user start clipdeck", file=sys.stderr)
        return 2
    return 1


if __name__ == "__main__":
    sys.exit(main())
