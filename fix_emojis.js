#!/usr/bin/env node

import fs from 'fs';

// Read the category emojis file
const emojiData = JSON.parse(fs.readFileSync('data/category_emojis.json', 'utf8'));

// Define thematic emojis for building categories
const thematicEmojis = {
    // Architecture categories
    "American Architecture": "🏛️",
    "Ancient Buildings": "🏺",
    "Australian Architecture": "🏗️",
    "Babylonian Architecture": "🏛️",
    "Brazilian Architecture": "🏗️",
    "British Architecture": "🏰",
    "Byzantine Architecture": "⛪",
    "Cambodian Architecture": "🏛️",
    "Chinese Architecture": "🏛️",
    "Egyptian Architecture": "🏺",
    "French Architecture": "🏗️",
    "Gothic Architecture": "⛪",
    "Greek Architecture": "🏛️",
    "Incan Architecture": "🏛️",
    "Islamic Architecture": "🕌",
    "Jordanian Architecture": "🏛️",
    "Mayan Architecture": "🏛️",
    "Medieval Buildings": "🏰",
    "Modern Buildings": "🏗️",
    "Mughal Architecture": "🏛️",
    "New Seven Wonders": "⭐",
    "Roman Architecture": "🏛️",
    "Seven Wonders": "⭐",
    "Spanish Architecture": "🏗️",
    "Tibetan Architecture": "🏛️",

    // Word pattern categories (keeping some generic but thematic)
    "Ends with CHU": "🔤",
    "Ends with HAL": "🔤",
    "Ends with HEL": "🔤",
    "Ends with IDS": "🔤",
    "Ends with MIS": "🔤",
    "Ends with TZA": "🔤",
    "Ends with WAT": "🔤",
    "Starts with ACR": "🔤",
    "Starts with ALH": "🔤",
    "Starts with EIF": "🔤",
    "Starts with POT": "🔤",
    "Starts with PYR": "🔤"
};

// Replace ☑️ with thematic emojis
let updated = 0;
for (const [category, emoji] of Object.entries(emojiData)) {
    if (emoji === "☑️") {
        if (thematicEmojis[category]) {
            emojiData[category] = thematicEmojis[category];
            updated++;
        } else {
            // For any other ☑️ that we didn't specifically map, use a generic building emoji
            emojiData[category] = "🏗️";
            updated++;
        }
    }
}

// Write the updated data back
fs.writeFileSync('data/category_emojis.json', JSON.stringify(emojiData, null, 2));

console.log(`Updated ${updated} emoji entries`);
console.log('Thematic emojis used:');
console.log('- 🏛️ for classical architecture (Greek, Roman, etc.)');
console.log('- 🏺 for ancient buildings');
console.log('- 🏰 for medieval buildings');
console.log('- 🏗️ for modern buildings');
console.log('- ⛪ for religious architecture');
console.log('- 🕌 for Islamic architecture');
console.log('- ⭐ for Seven Wonders');
console.log('- 🔤 for word pattern categories'); 