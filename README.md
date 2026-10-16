# Jotspeed CLI

Terminal client for [Jotspeed](https://jotspeed.com) Pro. Write a timestamped entry without opening the app:

```bash
jot "This is the entry."
```

The CLI talks to the same encrypted backup as [app.jotspeed.com](https://app.jotspeed.com). A Pro subscription is required.

## Install

Node.js 22 or newer.

```bash
curl -fsSL https://jotspeed.com/cli/install.sh | bash
jot login
```

The script runs `npm install -g`. If Node comes from mise, nvm, fnm, or asdf, it installs under `~/.local` instead. A global install inside a versioned Node prefix is removed on the next Node upgrade, and mise then fails with `No version is set for shim: jot`.

With a system Node, this also works:

```bash
npm install -g github:jotspeed/jotspeed-cli
```

Password is stored in the OS keychain (libsecret on Linux, Keychain on macOS), not in a config file. The AES key is derived once at login and reused so each jot does not re-run PBKDF2.

If `jot` is not found, add `~/.local/bin` or `$(npm prefix -g)/bin` to your `PATH`.

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

## Agents

`jot mcp` is a local [MCP](https://modelcontextprotocol.io/) server. It uses the same sign-in as `jot login`. The encryption key stays in the OS keychain. The sync server never sees plaintext.

```bash
jot mcp
```

Tools: `post`, `search`, `get`, `status`. Post only when asked. The server cannot edit or delete.

Grok (`~/.grok/config.toml`):

```toml
[mcp_servers.jotspeed]
command = "jot"
args = ["mcp"]
```

OpenCode:

```json
{
  "mcp": {
    "servers": {
      "jotspeed": {
        "type": "local",
        "command": ["jot", "mcp"]
      }
    }
  }
}
```

## Security

- `~/.config/jotspeed/config.json` holds email, token, and sync URL only.
- Secrets live in the OS keychain under service `jotspeed`.
- A local cache under `~/.local/share/jotspeed/` is encrypted with the same AES-GCM key as the server blob.
- Lost password cannot be recovered by us. Use recovery codes from the app.

## License

[GPL-3.0-only](LICENSE). Copyright Hess Holdings.

This is original software. It is not a fork of other journal CLIs.

The Jotspeed **service** (app, sync, billing) is a separate commercial product. This repository is only the command-line client.
