# Clipdeck

> [!WARNING]
> **Early test version.** Clipdeck is being tested by a few people. It's made and tested on Pop!_OS 24.04 (COSMIC, Wayland) and should work on Ubuntu-based distros with GNOME too, but expect rough edges. If something breaks, please [open an issue](https://github.com/obaba-samich/clipdeck/issues) with what happened and the log (see [Reporting problems](#reporting-problems)).

Game clipping for Linux, like Medal. Always-on replay, clip with a hotkey or by saying "clip that", and a clip library you can open on your PC or phone.

## Install

**You need:** a systemd Linux desktop (Ubuntu 24.04, Pop!_OS 24.04 or newer), PipeWire, Python 3.11+, and [GPU Screen Recorder](https://flathub.org/apps/com.dec05eba.gpu_screen_recorder) from Flathub:

```bash
flatpak install --user flathub com.dec05eba.gpu_screen_recorder
```

1. Download `clipdeck-linux.tar.gz` from the [linux-latest release](https://github.com/obaba-samich/clipdeck/releases/tag/linux-latest).
2. Unpack it somewhere it can stay (for example your home folder) and run the installer:

```bash
tar -xzf clipdeck-linux.tar.gz -C ~ && ~/clipdeck/install.sh
```

The installer tells you the exact `sudo apt install …` line if anything is missing. It sets up everything for your user only: the Python environment, the voice model (40 MB), the `clipdeck` command, a background service that starts on login, the app launcher entry and the **F8** hotkey. Then press F8 in a game, or open Clipdeck from the app launcher.

**Update:** download the new `clipdeck-linux.tar.gz`, unpack it over the same folder and run `install.sh` again. Your clips and settings are kept.

**Uninstall:** `~/clipdeck/uninstall.sh`. It removes the service, hotkeys and launcher entry and keeps your clips and settings (it prints where they are).

From a git clone it works the same, but building the web app also needs Node.js 18+.

### Good to know

- **Encoding:** Clipdeck records with your graphics card by default, which barely affects games, and falls back to the CPU if the card can't encode. You can switch to CPU in Settings → Recording. AMD Polaris cards (RX 470/480/570/580/590) always use the CPU: an RX 570's encoder froze a PC while recording.
- **Hotkeys** are set up automatically on COSMIC and GNOME. On other desktops (KDE, …), add a custom shortcut in your keyboard settings that runs `~/.local/bin/clipdeck clip`; Settings → Hotkeys shows the exact command.
- **Tray icon** on GNOME needs the AppIndicator extension (Ubuntu has it already).
- **Clipdeck's own window** needs `python3-gi gir1.2-adw-1 gir1.2-webkit-6.0`. Without them it opens in a browser window instead.
- **Phone:** off by default. Turn on Settings → Phone → Allow other devices, then scan the QR code. It works on your home Wi-Fi (or anywhere with Tailscale).

## Features

**Capturing**
- Always-on replay buffer, saved only when you clip
- **F8** saves a clip of the last 30 s (Settings → Clip length, 15 s to 5 min)
- **Voice clipping**: say "clip that" (or your own phrases). Offline speech recognition (Vosk), with adjustable strictness
- **Auto clips** on loud moments (yelling, cheering), with a live mic meter to set the level
- Clip from the web app or the phone ("Clip" button)
- **Full recording**: Record button (PC, phone, tray or a hotkey) records everything until you stop it, alongside the replay buffer
- Game audio and mic saved as **separate tracks**
- Only-while-playing mode: the buffer runs only while a game is open
- Sound + desktop notification (with thumbnail) when a clip saves
- Game detection: Steam games (with their cover art), Roblox, Minecraft, osu!; clips sorted into a folder per game

**Library** (http://localhost:7878)
- Home, all clips, favorites, games, albums, trash
- Hover previews, search (`/` or Ctrl+K), sorting, filters by game and how it was clipped
- Multi-select (click the check, Shift-click for a range, Ctrl+A), right-click menu, bulk actions
- Player: trim timeline with frame strip, separate game/mic volume, loop, speed, frame-by-frame (`,` `.`), I/O to set trim, J/K/L, F for fullscreen
- Non-destructive trims, or save the trim as a new clip
- Rename, change game, favorite, albums
- Trash with restore, auto-empty after N days, optional size limit that cleans up the oldest non-favorites

**Editor** (on PC and phone)
- Put any clips on one timeline (select clips → Edit together), reorder, trim each with handles, split at the playhead, duplicate
- Speed per clip from 0.25× to 4× (slow-mo / fast-forward), mute per clip
- Text: 5 fonts, colors, outline/box/shadow, pop-up or fade animation, drag to place, drag its bar to retime
- Canvas: 16:9, 9:16 (TikTok/Shorts) with blurred background or crop, 1:1, 4:5; zoom and pan
- Color looks (Vivid, Cinematic, Bright, B&W) and brightness/contrast/saturation, vignette, sharpen
- Game/mic volume, audio fades, fade from/to black, fade between clips
- Undo/redo, autosave, keyboard shortcuts (Space, S split, T text, arrows)
- Export to MP4 (480p–1440p, 24/30/60 fps) as a new library clip, or GIF; runs at low priority with progress and cancel

**Desktop**
- App launcher entry with icon (right-click: Save clip now)
- Tray icon in the panel: red dot while recording; menu to clip, toggle replay/voice/auto clips, open edits, folder, settings, and Quit (the launcher icon starts it again)
- Notifications with Open / Edit / Delete buttons; alerts when replay stops or the drive is nearly full

**Library extras**
- Select mode (works on phones), select all, bulk favorite / album / move game / delete, Edit together
- Import videos (drag onto the window, or pick from the phone's camera roll)
- Save any frame as a PNG; Show in folder
- Choose the clips folder with a folder picker (other drives too), optionally moving existing clips

**Sharing**
- Share links (work on your Wi-Fi), with a share page
- Send to Discord through a webhook (auto-fits under 10 MB)
- "Download for sharing" mixes game and mic into one track so clips play everywhere
- Phone share sheet (Messages, TikTok, Discord…) sends the actual file

**Phone app**
- Same library, made for phones, installable to the home screen (PWA)
- Pair by scanning the QR code in Settings → Phone and entering the 6-digit passcode

## Security

- Other devices need the 6-digit passcode; "New passcode" signs every phone out.
- Requests addressed to unknown host names are refused (blocks DNS-rebinding tricks), and changes coming from other websites in your browser are blocked.
- "Allow other devices: off" takes effect immediately.

## Recording

Recording is done by [GPU Screen Recorder](https://git.dec05eba.com/gpu-screen-recorder/about/) (flatpak), on the graphics card or the CPU (x264) as described above. Hotkeys go through the desktop's own custom shortcuts (on COSMIC the original file is backed up as `custom.before-clipdeck`; on GNOME they're the `clipdeck-*` custom keybindings).

## Commands

```bash
clipdeck open              # open the library window
clipdeck status            # replay, mic, current game
clipdeck clip              # same as F8
clipdeck record            # start/stop a full recording
clipdeck passcode          # phone address + passcode
systemctl --user restart clipdeck
```

## Reporting problems

Open an [issue](https://github.com/obaba-samich/clipdeck/issues) with what you did, what happened, your distro and desktop, your graphics card, and the log:

```bash
journalctl --user -u clipdeck --since "1 hour ago" --no-pager > clipdeck-log.txt
```

Check the log for anything private before you post it.

## Layout

- `clipdeck/`: Python service (FastAPI). `recorder.py` runs GPU Screen Recorder, `listener.py` handles voice and loud moments, `library.py` handles clips, `editor.py` renders edits with ffmpeg, `tray.py` is the tray icon and notifications, `server.py` the API, `hotkeys.py` the COSMIC/GNOME shortcuts.
- `ios/`: iPhone app (SwiftUI shell around the library). Built by `.github/workflows/ios.yml` into release `ios-latest`.
- `web/`: React app (Vite). `npm run build` outputs to `clipdeck/static/`.
- Config `~/.config/clipdeck/config.json`, database `~/.local/share/clipdeck/`, thumbnails `~/.cache/clipdeck/`, clips `~/Videos/Clipdeck/`.
