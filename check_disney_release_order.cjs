#!/usr/bin/env node

// Find all entries with the "Disney" category that *do not* have any
// explicit series-order tags (e.g. "First in Release Order").
//
// Usage:
//   node check_disney_release_order.cjs

const fs = require("fs");
const path = require("path");

const WORDS_PATH = path.join(__dirname, "data", "words.json");

function loadWords() {
  const raw = fs.readFileSync(WORDS_PATH, "utf8");
  return JSON.parse(raw);
}

function hasSeriesOrderTag(categories) {
  return categories.some(
    (c) =>
      typeof c === "string" &&
      (c.includes(" in Release Order") ||
        c.includes(" in Internal Chronology"))
  );
}

function main() {
  const words = loadWords();

  const missing = Object.entries(words)
    .filter(([word, categories]) => {
      if (!Array.isArray(categories)) return false;
      const hasDisney = categories.includes("Disney");
      if (!hasDisney) return false;
      return !hasSeriesOrderTag(categories);
    })
    .map(([word]) => word)
    .sort((a, b) => a.localeCompare(b));

  if (missing.length === 0) {
    console.log("✅ All Disney entries have series-order tags.");
    return;
  }

  console.log(
    `Found ${missing.length} Disney entries with NO release/internal chronology tags:\n`
  );
  for (const word of missing) {
    console.log(`- ${word}`);
  }
}

main();


