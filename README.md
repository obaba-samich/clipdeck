# Clipdeck

Game clipping for Linux. Always-on replay, clip with a hotkey or by saying "clip that", and a clip library you can open on your PC or phone.

Recording is done by [GPU Screen Recorder](https://git.dec05eba.com/gpu-screen-recorder/about/) (flatpak) using **CPU encoding** (x264). The RX 570's hardware encoder crashes this PC, so Clipdeck never uses it.

## Run

```bash
./install.sh        # venv, web build, voice model, systemd user service, F8 shortcut
systemctl --user status clipdeck
```

Library: http://localhost:7878 (and http://<pc-ip>:7878 on your phone).
