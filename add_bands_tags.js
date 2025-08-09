import fs from 'fs';

const WORDS = 'data/words.json';
const words = JSON.parse(fs.readFileSync(WORDS, 'utf8'));

const musicianBands = [
  'Boston',
  'Queen',
  'Zeppelin'
];

let changed = false;

function add(word, tag) {
  if (!words[word]) return;
  const set = new Set(words[word]);
  if (!set.has(tag)) {
    set.add(tag);
    words[word] = Array.from(set);
    changed = true;
  }
}

for (const band of musicianBands) {
  add(band, 'Bands');
}

// No explicit trios among these three; skip Trios

if (changed) {
  fs.writeFileSync(WORDS, JSON.stringify(words, null, 2));
  console.log('Added Bands tag to musician groups.');
} else {
  console.log('No changes needed.');
}
