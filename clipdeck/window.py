"""Clipdeck's desktop window: a native GTK 4 / libadwaita app with WebKit showing the library.

Runs with the system Python (it needs PyGObject, which the service's venv
doesn't have) and imports nothing else from Clipdeck. Only one window ever
exists: launching again (from the app menu, tray or a notification) brings it
to the front and opens the requested page.

    /usr/bin/python3 window.py [url]
"""

from __future__ import annotations

import os
import subprocess
import sys
import urllib.parse
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
gi.require_version("WebKit", "6.0")
from gi.repository import Adw, Gdk, Gio, GLib, Gtk, WebKit  # noqa: E402

APP_ID = "io.github.obaba_samich.Clipdeck"
DEFAULT_URL = "http://localhost:7878/"
STATE = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "clipdeck" / "window"
DOWNLOADS = Path(GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) or Path.home() / "Downloads")
BG = Gdk.RGBA()
BG.parse("#0b0c0f")


class Window(Adw.ApplicationWindow):
    def __init__(self, app: Adw.Application, url: str):
        super().__init__(application=app, title="Clipdeck")
        self.base = urllib.parse.urlsplit(url)
        w, h, maxed = self._load_size()
        self.set_default_size(w, h)
        if maxed:
            self.maximize()

        session = WebKit.NetworkSession.get_default()
        session.connect("download-started", self._on_download)

        self.web = WebKit.WebView(network_session=session)
        self.web.set_background_color(BG)
        s = self.web.get_settings()
        s.set_enable_developer_extras(True)
        s.set_media_playback_requires_user_gesture(False)
        s.set_enable_back_forward_navigation_gestures(True)
        s.set_hardware_acceleration_policy(WebKit.HardwareAccelerationPolicy.ALWAYS)
        s.set_user_agent_with_application_details("ClipdeckDesktop", "1.0")
        self.web.connect("decide-policy", self._on_policy)
        self.web.connect("create", self._on_create)
        self.web.connect("load-failed", self._on_failed)
        self.web.connect("notify::title", lambda *_: None)

        # A thin native title bar so the window looks and moves like any other app.
        header = Adw.HeaderBar()
        header.set_title_widget(Adw.WindowTitle(title="Clipdeck"))
        back = Gtk.Button(icon_name="go-previous-symbolic", tooltip_text="Back")
        back.connect("clicked", lambda *_: self.web.go_back())
        header.pack_start(back)
        reload_ = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Reload")
        reload_.connect("clicked", lambda *_: self.web.reload())
        header.pack_end(reload_)

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        box.append(header)
        self.web.set_vexpand(True)
        box.append(self.web)
        self.set_content(box)

        self._shortcut("<Control>r", self.web.reload)
        self._shortcut("F5", self.web.reload)
        self._shortcut("<Alt>Left", self.web.go_back)
        self._shortcut("<Alt>Right", self.web.go_forward)
        self._shortcut("<Control>q", self.close)
        self._shortcut("F11", lambda: self.unfullscreen() if self.is_fullscreen() else self.fullscreen())
        self.connect("close-request", self._save_size)
        self.go(url)

    def _shortcut(self, accel: str, fn) -> None:
        ctl = Gtk.ShortcutController()
        ctl.set_scope(Gtk.ShortcutScope.GLOBAL)
        ctl.add_shortcut(Gtk.Shortcut.new(Gtk.ShortcutTrigger.parse_string(accel),
                                          Gtk.CallbackAction.new(lambda *_: (fn(), True)[1])))
        self.add_controller(ctl)

    def go(self, url: str) -> None:
        self.web.load_uri(url)

    def _ours(self, uri: str) -> bool:
        u = urllib.parse.urlsplit(uri)
        return u.scheme in ("http", "https") and u.netloc == self.base.netloc or u.scheme in ("about", "data", "blob")

    # links, popups, downloads ----------------------------------------------------

    def _on_policy(self, view, decision, kind):
        if kind in (WebKit.PolicyDecisionType.NAVIGATION_ACTION, WebKit.PolicyDecisionType.NEW_WINDOW_ACTION):
            uri = decision.get_navigation_action().get_request().get_uri()
            if not self._ours(uri):
                Gio.AppInfo.launch_default_for_uri(uri, None)  # Discord, docs... open in the browser
                decision.ignore()
                return True
        elif kind == WebKit.PolicyDecisionType.RESPONSE:
            resp = decision.get_response()
            disp = (resp.get_http_headers().get_one("Content-Disposition") or "") if resp.get_http_headers() else ""
            if disp.lower().startswith("attachment") or not decision.is_mime_type_supported():
                decision.download()
                return True
        return False

    def _on_create(self, view, action):
        uri = action.get_request().get_uri()
        if self._ours(uri):
            self.go(uri)
        else:
            Gio.AppInfo.launch_default_for_uri(uri, None)
        return None

    def _on_download(self, session, download):
        def decide(dl, suggested):
            DOWNLOADS.mkdir(parents=True, exist_ok=True)
            dest = DOWNLOADS / (suggested or "clip.mp4")
            n = 2
            while dest.exists():
                dest = dest.with_name(f"{dest.stem} ({n}){dest.suffix}")
                n += 1
            dl.set_destination(str(dest))
            return True

        def finished(dl):
            path = dl.get_destination()
            note = Gio.Notification.new("Saved to Downloads")
            note.set_body(Path(path).name if path else "")
            note.set_default_action_and_target("app.show-file", GLib.Variant("s", path or ""))
            self.get_application().send_notification("download", note)

        download.connect("decide-destination", decide)
        download.connect("finished", finished)

    def _on_failed(self, view, event, uri, error):
        if error.matches(WebKit.NetworkError.quark(), WebKit.NetworkError.CANCELLED):
            return False
        html = f"""<html><body style="background:#0b0c0f;color:#eef0f4;font:16px Inter,sans-serif;display:flex;
        height:100vh;margin:0;align-items:center;justify-content:center;text-align:center"><div>
        <h2>Clipdeck isn't running</h2><p style="color:#7c8293">Starting it now. This page retries by itself.</p></div>
        <script>setTimeout(()=>location.href={uri!r},2500)</script></body></html>"""
        subprocess.Popen(["systemctl", "--user", "start", "clipdeck"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        view.load_alternate_html(html, uri, None)
        return True

    # remember size -----------------------------------------------------------------

    def _load_size(self):
        try:
            w, h, m = STATE.read_text().split()
            return max(800, int(w)), max(560, int(h)), m == "1"
        except (OSError, ValueError):
            return 1440, 920, False

    def _save_size(self, *_):
        try:
            STATE.parent.mkdir(parents=True, exist_ok=True)
            w, h = self.get_default_size()
            STATE.write_text(f"{w} {h} {1 if self.is_maximized() else 0}")
        except OSError:
            pass
        return False


class App(Adw.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
        self.win: Window | None = None
        act = Gio.SimpleAction.new("show-file", GLib.VariantType.new("s"))
        act.connect("activate", lambda _a, p: p.get_string() and Gio.AppInfo.launch_default_for_uri(
            Path(p.get_string()).parent.as_uri(), None))
        self.add_action(act)

    def do_startup(self):
        Adw.Application.do_startup(self)
        Adw.StyleManager.get_default().set_color_scheme(Adw.ColorScheme.FORCE_DARK)
        Gtk.Window.set_default_icon_name("clipdeck")

    def do_command_line(self, cmd):
        args = cmd.get_arguments()[1:]
        url = next((a for a in args if a.startswith("http")), None)
        if self.win is None:
            self.win = Window(self, url or DEFAULT_URL)
        elif url:
            self.win.go(url)
        self.win.present()
        return 0


if __name__ == "__main__":
    sys.exit(App().run(sys.argv))
