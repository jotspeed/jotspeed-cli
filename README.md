# Jotspeed CLI

Terminal client for [Jotspeed](https://jotspeed.com) Pro. Write a timestamped entry without opening the app:

```bash
jot "This is the entry."
```

The CLI talks to the same encrypted backup as [app.jotspeed.com](https://app.jotspeed.com). A Pro subscription is required.

## Install

Node.js 22 or newer.

```bash
npm install -g github:jotspeed/jotspeed-cli
jot login
```

Password is stored in the OS keychain (libsecret on Linux, Keychain on macOS), not in a config file. The AES key is derived once at login and reused so each jot does not re-run PBKDF2.

If `jot` is not found, add `$(npm prefix -g)/bin` to your `PATH`.

## Use

```bash
jot login
jot "shipped the mixer fix @work"
jot -1
jot -n 10
jot @work
jot -from yesterday --short
jot logout
```

`jot --help` lists filters, export, edit, and import.

## Security

- `~/.config/jotspeed/config.json` holds email, token, and sync URL only.
- Secrets live in the OS keychain under service `jotspeed`.
- A local cache under `~/.local/share/jotspeed/` is encrypted with the same AES-GCM key as the server blob.
- Lost password cannot be recovered by us. Use recovery codes from the app.

## License

[GPL-3.0-only](LICENSE). Copyright Hess Holdings.

This is original software. It is not a fork of other journal CLIs.

The Jotspeed **service** (app, sync, billing) is a separate commercial product. This repository is only the command-line client.
