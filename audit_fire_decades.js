#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const WORDS_PATH = path.resolve('data/words.json');
const TARGET_CATEGORY = "Mentioned in We Didn't Start the Fire";

function isDecadeTag(category) {
  // Matches 1000s-2090s decades like 1950s, 2000s
  return /^(1\d{3}|20\d{2})s$/.test(category);
}

function main() {
  const raw = fs.readFileSync(WORDS_PATH, 'utf8');
  const words = JSON.parse(raw);

  const results = [];
  const decadeCounts = new Map();
  const missing = [];

  for (const [word, categories] of Object.entries(words)) {
    if (!Array.isArray(categories)) continue;
    if (!categories.includes(TARGET_CATEGORY)) continue;

    const decades = categories.filter(isDecadeTag).sort();
    results.push({ word, decades });

    if (decades.length === 0) {
      missing.push(word);
    } else {
      for (const d of decades) {
        decadeCounts.set(d, (decadeCounts.get(d) || 0) + 1);
      }
    }
  }

  results.sort((a, b) => a.word.localeCompare(b.word));

  console.log('Total mentioned items:', results.length);
  console.log('With at least one decade tag:', results.length - missing.length);
  console.log('Missing decade tags:', missing.length);

  if (missing.length > 0) {
    console.log('\nItems missing decade tags:');
    for (const w of missing.sort()) {
      console.log('-', w);
    }
  }

  console.log('\nCounts by decade:');
  const sortedDecades = Array.from(decadeCounts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [decade, count] of sortedDecades) {
    console.log(`${decade}: ${count}`);
  }

  console.log('\nDetailed list (word -> decades):');
  for (const { word, decades } of results) {
    console.log(`${word}: ${decades.join(', ') || '(none)'}`);
  }
}

main();


