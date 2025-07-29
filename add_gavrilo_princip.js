import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read existing words.json
const wordsPath = path.join(__dirname, 'data', 'words.json');
let wordsData = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));

// Gavrilo Princip assassination elements to add
const principElements = [
  {
    name: "Gavrilo Princip",
    categories: [
      "Assassination of Archduke Franz Ferdinand",
      "Assassins",
      "People",
      "Real People",
      "Things Serbian"
    ]
  },
  {
    name: "Archduke Franz Ferdinand",
    categories: [
      "Assassination of Archduke Franz Ferdinand",
      "National Leaders",
      "People",
      "Real People",
      "Royalty",
      "Things Austrian"
    ]
  },
  {
    name: "Sophie, Duchess of Hohenberg",
    categories: [
      "Assassination of Archduke Franz Ferdinand",
      "People",
      "Real People",
      "Royalty",
      "Things Austrian"
    ]
  },
  {
    name: "Sarajevo",
    categories: [
      "Assassination of Archduke Franz Ferdinand",
      "Cities",
      "Cities in Europe",
      "Locations in Europe",
      "Place Names",
      "Things Bosnian"
    ]
  },
  {
    name: "June 28th, 1914",
    categories: [
      "1910s",
      "20th Century",
      "Assassination of Archduke Franz Ferdinand",
      "Dates",
      "World War I"
    ]
  }
];

console.log('Adding Gavrilo Princip assassination elements to words.json...');

let addedCount = 0;
let updatedCount = 0;

for (const element of principElements) {
  if (wordsData[element.name]) {
    // Element already exists, add new categories
    const existingCategories = new Set(wordsData[element.name]);
    for (const category of element.categories) {
      existingCategories.add(category);
    }
    wordsData[element.name] = Array.from(existingCategories).sort();
    updatedCount++;
    console.log(`Updated existing element: ${element.name}`);
  } else {
    // Add new element
    wordsData[element.name] = element.categories.sort();
    addedCount++;
    console.log(`Added new element: ${element.name}`);
  }
}

// Write back to file
fs.writeFileSync(wordsPath, JSON.stringify(wordsData, null, 2));

console.log(`\nCompleted!`);
console.log(`- Added ${addedCount} new Gavrilo Princip assassination elements`);
console.log(`- Updated ${updatedCount} existing elements`);
console.log(`- Total elements processed: ${principElements.length}`); 