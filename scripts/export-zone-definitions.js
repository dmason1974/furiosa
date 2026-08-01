#!/usr/bin/env node
"use strict";

// One-off admin script: dumps an event's imported zone data (`event_zone_definitions`,
// written by `/setup zones`) out to a JSON file shaped for zones_to_mapchart.py:
//   { "1": { "homeland": [...], "ai": [...] }, "2": { ... }, ... }
//
// Usage:
//   node scripts/export-zone-definitions.js <eventKey> [--test] [--out <path>]
//
// Reads DB connection info from .env (same vars as the bot itself). Not part
// of the running bot process -- exits when done.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const db = require("../src/db");

function parseArgs(argv) {
  const args = { eventKey: null, isTest: false, out: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--test") {
      args.isTest = true;
    } else if (a === "--out") {
      args.out = argv[++i];
    } else {
      rest.push(a);
    }
  }
  args.eventKey = rest[0] || null;
  return args;
}

async function main() {
  const { eventKey, isTest, out } = parseArgs(process.argv.slice(2));

  if (!eventKey) {
    console.error("Usage: node scripts/export-zone-definitions.js <eventKey> [--test] [--out <path>]");
    process.exitCode = 1;
    return;
  }

  const definitions = await db.getZoneDefinitions(eventKey, isTest);

  if (!definitions) {
    console.error(
      `No event_zone_definitions row for event_key="${eventKey}" in ${isTest ? "PGDATABASE_TEST" : "PGDATABASE_PROD"}.`
    );
    process.exitCode = 1;
    return;
  }

  const json = JSON.stringify(definitions.zones || {}, null, 2);

  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, json);
    console.error(`Wrote ${Object.keys(definitions.zones || {}).length} zones to ${out}`);
  } else {
    process.stdout.write(json + "\n");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    db.getPool(true).end();
    db.getPool(false).end();
  });
