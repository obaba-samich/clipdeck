# Clipdeck

Game clipping for Linux, built for one PC (Pop!_OS, COSMIC, Wayland). Always-on replay, clip with a hotkey or by saying "clip that", and a clip library you can open on your PC or phone.

## Features

**Capturing**
- Always-on replay buffer (15 s to 5 min), saved only when you clip
- **F8** saves the last 30 s (adjustable); an optional second hotkey saves the whole buffer
- **Voice clipping**: say "clip that" (or your own phrases). Offline speech recognition (Vosk), with adjustable strictness
- **Auto clips** on loud moments (yelling, cheering), with a live mic meter to set the level
- Clip from the web app or the phone ("Clip" button)
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

**Sharing**
- Share links (work on your Wi-Fi), with a share page
- Send to Discord through a webhook (auto-fits under 10 MB)
- "Download for sharing" mixes game and mic into one track so clips play everywhere
- Phone share sheet (Messages, TikTok, Discord…) sends the actual file

**Phone app**
- Same library, made for phones, installable to the home screen (PWA)
- Pair by scanning the QR code in Settings → Phone and entering the 6-digit passcode

## Recording

Recording is done by [GPU Screen Recorder](https://git.dec05eba.com/gpu-screen-recorder/about/) (flatpak) using **CPU encoding** (x264). The RX 570's hardware encoder froze this PC on 2026-11-16, so Clipdeck never uses it, not even as a setting.

## Install / update

```bash
./install.sh
```

Sets up the Python env, builds the web app, downloads the voice model, adds the `clipdeck` command, starts the `clipdeck` user service on login, and adds the F8 shortcut to COSMIC (your other shortcuts are kept; the original file is backed up as `custom.before-clipdeck`).

```bash
clipdeck status            # replay, mic, current game
clipdeck clip              # same as F8
clipdeck clip --long       # whole buffer
clipdeck passcode          # phone address + passcode
systemctl --user restart clipdeck
journalctl --user -u clipdeck -f
```

## Layout

- `clipdeck/`: Python service (FastAPI). `recorder.py` runs GPU Screen Recorder, `listener.py` handles voice and loud moments, `library.py` handles clips, `server.py` the API, `hotkeys.py` the COSMIC shortcuts.
- `web/`: React app (Vite). `npm run build` outputs to `clipdeck/static/`.
- Config `~/.config/clipdeck/config.json`, database `~/.local/share/clipdeck/`, thumbnails `~/.cache/clipdeck/`, clips `~/Videos/Clipdeck/`.
