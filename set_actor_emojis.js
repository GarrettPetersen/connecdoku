import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const emojisPath = path.join(__dirname, 'data', 'category_emojis.json');

if (!fs.existsSync(emojisPath)) {
	console.error(`Emoji file not found: ${emojisPath}`);
	process.exit(1);
}

const data = JSON.parse(fs.readFileSync(emojisPath, 'utf8'));

// Use the male person emoji consistent with other male actor categories (e.g., Bruce Willis)
const target = [
	'Movies featuring Kirk Douglas',
	'Movies featuring Laurence Olivier',
	'Movies featuring Tony Curtis'
];

let updated = 0;
for (const key of target) {
	if (Object.prototype.hasOwnProperty.call(data, key)) {
		if (data[key] !== '👨🏻') {
			data[key] = '👨🏻';
			updated++;
		}
	}
}

fs.writeFileSync(emojisPath, JSON.stringify(data, null, 2), 'utf8');
console.log(`Updated ${updated} actor category emojis to 👨🏻`);

