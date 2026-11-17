"""Taskbar (system tray) icon and desktop notifications with buttons.

The tray icon is a StatusNotifierItem with a com.canonical.dbusmenu menu,
which COSMIC's status area (and KDE, and GNOME with AppIndicator) shows.
Notifications go through org.freedesktop.Notifications so they can carry
actions like Open / Edit / Delete.
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import threading
from pathlib import Path

import numpy as np
from dbus_next import BusType, Variant
from dbus_next.aio import MessageBus
from dbus_next.constants import PropertyAccess
from dbus_next.service import ServiceInterface, dbus_property, method, signal

from .launch import open_window

log = logging.getLogger("clipdeck.tray")
ASSETS = Path(__file__).parent / "assets"


def _pixmaps(name: str) -> list:
    """[[w, h, ARGB32 bytes]] for each size on disk."""
    out = []
    for size in (22, 32, 64):
        f = ASSETS / f"tray-{name}-{size}.rgba"
        if not f.exists():
            continue
        rgba = np.frombuffer(f.read_bytes(), dtype=np.uint8).reshape(-1, 4)
        argb = rgba[:, [3, 0, 1, 2]].tobytes()  # network byte order ARGB
        out.append([size, size, argb])
    return out


class Item(ServiceInterface):
    def __init__(self, tray: "Tray"):
        super().__init__("org.kde.StatusNotifierItem")
        self.tray = tray

    @dbus_property(access=PropertyAccess.READ)
    def Category(self) -> "s":
        return "ApplicationStatus"

    @dbus_property(access=PropertyAccess.READ)
    def Id(self) -> "s":
        return "clipdeck"

    @dbus_property(access=PropertyAccess.READ)
    def Title(self) -> "s":
        return "Clipdeck"

    @dbus_property(access=PropertyAccess.READ)
    def Status(self) -> "s":
        return "Active"

    @dbus_property(access=PropertyAccess.READ)
    def WindowId(self) -> "i":
        return 0

    @dbus_property(access=PropertyAccess.READ)
    def IconName(self) -> "s":
        return ""

    @dbus_property(access=PropertyAccess.READ)
    def IconPixmap(self) -> "a(iiay)":
        return self.tray.icon_pixmaps()

    @dbus_property(access=PropertyAccess.READ)
    def IconThemePath(self) -> "s":
        return ""

    @dbus_property(access=PropertyAccess.READ)
    def AttentionIconPixmap(self) -> "a(iiay)":
        return []

    @dbus_property(access=PropertyAccess.READ)
    def OverlayIconPixmap(self) -> "a(iiay)":
        return []

    @dbus_property(access=PropertyAccess.READ)
    def OverlayIconName(self) -> "s":
        return ""

    @dbus_property(access=PropertyAccess.READ)
    def AttentionIconName(self) -> "s":
        return ""

    @dbus_property(access=PropertyAccess.READ)
    def ToolTip(self) -> "(sa(iiay)ss)":
        return ["", [], "Clipdeck", self.tray.tooltip()]

    @dbus_property(access=PropertyAccess.READ)
    def ItemIsMenu(self) -> "b":
        return False

    @dbus_property(access=PropertyAccess.READ)
    def Menu(self) -> "o":
        return "/MenuBar"

    @method()
    def Activate(self, x: "i", y: "i"):
        self.tray.open("/")

    @method()
    def SecondaryActivate(self, x: "i", y: "i"):
        self.tray.core.clip(source="hotkey")

    @method()
    def ContextMenu(self, x: "i", y: "i"):
        pass

    @method()
    def Scroll(self, delta: "i", orientation: "s"):
        pass

    @signal()
    def NewIcon(self):
        pass

    @signal()
    def NewToolTip(self):
        pass

    @signal()
    def NewStatus(self) -> "s":
        return "Active"


class Menu(ServiceInterface):
    def __init__(self, tray: "Tray"):
        super().__init__("com.canonical.dbusmenu")
        self.tray = tray
        self.revision = 1

    def _items(self) -> list[tuple[int, dict]]:
        c = self.tray.core
        cfg = c.config
        rec = c.recorder.state
        clip_s = cfg["recorder"]["default_clip_seconds"]
        buf = cfg["recorder"]["replay_seconds"]
        recording = rec == "recording"

        def item(label, enabled=True, **extra):
            d = {"label": Variant("s", label), "enabled": Variant("b", enabled), "visible": Variant("b", True)}
            for k, v in extra.items():
                d[k.replace("_", "-")] = v
            return d

        def check(label, on, enabled=True):
            return item(label, enabled, toggle_type=Variant("s", "checkmark"), toggle_state=Variant("i", 1 if on else 0))

        sep = {"type": Variant("s", "separator"), "visible": Variant("b", True)}
        status = {"recording": f"Replay on · {buf}s", "starting": "Starting…", "error": "Replay stopped (error)"}.get(rec, "Replay off")
        game = c.games.current()[0]
        return [
            (1, item("Open Clipdeck")),
            (2, item(f"{status}{'' if game == 'Desktop' else ' · ' + game}", enabled=False)),
            (3, sep),
            (4, item(f"Save clip (last {clip_s}s)", enabled=recording)),
            (5, item(f"Save whole buffer ({buf}s)", enabled=recording)),
            (6, sep),
            (7, check("Replay buffer", cfg["recorder"]["enabled"])),
            (8, check("Voice clipping", cfg["voice"]["enabled"])),
            (9, check("Auto clips", cfg["hype"]["enabled"])),
            (10, check("Only while playing", cfg["recorder"]["only_while_gaming"])),
            (11, sep),
            (12, item("Edits")),
            (13, item("Open clips folder")),
            (14, item("Settings")),
            (15, sep),
            (16, item("Restart recorder")),
        ]

    def _layout(self):
        children = [Variant("(ia{sv}av)", [i, props, []]) for i, props in self._items()]
        return [0, {"children-display": Variant("s", "submenu")}, children]

    @method()
    def GetLayout(self, parent_id: "i", recursion_depth: "i", property_names: "as") -> "u(ia{sv}av)":
        if parent_id != 0:
            props = dict(self._items()).get(parent_id, {})
            return [self.revision, [parent_id, props, []]]
        return [self.revision, self._layout()]

    @method()
    def GetGroupProperties(self, ids: "ai", property_names: "as") -> "a(ia{sv})":
        items = dict(self._items())
        return [[i, items[i]] for i in (ids or items.keys()) if i in items]

    @method()
    def GetProperty(self, id: "i", name: "s") -> "v":
        return dict(self._items()).get(id, {}).get(name, Variant("s", ""))

    @method()
    def Event(self, id: "i", event_id: "s", data: "v", timestamp: "u"):
        if event_id == "clicked":
            self.tray.menu_clicked(id)

    @method()
    def EventGroup(self, events: "a(isvu)") -> "ai":
        for ev in events:
            if ev[1] == "clicked":
                self.tray.menu_clicked(ev[0])
        return []

    @method()
    def AboutToShow(self, id: "i") -> "b":
        return False

    @method()
    def AboutToShowGroup(self, ids: "ai") -> "aiai":
        return [[], []]

    @signal()
    def LayoutUpdated(self) -> "ui":
        return [self.revision, 0]

    @dbus_property(access=PropertyAccess.READ)
    def Version(self) -> "u":
        return 3

    @dbus_property(access=PropertyAccess.READ)
    def TextDirection(self) -> "s":
        return "ltr"

    @dbus_property(access=PropertyAccess.READ)
    def Status(self) -> "s":
        return "normal"

    @dbus_property(access=PropertyAccess.READ)
    def IconThemePath(self) -> "as":
        return []

    def changed(self):
        self.revision += 1
        self.LayoutUpdated()


class Tray:
    """Runs its own asyncio loop on a thread; everything else calls in thread-safely."""

    def __init__(self, core):
        self.core = core
        self.loop = asyncio.new_event_loop()
        self.bus: MessageBus | None = None
        self.item: Item | None = None
        self.menu: Menu | None = None
        self.notify_iface = None
        self.notes: dict[int, str] = {}  # notification id -> clip id
        self._state = None
        self._icons = {n: _pixmaps(n) for n in ("idle", "rec", "off")}
        self.ready = False

    # lifecycle -----------------------------------------------------------------

    def start(self) -> None:
        threading.Thread(target=self._run, daemon=True, name="tray").start()

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._setup())
            self.loop.create_task(self._watch())
            self.loop.run_forever()
        except Exception:
            log.exception("tray unavailable")

    async def _setup(self) -> None:
        self.bus = await MessageBus(bus_type=BusType.SESSION).connect()
        self.item = Item(self)
        self.menu = Menu(self)
        self.bus.export("/StatusNotifierItem", self.item)
        self.bus.export("/MenuBar", self.menu)
        name = f"org.kde.StatusNotifierItem-{os.getpid()}-1"
        await self.bus.request_name(name)
        self.name = name
        await self._register()
        await self._setup_notifications()
        # Re-register if the panel restarts.
        intro = await self.bus.introspect("org.freedesktop.DBus", "/org/freedesktop/DBus")
        dbus = self.bus.get_proxy_object("org.freedesktop.DBus", "/org/freedesktop/DBus", intro).get_interface("org.freedesktop.DBus")
        dbus.on_name_owner_changed(lambda n, old, new: n == "org.kde.StatusNotifierWatcher" and new
                                   and self.loop.create_task(self._register()))
        self.ready = True

    async def _register(self) -> None:
        try:
            intro = await self.bus.introspect("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher")
            w = self.bus.get_proxy_object("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", intro)
            await w.get_interface("org.kde.StatusNotifierWatcher").call_register_status_notifier_item(self.name)
            log.info("tray icon registered")
        except Exception as e:
            log.warning("no system tray to register with: %s", e)

    async def _setup_notifications(self) -> None:
        try:
            intro = await self.bus.introspect("org.freedesktop.Notifications", "/org/freedesktop/Notifications")
            obj = self.bus.get_proxy_object("org.freedesktop.Notifications", "/org/freedesktop/Notifications", intro)
            self.notify_iface = obj.get_interface("org.freedesktop.Notifications")
            self.notify_iface.on_action_invoked(self._on_action)
        except Exception as e:
            log.warning("notifications unavailable: %s", e)

    async def _watch(self) -> None:
        """Refresh icon, tooltip and menu when the state changes."""
        while True:
            c = self.core
            st = (c.recorder.state, c.config["recorder"]["enabled"], c.config["voice"]["enabled"],
                  c.config["hype"]["enabled"], c.config["recorder"]["only_while_gaming"],
                  c.config["recorder"]["replay_seconds"], c.config["recorder"]["default_clip_seconds"],
                  c.games.current()[0])
            if st != self._state:
                self._state = st
                try:
                    self.item.NewIcon()
                    self.item.NewToolTip()
                    self.menu.changed()
                except Exception:
                    log.exception("tray update failed")
            await asyncio.sleep(1.5)

    # what the icon shows ---------------------------------------------------------

    def icon_pixmaps(self) -> list:
        st = self.core.recorder.state
        name = "rec" if st == "recording" else "off" if st in ("stopped", "error") else "idle"
        return self._icons.get(name) or self._icons.get("idle") or []

    def tooltip(self) -> str:
        c = self.core
        r = c.recorder.state
        bits = [{"recording": f"Replay on ({c.config['recorder']['replay_seconds']}s)",
                 "error": "Replay stopped: " + c.recorder.error[:80]}.get(r, "Replay off")]
        if c.listener.state == "listening" and c.config["voice"]["enabled"]:
            bits.append(f"say “{c.config['voice']['phrase'].split(',')[0].strip()}”")
        game = c.games.current()[0]
        if game != "Desktop":
            bits.append(game)
        return " · ".join(bits)

    # actions -------------------------------------------------------------------

    def url(self, path: str = "/") -> str:
        return f"http://localhost:{self.core.config['server']['port']}{path}"

    def open(self, path: str = "/") -> None:
        open_window(self.url(path))

    def menu_clicked(self, i: int) -> None:
        c = self.core
        cfg = c.config
        flip = lambda section, key: cfg.update({section: {key: not cfg[section][key]}})  # noqa: E731
        actions = {
            1: lambda: self.open("/"),
            4: lambda: c.clip(source="hotkey"),
            5: lambda: c.clip(source="hotkey", seconds=10**9),
            7: lambda: flip("recorder", "enabled"),
            8: lambda: flip("voice", "enabled"),
            9: lambda: flip("hype", "enabled"),
            10: lambda: flip("recorder", "only_while_gaming"),
            12: lambda: self.open("/edits"),
            13: lambda: subprocess.Popen(["xdg-open", str(c.config.clips_dir)],
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
            14: lambda: self.open("/settings"),
            16: lambda: c.recorder.restart() if c.recorder.state != "stopped" else c.recorder.start(),
        }
        fn = actions.get(i)
        if fn:
            threading.Thread(target=fn, daemon=True).start()

    # notifications ---------------------------------------------------------------

    def notify(self, title: str, body: str, icon: str = "", actions: list[str] | None = None,
               clip_id: str | None = None, urgency: int = 1, replace: int = 0) -> bool:
        """Show a notification. Returns False if the D-Bus service isn't there (caller falls back)."""
        if not self.ready or not self.notify_iface:
            return False

        async def go():
            hints = {"urgency": Variant("y", urgency), "desktop-entry": Variant("s", "clipdeck")}
            if icon and Path(icon).exists():
                hints["image-path"] = Variant("s", icon)
            nid = await self.notify_iface.call_notify("Clipdeck", replace, "clipdeck", title, body,
                                                      actions or [], hints, 6000)
            if clip_id:
                self.notes[nid] = clip_id
                if len(self.notes) > 50:
                    self.notes.pop(next(iter(self.notes)))

        asyncio.run_coroutine_threadsafe(go(), self.loop)
        return True

    def _on_action(self, nid: int, key: str) -> None:
        clip = self.notes.get(nid)
        if key in ("default", "open"):
            self.open(f"/clip/{clip}" if clip else "/")
        elif key == "edit" and clip:
            self.open(f"/edit?clips={clip}")
        elif key == "delete" and clip:
            threading.Thread(target=self.core.library.trash, args=(clip,), daemon=True).start()
        elif key == "settings":
            self.open("/settings#recording")
        elif key == "edits":
            self.open("/edits")
