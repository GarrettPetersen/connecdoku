#!/usr/bin/env node
import crypto from "crypto";

function usage() {
  console.error("Usage: node scripts/competition_keygen.mjs <model> [length]");
  process.exit(1);
}

const model = process.argv[2];
const length = Number(process.argv[3] || 24);
if (!model) usage();
if (!Number.isInteger(length) || length < 12 || length > 128) {
  console.error("length must be an integer between 12 and 128");
  process.exit(1);
}

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
function randomPassword(n) {
  const bytes = crypto.randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const password = randomPassword(length);
console.log(JSON.stringify({ model, password }, null, 2));
