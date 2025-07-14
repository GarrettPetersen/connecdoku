const fs = require('fs');
const path = require('path');

// Read the words.json file
const wordsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'words.json'), 'utf8'));

// Create categories to words mapping
const categoriesToWords = {};

// Iterate through each word and its categories
for (const [word, categories] of Object.entries(wordsData)) {
  // For each category of this word
  for (const category of categories) {
    // Initialize the category array if it doesn't exist
    if (!categoriesToWords[category]) {
      categoriesToWords[category] = [];
    }
    // Add the word to this category
    categoriesToWords[category].push(word);
  }
}

// Sort categories alphabetically and words within each category
const sortedCategories = {};
Object.keys(categoriesToWords)
  .sort()
  .forEach(category => {
    sortedCategories[category] = categoriesToWords[category].sort();
  });

// Write the categories.json file
const outputPath = path.join(__dirname, 'data', 'categories.json');
fs.writeFileSync(outputPath, JSON.stringify(sortedCategories, null, 2), 'utf8');

console.log(`Generated categories.json with ${Object.keys(sortedCategories).length} categories`);
console.log(`Output file: ${outputPath}`);

// Print some statistics
console.log('\nCategory statistics:');
const categoryCounts = Object.entries(sortedCategories).map(([category, words]) => ({
  category,
  count: words.length
}));

categoryCounts
  .sort((a, b) => b.count - a.count)
  .slice(0, 10)
  .forEach(({ category, count }) => {
    console.log(`${category}: ${count} words`);
  }); 