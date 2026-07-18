"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scryptAsync = promisify(crypto.scrypt);
const SALT_LEN = 16;
const KEY_LEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * Hash a password with scrypt. Returns `scrypt$<salt_hex>$<hash_hex>`.
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scryptAsync(String(password), salt, KEY_LEN, SCRYPT_OPTS);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * Verify password against a stored scrypt hash.
 */
async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  if (!/^[a-f0-9]{32}$/i.test(parts[1]) || !/^[a-f0-9]{128}$/i.test(parts[2])) return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    const key = await scryptAsync(String(password), salt, KEY_LEN, SCRYPT_OPTS);
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/**
 * Generate a gateway API key: `rr-` + 32 hex chars.
 */
function generateApiKey() {
  return `rr-${crypto.randomBytes(16).toString("hex")}`;
}

/**
 * Generate a short unique id.
 */
function generateId(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateApiKey,
  generateId,
};
