const fs = require('fs');
const path = require('path');

// Read the words.json file
const wordsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'words.json'), 'utf8'));

console.log('Adding "Ends with" and "Starts with" categories to words with 3+ letters...\n');

let updatedCount = 0;
let totalWords = 0;

for (const [word, categories] of Object.entries(wordsData)) {
  totalWords++;
  
  // Only process words with 3 or more letters
  if (word.length >= 3) {
    const startsWith = `Starts with ${word.substring(0, 3).toUpperCase()}`;
    const endsWith = `Ends with ${word.substring(word.length - 3).toUpperCase()}`;
    
    let updated = false;
    const newCategories = [...categories];
    
    // Add "Starts with" category if not already present
    if (!categories.includes(startsWith)) {
      newCategories.push(startsWith);
      updated = true;
    }
    
    // Add "Ends with" category if not already present
    if (!categories.includes(endsWith)) {
      newCategories.push(endsWith);
      updated = true;
    }
    
    // Update the word's categories if changes were made
    if (updated) {
      wordsData[word] = newCategories.sort();
      updatedCount++;
      console.log(`✓ ${word}: Added ${startsWith} and ${endsWith}`);
    }
  }
}

// Write the updated data back to the file
fs.writeFileSync(path.join(__dirname, 'data', 'words.json'), JSON.stringify(wordsData, null, 2), 'utf8');

console.log(`\nSummary:`);
console.log(`- Total words processed: ${totalWords}`);
console.log(`- Words updated: ${updatedCount}`);
console.log(`- Words with 3+ letters that already had both patterns: ${totalWords - updatedCount}`);

// Show some examples of the patterns
console.log(`\nExample patterns added:`);
const examples = Object.entries(wordsData).slice(0, 5);
examples.forEach(([word, categories]) => {
  const startsWith = categories.find(cat => cat.startsWith('Starts with'));
  const endsWith = categories.find(cat => cat.startsWith('Ends with'));
  if (startsWith && endsWith) {
    console.log(`- ${word}: ${startsWith}, ${endsWith}`);
  }
}); 