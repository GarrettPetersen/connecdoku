/**
 * Adds category "Sieges" to military conflicts that are sieges or siege-centric.
 * Adds "Siege of Tenochtitlan" (land + naval: Spanish brigantines on Lake Texcoco).
 * Run: node scripts/add_sieges_category.mjs && node update_all_data.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wordsPath = path.join(__dirname, "..", "data", "words.json");

const S = "Sieges";
const MC = "Military Conflicts";

/** Explicit sieges / siege-defining episodes (not every MC entry). */
const siegeLemmas = new Set([
  "Battle of Alesia",
  "Battle of Dien Bien Phu",
  "Bar Kokhba Revolt",
  "Jingkang Incident",
  "The Battle of Stalingrad",
  "The Boxer Rebellion",
  "The Trojan War",
]);

const words = JSON.parse(fs.readFileSync(wordsPath, "utf8"));

let tagged = 0;
for (const [lemma, cats] of Object.entries(words)) {
  if (!cats.includes(MC)) continue;
  const isSiegeOf = lemma.startsWith("Siege of ");
  const explicit = siegeLemmas.has(lemma);
  if (!isSiegeOf && !explicit) continue;
  if (cats.includes(S)) continue;
  words[lemma] = [...cats, S].sort();
  tagged++;
}

const tenochtitlan = {
  "Siege of Tenochtitlan": [
    "1520s",
    "16th Century",
    "Battles",
    "Events",
    "Land Battles",
    "Military Conflicts",
    "Naval Battles",
    S,
    "Things Mexican",
    "Things Spanish",
  ],
};

if (words["Siege of Tenochtitlan"]) {
  const set = new Set([...words["Siege of Tenochtitlan"], ...tenochtitlan["Siege of Tenochtitlan"]]);
  words["Siege of Tenochtitlan"] = [...set].sort();
} else {
  words["Siege of Tenochtitlan"] = [...tenochtitlan["Siege of Tenochtitlan"]].sort();
}

const sorted = Object.keys(words)
  .sort((a, b) => a.localeCompare(b))
  .reduce((o, k) => {
    o[k] = words[k];
    return o;
  }, {});

fs.writeFileSync(wordsPath, JSON.stringify(sorted, null, 2), "utf8");
console.log(`Tagged ${tagged} existing Military Conflicts with "${S}".`);
console.log('Added/merged "Siege of Tenochtitlan".');
