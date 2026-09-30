# Security

Report issues to support@jotspeed.com.

The CLI must never write the account password or AES key to `config.json`. Secrets go in the OS keychain. If no keychain is available, the CLI refuses to store credentials; set `JOTSPEED_PASSWORD` for a single process only.
