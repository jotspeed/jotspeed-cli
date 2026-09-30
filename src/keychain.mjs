import { spawnSync } from "node:child_process";

const SERVICE = "jotspeed";
const memory = new Map();

function which(cmd) {
  return spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
}

export function keychainBackend() {
  if (process.env.JOTSPEED_KEYCHAIN === "memory") return "memory";
  if (process.platform === "darwin" && which("security")) return "macos";
  if (which("secret-tool")) return "libsecret";
  return "none";
}

export function keychainAccount(email, kind = "password") {
  return kind === "password" ? email : `${email}:enc`;
}

export async function setSecret(account, value) {
  const b = keychainBackend();
  if (b === "memory") {
    memory.set(account, value);
    return;
  }
  if (b === "macos") {
    const r = spawnSync(
      "security",
      ["add-generic-password", "-U", "-a", account, "-s", SERVICE, "-w", value],
      { encoding: "utf8" }
    );
    if (r.status !== 0) throw new Error(r.stderr.trim() || "Couldn’t write macOS Keychain.");
    return;
  }
  if (b === "libsecret") {
    const r = spawnSync(
      "secret-tool",
      ["store", "--label", "Jotspeed", "service", SERVICE, "account", account],
      { input: value, encoding: "utf8" }
    );
    if (r.status !== 0) throw new Error(r.stderr.trim() || "Couldn’t write libsecret.");
    return;
  }
  throw new Error(
    "No OS keychain. On Linux install libsecret (secret-tool). On macOS use Keychain. Refusing to store a password in a file."
  );
}

export async function getSecret(account) {
  const b = keychainBackend();
  if (b === "memory") return memory.get(account) || null;
  if (b === "macos") {
    const r = spawnSync("security", ["find-generic-password", "-a", account, "-s", SERVICE, "-w"], { encoding: "utf8" });
    if (r.status !== 0) return null;
    return r.stdout.replace(/\n$/, "");
  }
  if (b === "libsecret") {
    const r = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", account], { encoding: "utf8" });
    if (r.status !== 0) return null;
    return r.stdout.replace(/\n$/, "");
  }
  return process.env.JOTSPEED_PASSWORD || null;
}

export async function deleteSecret(account) {
  const b = keychainBackend();
  if (b === "memory") {
    memory.delete(account);
    return;
  }
  if (b === "macos") {
    spawnSync("security", ["delete-generic-password", "-a", account, "-s", SERVICE], { encoding: "utf8" });
    return;
  }
  if (b === "libsecret") {
    spawnSync("secret-tool", ["clear", "service", SERVICE, "account", account], { encoding: "utf8" });
  }
}
