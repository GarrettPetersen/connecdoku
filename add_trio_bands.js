import fs from 'fs';

const WORDS = 'data/words.json';
const words = JSON.parse(fs.readFileSync(WORDS, 'utf8'));

function ensure(word, tags) {
  const set = new Set(words[word] || []);
  for (const t of tags) set.add(t);
  if (word.length >= 3){
    set.add(`Starts with ${word.slice(0,3).toUpperCase()}`);
    set.add(`Ends with ${word.slice(-3).toUpperCase()}`);
  }
  words[word] = Array.from(set);
}

// Add iconic trio bands
ensure('The Police', [
  '1970s',
  '1980s',
  '20th Century',
  'Bands',
  'Music',
  'Musicians',
  'Rock Bands',
  'Things British',
  'Trios'
]);

ensure('Rush', [
  '1970s',
  '1980s',
  '1990s',
  '20th Century',
  'Bands',
  'Music',
  'Musicians',
  'Rock Bands',
  'Things Canadian',
  'Trios'
]);

ensure('Cream', [
  '1960s',
  '20th Century',
  'Bands',
  'Music',
  'Musicians',
  'Rock Bands',
  'Things British',
  'Trios'
]);

ensure('Bee Gees', [
  '1960s',
  '1970s',
  '1980s',
  '20th Century',
  'Bands',
  'Disco',
  'Music',
  'Musicians',
  'Pop Bands',
  'Things British',
  'Trios'
]);

fs.writeFileSync(WORDS, JSON.stringify(words, null, 2));
console.log('Added trio bands with Bands and Trios tags.');
