const fs = require('fs');

// Load the words data
const wordsData = JSON.parse(fs.readFileSync('data/words.json', 'utf8'));

// Extract all words
const words = Object.keys(wordsData);

// Extract all categories, excluding "starts with" and "ends with" categories
const categoriesSet = new Set();
for (const wordCategories of Object.values(wordsData)) {
    for (const category of wordCategories) {
        if (!category.startsWith('Starts with ') && !category.startsWith('Ends with ')) {
            categoriesSet.add(category);
        }
    }
}

// Convert to sorted arrays
const sortedWords = words.sort();
const sortedCategories = Array.from(categoriesSet).sort();

// Write words to file
fs.writeFileSync('words_list.txt', sortedWords.join('\n'));
console.log(`Wrote ${sortedWords.length} words to words_list.txt`);

// Write categories to file
fs.writeFileSync('categories_list.txt', sortedCategories.join('\n'));
console.log(`Wrote ${sortedCategories.length} categories to categories_list.txt`);

// Also write as JSON arrays
fs.writeFileSync('words_list.json', JSON.stringify(sortedWords, null, 2));
fs.writeFileSync('categories_list.json', JSON.stringify(sortedCategories, null, 2));

console.log('Files created:');
console.log('- words_list.txt (plain text, one word per line)');
console.log('- words_list.json (JSON array)');
console.log('- categories_list.txt (plain text, one category per line)');
console.log('- categories_list.json (JSON array)'); 