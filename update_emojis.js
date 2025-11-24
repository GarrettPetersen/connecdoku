import fs from 'fs';

const filePath = './data/category_emojis.json';
const emojis = JSON.parse(fs.readFileSync(filePath, 'utf8'));

const newEmojis = {
    "1440s": "📅",
    "1590s": "📅",
    "Campaigns": "⚔️"
};

let changed = false;
for (const [cat, emoji] of Object.entries(newEmojis)) {
    if (emojis[cat] !== emoji) {
        emojis[cat] = emoji;
        changed = true;
        console.log(`Set emoji for ${cat} to ${emoji}`);
    }
}

if (changed) {
    // Sort keys alphabetically
    const sortedEmojis = {};
    Object.keys(emojis).sort().forEach(key => {
        sortedEmojis[key] = emojis[key];
    });
    
    fs.writeFileSync(filePath, JSON.stringify(sortedEmojis, null, 2));
    console.log("Updated category_emojis.json");
} else {
    console.log("No changes needed for emojis.");
}

