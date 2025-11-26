// CommonJS version of check_release_order_tags so it works with \"type\": \"module\".

const fs = require("fs");
const path = require("path");

const WORDS_PATH = path.join(__dirname, "data", "words.json");

const RELEASE_ORDER_TAGS = [
  "First in Release Order",
  "Second in Release Order",
  "Third in Release Order",
  "Fourth in Release Order",
  "Fifth in Release Order",
  "Sixth in Release Order",
  "Seventh in Release Order",
  "Eighth in Release Order",
  "Ninth in Release Order",
];

const INTERNAL_CHRONOLOGY_TAGS = [
  "First in Internal Chronology",
  "Second in Internal Chronology",
  "Third in Internal Chronology",
  "Fourth in Internal Chronology",
  "Fifth in Internal Chronology",
  "Sixth in Internal Chronology",
  "Seventh in Internal Chronology",
  "Eighth in Internal Chronology",
  "Ninth in Internal Chronology",
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
  const releaseOrderCounts = {};

  for (const [word, tags] of Object.entries(words)) {
    if (!Array.isArray(tags)) continue;

    // Track how many words (of ANY type) carry each specific release-order tag.
    for (const tag of tags) {
      if (RELEASE_ORDER_TAGS.includes(tag)) {
        releaseOrderCounts[tag] = (releaseOrderCounts[tag] || 0) + 1;
      }
    }

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

  // Global sanity check: every time we have any \"Second in Release Order\"
  // entries, we should have at least one \"First in Release Order\" somewhere
  // in the data set. This doesn't tell us *which* series is missing a first,
  // but it will catch obvious mistakes like adding only seconds.
  const firstCount = releaseOrderCounts["First in Release Order"] || 0;
  const secondCount = releaseOrderCounts["Second in Release Order"] || 0;
  if (secondCount > 0 && firstCount === 0) {
    console.warn(
      "WARNING: There are entries with 'Second in Release Order' but none with 'First in Release Order'."
    );
  }
  console.log("Release-order tag counts:");
  RELEASE_ORDER_TAGS.forEach((tag) => {
    if (releaseOrderCounts[tag]) {
      console.log(`- ${tag}: ${releaseOrderCounts[tag]}`);
    }
  });
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


