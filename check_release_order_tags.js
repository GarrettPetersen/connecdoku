// Check that all prequels and sequels have release-order / internal-chronology tags.
//
// This script is intentionally read-only: it does NOT modify words.json.
// It just reports which entries are missing the new ordering categories so
// we can add them manually (or in a later script) in a consistent way.
//
// Usage:
//   node check_release_order_tags.js
//
// Output:
//   - Summary counts of how many prequels/sequels have / are missing:
//       * First/Second/etc in Release Order
//       * First/Second/etc in Internal Chronology
//   - A detailed list of titles missing each type of tag.

const fs = require("fs");
const path = require("path");

const WORDS_PATH = path.join(__dirname, "data", "words.json");

// These are the ordering tags we expect to use going forward.
// If we decide we need more positions later (Third, Fourth, etc.),
// just extend these arrays.
const RELEASE_ORDER_TAGS = [
  "First in Release Order",
  "Second in Release Order",
  "Third in Release Order",
  "Fourth in Release Order",
  "Fifth in Release Order",
];

const INTERNAL_CHRONOLOGY_TAGS = [
  "First in Internal Chronology",
  "Second in Internal Chronology",
  "Third in Internal Chronology",
  "Fourth in Internal Chronology",
  "Fifth in Internal Chronology",
];

function loadWords() {
  const raw = fs.readFileSync(WORDS_PATH, "utf8");
  return JSON.parse(raw);
}

function hasAny(tagList, candidates) {
  return tagList.some((t) => candidates.includes(t));
}

function main() {
  const words = loadWords();

  const prequelOrSequelEntries = [];

  for (const [word, tags] of Object.entries(words)) {
    if (!Array.isArray(tags)) continue;
    const isPrequelOrSequel =
      tags.includes("Prequels") || tags.includes("Sequels");
    if (!isPrequelOrSequel) continue;

    const hasReleaseOrder = hasAny(tags, RELEASE_ORDER_TAGS);
    const hasInternalOrder = hasAny(tags, INTERNAL_CHRONOLOGY_TAGS);

    prequelOrSequelEntries.push({
      word,
      tags,
      hasReleaseOrder,
      hasInternalOrder,
    });
  }

  const missingBoth = prequelOrSequelEntries.filter(
    (e) => !e.hasReleaseOrder && !e.hasInternalOrder
  );
  const missingReleaseOnly = prequelOrSequelEntries.filter(
    (e) => !e.hasReleaseOrder && e.hasInternalOrder
  );
  const missingInternalOnly = prequelOrSequelEntries.filter(
    (e) => e.hasReleaseOrder && !e.hasInternalOrder
  );
  const haveBoth = prequelOrSequelEntries.filter(
    (e) => e.hasReleaseOrder && e.hasInternalOrder
  );

  console.log("=== Prequel / Sequel Ordering Tag Check ===");
  console.log(
    `Total entries with Prequels/Sequels: ${prequelOrSequelEntries.length}`
  );
  console.log(`Have BOTH release + internal order tags: ${haveBoth.length}`);
  console.log(
    `Missing release-order tags (but have internal chronology): ${missingReleaseOnly.length}`
  );
  console.log(
    `Missing internal-chronology tags (but have release-order): ${missingInternalOnly.length}`
  );
  console.log(
    `Missing BOTH release + internal order tags: ${missingBoth.length}`
  );
  console.log();

  function printSection(title, list) {
    console.log(`== ${title} (${list.length}) ==`);
    list.forEach((e) => {
      console.log(`- ${e.word}`);
    });
    console.log();
  }

  printSection(
    "Missing BOTH First/Second/etc in Release Order AND Internal Chronology",
    missingBoth
  );

  printSection(
    "Have Internal Chronology tag(s) but MISSING Release Order tag(s)",
    missingReleaseOnly
  );

  printSection(
    "Have Release Order tag(s) but MISSING Internal Chronology tag(s)",
    missingInternalOnly
  );
}

if (require.main === module) {
  main();
}


