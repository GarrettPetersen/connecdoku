import fs from 'fs';

const filePath = './data/category_emojis.json';
const emojis = JSON.parse(fs.readFileSync(filePath, 'utf8'));

if (emojis["1976"] !== "📅") {
    emojis["1976"] = "📅";
    
    // Sort keys alphabetically
    const sortedEmojis = {};
    Object.keys(emojis).sort().forEach(key => {
        sortedEmojis[key] = emojis[key];
    });
    
    fs.writeFileSync(filePath, JSON.stringify(sortedEmojis, null, 2));
    console.log("Updated category_emojis.json with 1976 emoji");
} else {
    console.log("No emoji update needed.");
}

