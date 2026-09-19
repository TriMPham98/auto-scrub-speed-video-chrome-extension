#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const parts = String(manifest.version || "0.0.0")
  .split(".")
  .map((n) => {
    const v = Number(n);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  });
while (parts.length < 3) parts.push(0);
parts[parts.length - 1] += 1;
const next = parts.join(".");
manifest.version = next;
manifest.version_name = next;
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(next + "\n");
