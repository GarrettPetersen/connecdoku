import fs from 'fs';

const filePath = './data/words.json';
const words = JSON.parse(fs.readFileSync(filePath, 'utf8'));

const updates = {
    "Gettysburg": ["19th Century", "Things American"],
    "The American Civil War": ["Things American"],
    "The American Revolution": ["Things American", "Things British"],
    "The Boer War": ["Things British", "Things South African"],
    "The Cold War": ["Things American", "Things Russian"], // Soviet not a common tag in this list likely, sticking to Russian
    "The Crimean War": ["Things British", "Things Russian"],
    "The English Civil War": ["Things British"],
    "The Franco-Prussian War": ["Things French", "Things German"],
    "The French Revolution": ["Things French"],
    "The Gulf War": ["Things American", "Things Iraqi"],
    "The Hundred Years War": ["Things British", "Things French"],
    "The Iraq War": ["Things American", "Things Iraqi"],
    "The Korean War": ["Things American", "Things Korean"],
    "The Napoleonic Wars": ["Things British", "Things French"],
    "The Russian Revolution": ["Things Russian"],
    "The Russo-Japanese War": ["Things Japanese", "Things Russian"],
    "The Seven Years' War": ["Things British", "Things French"],
    "The Spanish-American War": ["Things American", "Things Spanish"],
    "The Trojan War": ["Things Greek"],
    "The Vietnam War": ["Things American", "Things Vietnamese"],
    "The Yugoslav Wars": ["Things Serbian", "Things Croatian", "Things Bosnian"],
    "Total War": ["21st Century", "Things British"],
    "World War I": ["Things American", "Things British", "Things French", "Things German"],
    "World War II": ["Things American", "Things British", "Things German", "Things Japanese", "Things Russian"]
};

let changed = 0;

for (const [word, newTags] of Object.entries(updates)) {
    if (words[word]) {
        let entryChanged = false;
        for (const tag of newTags) {
            if (!words[word].includes(tag)) {
                words[word].push(tag);
                entryChanged = true;
            }
        }
        if (entryChanged) {
            words[word].sort();
            changed++;
        }
    } else {
        console.log(`Warning: ${word} not found in dictionary.`);
    }
}

if (changed > 0) {
    fs.writeFileSync(filePath, JSON.stringify(words, null, 2));
    console.log(`Updated ${changed} entries.`);
} else {
    console.log("No changes needed.");
}

