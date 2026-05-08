#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Resvg } from "@resvg/resvg-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const START_DATE = new Date("2025-07-21T00:00:00");
const OUTPUT_PATH = path.join(__dirname, "social-preview.png");
const PUZZLES_PATH = path.join(__dirname, "daily_puzzles", "puzzles.json");
const FREDOKA_ONE_FONT_PATH = path.join(
  __dirname,
  "node_modules",
  "@fontsource",
  "fredoka-one",
  "files",
  "fredoka-one-all-400-normal.woff",
);

function todayIndex() {
  const now = new Date();
  const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startMidnight = new Date(
    START_DATE.getFullYear(),
    START_DATE.getMonth(),
    START_DATE.getDate(),
  );
  return Math.floor((localMidnight.getTime() - startMidnight.getTime()) / 864e5);
}

function escapeXml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function hash() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(seed) {
  let t = seed;
  return function rand() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(list, rng) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
}

function hashLine(line) {
  return [...line].sort().join("|");
}

function buildSpoilerSafeGrid(words, rng) {
  const rowHashes = new Set(words.map(hashLine));
  const colHashes = new Set(
    [0, 1, 2, 3].map((c) => hashLine([words[0][c], words[1][c], words[2][c], words[3][c]])),
  );

  const allWords = words.flat();
  const maxAttempts = 2000;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = [...allWords];
    shuffleInPlace(candidate, rng);

    const grid = Array.from({ length: 4 }, (_, r) => candidate.slice(r * 4, r * 4 + 4));

    let leaksSolution = false;
    for (let r = 0; r < 4 && !leaksSolution; r += 1) {
      if (rowHashes.has(hashLine(grid[r]))) leaksSolution = true;
    }
    for (let c = 0; c < 4 && !leaksSolution; c += 1) {
      const col = [grid[0][c], grid[1][c], grid[2][c], grid[3][c]];
      if (colHashes.has(hashLine(col))) leaksSolution = true;
    }
    if (!leaksSolution) return grid;
  }

  throw new Error("Could not build spoiler-safe shuffled grid.");
}

function wrapText(text, maxCharsPerLine, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines = [];
  let current = words[0];

  for (let i = 1; i < words.length; i += 1) {
    const next = `${current} ${words[i]}`;
    if (next.length <= maxCharsPerLine) {
      current = next;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);

  if (lines.length <= maxLines) return lines;

  const trimmed = lines.slice(0, maxLines);
  const last = trimmed[maxLines - 1];
  trimmed[maxLines - 1] = last.length > 1 ? `${last.slice(0, Math.max(1, last.length - 1))}…` : "…";
  return trimmed;
}

function tileTextSvg(text, x, y, w, h) {
  const len = text.length;
  const fontSize = len > 58 ? 13 : len > 46 ? 14 : len > 34 ? 15 : 16;
  const padX = 14;
  const padY = 8;
  const textWidth = Math.max(1, w - padX * 2);
  const textHeight = Math.max(1, h - padY * 2);
  const maxChars = Math.max(8, Math.floor(textWidth / (fontSize * 0.58)));
  const lines = wrapText(text, maxChars, 3);
  const lineHeight = Math.round(fontSize * 1.18);
  const totalHeight = lines.length * lineHeight;
  const startY = y + padY + (textHeight - totalHeight) / 2 + fontSize * 0.8;

  const tspans = lines
    .map(
      (line, i) =>
        `<tspan x="${x + w / 2}" y="${Math.round(startY + i * lineHeight)}">${escapeXml(line)}</tspan>`,
    )
    .join("");

  return `<text text-anchor="middle" fill="#222" font-size="${fontSize}" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">${tspans}</text>`;
}

function buildSvg({ puzzleNumber, shuffledGrid }) {
  const width = 1200;
  const height = 630;

  const shellX = 95;
  const shellY = 40;
  const shellWidth = 1010;
  const shellHeight = 550;

  const boardX = 140;
  const boardY = 170;
  const cellW = 170;
  const cellH = 72;
  const gap = 10;

  let content = "";

  for (let c = 0; c < 4; c += 1) {
    const x = boardX + c * (cellW + gap);
    const y = boardY;
    content += `<rect x="${x}" y="${y}" width="${cellW}" height="34" rx="12" fill="#fafafa" stroke="#d4d5d6" stroke-width="2"/>`;
    content += `<text x="${x + cellW / 2}" y="${y + 23}" text-anchor="middle" fill="#222" font-size="20" font-weight="700" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">↓</text>`;
  }

  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      const x = boardX + c * (cellW + gap);
      const y = boardY + 34 + gap + r * (cellH + gap);
      content += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="12" fill="#f6f7f8" stroke="#d4d5d6" stroke-width="2"/>`;
      content += tileTextSvg(shuffledGrid[r][c], x, y, cellW, cellH);
    }

    const headerX = boardX + 4 * (cellW + gap);
    const headerY = boardY + 34 + gap + r * (cellH + gap);
    content += `<rect x="${headerX}" y="${headerY}" width="${cellW}" height="${cellH}" rx="12" fill="#fafafa" stroke="#d4d5d6" stroke-width="2"/>`;
    content += `<text x="${headerX + cellW / 2}" y="${headerY + 45}" text-anchor="middle" fill="#222" font-size="22" font-weight="700" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">←</text>`;
  }

  const today = new Date();
  const dateLabel = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#fafafa"/>
  <rect x="${shellX}" y="${shellY}" width="${shellWidth}" height="${shellHeight}" rx="20" fill="#fafafa"/>
  <text x="600" y="110" text-anchor="middle" fill="#222" font-size="68" font-weight="400" font-family="'Fredoka One', system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">Connecdoku</text>
  <text x="600" y="148" text-anchor="middle" fill="#444" font-size="24" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">Daily Puzzle #${puzzleNumber}</text>
  <text x="600" y="564" text-anchor="middle" fill="#666" font-size="18" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">${escapeXml(
    `${dateLabel} • play at connecdoku.com`,
  )}</text>
  ${content}
</svg>`;
}

function main() {
  const puzzlesRaw = fs.readFileSync(PUZZLES_PATH, "utf8");
  const puzzles = JSON.parse(puzzlesRaw);
  if (!Array.isArray(puzzles) || puzzles.length === 0) {
    throw new Error("daily_puzzles/puzzles.json is empty or invalid.");
  }

  const idx = todayIndex();
  const puzzle = puzzles[((idx % puzzles.length) + puzzles.length) % puzzles.length];
  const puzzleNumber = idx + 1;

  const seedFactory = xmur3(`connecdoku-social-preview-${idx}`);
  const rng = mulberry32(seedFactory());
  const shuffledGrid = buildSpoilerSafeGrid(puzzle.words, rng);

  const svg = buildSvg({ puzzleNumber, shuffledGrid });
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [FREDOKA_ONE_FONT_PATH],
      loadSystemFonts: true,
    },
    fitTo: {
      mode: "width",
      value: 1200,
    },
  });
  const pngData = resvg.render().asPng();
  fs.writeFileSync(OUTPUT_PATH, pngData);

  console.log(`Wrote ${OUTPUT_PATH}`);
}

main();
