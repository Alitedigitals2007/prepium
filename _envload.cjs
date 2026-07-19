require('dotenv').config();

// Backfill any missing env vars from a permissive parse of .env
// dotenv v17+ refuses to parse lines like "KEY = value" with spaces around '='.
// This loader reads the .env file directly and fills in the blanks.
const fs = require('fs');
const path = require('path');

function backfillEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  let raw;
  try { raw = fs.readFileSync(envPath, 'utf8'); }
  catch { raw = fs.readFileSync(envPath, 'utf16le'); }
  if (!raw) return;

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    // Strip inline comment (only outside quotes)
    if (value) {
      const m = value.match(/^(['"])(.*)\1$/);
      if (m) value = m[2];
    }
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

backfillEnv();
