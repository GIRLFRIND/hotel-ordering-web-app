"use strict";

const { promises: fs } = require("node:fs");
const path = require("node:path");
const { randomBytes, scryptSync } = require("node:crypto");

const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const adminFile = path.join(dataDirectory, "admin.json");

function readSecret(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return Promise.reject(new Error("Run this setup in an interactive terminal so the password can be entered without echoing."));
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Admin setup cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " " && character !== "\u007f") {
          value += character;
        }
      }
    };
    process.stdout.write(prompt);
    process.stdin.resume();
    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
  });
}

async function main() {
  const first = await readSecret("Choose an admin password (at least 12 characters): ");
  if (first.length < 12 || first.length > 200) throw new Error("Use a password between 12 and 200 characters.");
  const second = await readSecret("Enter it again: ");
  if (first !== second) throw new Error("Passwords do not match.");
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(first, salt, 64).toString("base64url");
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.writeFile(adminFile, JSON.stringify({ salt, hash }, null, 2), { mode: 0o600 });
  console.log("Admin password saved as a scrypt hash in the private data directory.");
  console.log("Open http://localhost:4173/admin.html to sign in. Never commit or share the data directory.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
