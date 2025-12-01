#!/usr/bin/env node

// check_series_order_candidates.cjs
// Scan words.json for movies/books/video games that likely belong to a series
// but are missing "Nth in Release Order" / "Nth in Internal Chronology" tags.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const WORDS_F = path.join(DATA_DIR, "words.json");

const words = JSON.parse(fs.readFileSync(WORDS_F, "utf8"));

const NTH_RE = /\b(First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth) in (Release Order|Internal Chronology)\b/;

function hasSeriesOrderTag(cats) {
  return cats.some(c => NTH_RE.test(c));
}

function isMovieBookOrGame(cats) {
  if (!Array.isArray(cats)) return false;
  return (
    cats.includes("Movies") ||
    cats.includes("Books") ||
    cats.includes("Video Games") ||
    cats.includes("Action-Adventure Games") || // some games use this tag
    cats.includes("Board Games") ||
    cats.includes("Card Games")
  );
}

function baseKey(title) {
  return title
    .toLowerCase()
    .replace(/[’']/g, "")           // drop apostrophes
    .replace(/[:\-–—]/g, " ")       // normalize punctuation to space
    .replace(/\s+/g, " ")           // collapse whitespace
    .trim();
}

function stripSequenceSuffix(key) {
  // Remove common trailing sequence markers like "2", "3", "IV", "V", "Part II", etc.
  return key
    // "part ii", "episode 3", "chapter iv"
    .replace(/\s+(part|episode|chapter)\s+([ivx]+|\d+)$/i, "")
    // plain numeric or roman numeral suffix
    .replace(/\s+([ivx]+|\d+)$/i, "")
    .trim();
}

function looksNumberedOrPart(title) {
  const t = title.toLowerCase();
  // Trailing Arabic numeral, e.g. "Movie 2"
  if (/\s+\d+$/.test(t)) return true;
  // Trailing simple Roman numeral, e.g. "Film III"
  if (/\s+(ii|iii|iv|v|vi|vii|viii|ix|x)$/.test(t)) return true;
  // "Part II", "Episode 3", "Chapter IV", etc.
  if (/\b(part|episode|chapter)\s+(ii|iii|iv|v|vi|vii|viii|ix|x|\d+)\b/.test(t)) return true;
  return false;
}

function buildGroups() {
  const groups = new Map(); // baseKey -> [{ word, cats }]

  for (const [word, cats] of Object.entries(words)) {
    if (!isMovieBookOrGame(cats)) continue;
    const k = stripSequenceSuffix(baseKey(word));
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ word, cats });
  }

  // Keep only groups with at least 2 entries
  for (const [k, arr] of [...groups.entries()]) {
    if (arr.length < 2) groups.delete(k);
  }
  return groups;
}

const prequelSequelMissing = [];
for (const [word, cats] of Object.entries(words)) {
  if (!isMovieBookOrGame(cats)) continue;
  if (cats.includes("Prequels") || cats.includes("Sequels")) {
    if (!hasSeriesOrderTag(cats)) {
      prequelSequelMissing.push({ word, cats });
    }
  }
}

const groups = buildGroups();
const groupCandidates = [];
const numberedNoTags = [];
const unclassifiedGroups = [];

for (const [key, items] of groups.entries()) {
  const anyHasSeriesTag = items.some(it => hasSeriesOrderTag(it.cats));
  const anyHasPrequelSequel = items.some(
    it => it.cats.includes("Prequels") || it.cats.includes("Sequels")
  );
  const anyLooksNumbered = items.some(it => looksNumberedOrPart(it.word));

  // New: if the group looks like a numbered/part-style series but has
  // neither series-order tags nor prequel/sequel tags anywhere, surface
  // it separately as a strong candidate for manual review.
  if (!anyHasSeriesTag && !anyHasPrequelSequel && anyLooksNumbered) {
    numberedNoTags.push({ base: key, items: items.map(it => it.word) });
    continue;
  }

  // If nothing in the group looks like part of a series AND it's not numbered,
  // keep it separately for manual review (these are multi-title clusters where
  // we haven't done any explicit series tagging).
  if (!anyHasSeriesTag && !anyHasPrequelSequel && !anyLooksNumbered) {
    unclassifiedGroups.push({ base: key, items: items.map(it => it.word) });
    continue;
  }

  for (const it of items) {
    if (!hasSeriesOrderTag(it.cats)) {
      groupCandidates.push({ base: key, word: it.word, cats: it.cats });
    }
  }
}

console.log("=== Prequel/Sequel entries missing series-order tags ===");
prequelSequelMissing.forEach(entry => {
  console.log(`- ${entry.word}`);
});

console.log("\n=== Group-based candidates missing series-order tags ===");
let lastBase = null;
for (const entry of groupCandidates.sort((a, b) =>
  a.base === b.base ? a.word.localeCompare(b.word) : a.base.localeCompare(b.base)
)) {
  if (entry.base !== lastBase) {
    console.log(`\n[Base: ${entry.base}]`);
    lastBase = entry.base;
  }
  console.log(`- ${entry.word}`);
}

console.log("\n=== Numbered/part-style groups with no series-order or prequel/sequel tags ===");
for (const group of numberedNoTags.sort((a, b) => a.base.localeCompare(b.base))) {
  console.log(`\n[Base: ${group.base}]`);
  for (const w of group.items.sort()) {
    console.log(`- ${w}`);
  }
}

console.log("\n=== Multi-title groups with no series-order or prequel/sequel tags (non-numbered) ===");
for (const group of unclassifiedGroups.sort((a, b) => a.base.localeCompare(b.base))) {
  console.log(`\n[Base: ${group.base}]`);
  for (const w of group.items.sort()) {
    console.log(`- ${w}`);
  }
}


