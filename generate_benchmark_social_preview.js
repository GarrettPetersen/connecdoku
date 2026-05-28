#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Resvg } from "@resvg/resvg-js";
import { ensureFredokaFontPath } from "./social_preview_font.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_PATH = path.join(__dirname, "benchmark-social-preview.png");
const BENCHMARK_API_URL =
  process.env.BENCHMARK_API_URL || "https://connecdoku.com/api/v1/competition/benchmark";
const OFFICIAL_MODEL_ORDER = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3",
  "gpt-5.4-nano",
  "opus-4.8",
  "opus-4.7",
  "sonnet-4.6",
  "haiku-4.5",
  "gemini-3.5-flash",
  "grok-4.3",
  "kimi-k2.5",
  "kimi-k2.6",
  "composer-2",
  "composer-2.5",
];
const OFFICIAL_MODEL_SET = new Set(OFFICIAL_MODEL_ORDER);

function escapeXml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function safeAvg(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function scoreColor(score, minScore, maxScore) {
  const s = Number(score);
  if (!Number.isFinite(s)) return "#d1d5db";
  const lo = Number.isFinite(minScore) ? minScore : s;
  const hi = Number.isFinite(maxScore) ? maxScore : s;
  const span = Math.max(hi - lo, 0.0001);
  const t = Math.max(0, Math.min(1, (s - lo) / span));
  const start = { r: 198, g: 40, b: 40 };
  const mid = { r: 245, g: 194, b: 66 };
  const end = { r: 73, g: 179, b: 91 };
  const from = t < 0.5 ? start : mid;
  const to = t < 0.5 ? mid : end;
  const localT = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  const r = Math.round(from.r + (to.r - from.r) * localT);
  const g = Math.round(from.g + (to.g - from.g) * localT);
  const b = Math.round(from.b + (to.b - from.b) * localT);
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function computeScoreRows(leaderboard) {
  return (Array.isArray(leaderboard) ? leaderboard : [])
    .filter((row) => OFFICIAL_MODEL_SET.has(String(row.model || "")))
    .map((row) => {
      const avgStrikes = safeAvg(row.avg_strikes);
      const avgCorrect = safeAvg(row.avg_correct_guesses);
      if (avgStrikes === null || avgCorrect === null) return null;
      return {
        model: row.model,
        label: row.display_name || row.model,
        score: avgCorrect + (5 - avgStrikes),
        avgStrikes,
        avgCorrect,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return OFFICIAL_MODEL_ORDER.indexOf(a.model) - OFFICIAL_MODEL_ORDER.indexOf(b.model);
    });
}

function fmtDate(dateText) {
  if (!dateText) return null;
  const d = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function buildBars(rows) {
  if (!rows.length) {
    return `
      <rect x="96" y="206" width="1008" height="314" rx="22" fill="#f6f7f8" stroke="#d4d5d6" stroke-width="2"/>
      <text x="600" y="355" text-anchor="middle" fill="#6b7280" font-size="32" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">Benchmark data unavailable</text>
      <text x="600" y="395" text-anchor="middle" fill="#9ca3af" font-size="20" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">The build will still produce a valid share image.</text>
    `;
  }

  const topRows = rows.slice(0, 8);
  const minScore = Math.min(...topRows.map((row) => row.score));
  const maxScore = Math.max(...topRows.map((row) => row.score));
  const widthDenom = maxScore > 0 ? maxScore : 1;

  let svg = "";
  topRows.forEach((row, index) => {
    const y = 228 + index * 36;
    const trackX = 388;
    const trackY = y;
    const trackWidth = 596;
    const trackHeight = 24;
    const trackRadius = trackHeight / 2;
    const fillWidth = Math.max(trackHeight, Math.round((row.score / widthDenom) * trackWidth));
    svg += `<text x="118" y="${y + 17}" fill="#111827" font-size="20" font-weight="700" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">${escapeXml(row.label)}</text>`;
    svg += `<rect x="${trackX}" y="${trackY}" width="${trackWidth}" height="${trackHeight}" rx="${trackRadius}" fill="#f3f4f6" stroke="#e5e7eb" stroke-width="1"/>`;
    svg += buildCapsuleBar(trackX, trackY, fillWidth, trackHeight, scoreColor(row.score, minScore, maxScore));
    svg += `<text x="1028" y="${y + 17}" text-anchor="end" fill="#1f2937" font-size="20" font-weight="700" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">${row.score.toFixed(2)}</text>`;
  });
  return svg;
}

function buildCapsuleBar(x, y, width, height, fill) {
  const radius = height / 2;
  const minWidth = height;
  const actualWidth = Math.max(minWidth, width);
  const leftCx = x + radius;
  const cy = y + radius;
  const rightCx = x + actualWidth - radius;

  if (actualWidth <= height) {
    return `<circle cx="${x + actualWidth / 2}" cy="${cy}" r="${actualWidth / 2}" fill="${fill}"/>`;
  }

  const rectX = leftCx;
  const rectWidth = Math.max(0, actualWidth - height);

  return [
    `<circle cx="${leftCx}" cy="${cy}" r="${radius}" fill="${fill}"/>`,
    rectWidth > 0
      ? `<rect x="${rectX}" y="${y}" width="${rectWidth}" height="${height}" fill="${fill}"/>`
      : "",
    `<circle cx="${rightCx}" cy="${cy}" r="${radius}" fill="${fill}"/>`,
  ].join("");
}

function buildSvg({ scoreRows, latestDate, fetchedAt, fetchError }) {
  const subtitle = latestDate ? `Through ${latestDate}` : "Latest results";
  const footer = fetchError
    ? `Generated ${fetchedAt} • fallback image`
    : `Generated ${fetchedAt} • score = avg correct + (5 - avg strikes)`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f8fbf8"/>
      <stop offset="100%" stop-color="#eef7ef"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="60" y="42" width="1080" height="546" rx="28" fill="#ffffff" stroke="#d4d5d6" stroke-width="3"/>
  <text x="600" y="116" text-anchor="middle" fill="#222" font-size="66" font-weight="400" font-family="'Fredoka One', system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">Connecdoku</text>
  <text x="600" y="162" text-anchor="middle" fill="#222" font-size="34" font-weight="700" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">AI Models</text>
  <text x="600" y="194" text-anchor="middle" fill="#6b7280" font-size="22" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">${escapeXml(subtitle)}</text>
  <text x="118" y="210" fill="#4b5563" font-size="16" font-weight="700" letter-spacing="1.5" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">SCORE</text>
  ${buildBars(scoreRows)}
  <text x="600" y="556" text-anchor="middle" fill="#6b7280" font-size="18" font-family="system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">${escapeXml(footer)}</text>
</svg>`;
}

async function fetchBenchmarkData() {
  const response = await fetch(BENCHMARK_API_URL, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  if (!data || data.ok !== true) {
    throw new Error("Invalid benchmark API response");
  }
  return data;
}

async function main() {
  const fredokaFontPath = ensureFredokaFontPath();
  let scoreRows = [];
  let latestDate = null;
  let fetchError = null;

  try {
    const data = await fetchBenchmarkData();
    scoreRows = computeScoreRows(data.leaderboard);
    latestDate = fmtDate(Array.isArray(data.dates) && data.dates.length ? data.dates[0] : null);
  } catch (error) {
    fetchError = error instanceof Error ? error.message : String(error);
  }

  const fetchedAt = new Date().toISOString().slice(0, 10);
  const svg = buildSvg({ scoreRows, latestDate, fetchedAt, fetchError });
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: fredokaFontPath ? [fredokaFontPath] : [],
      loadSystemFonts: true,
    },
    fitTo: {
      mode: "width",
      value: 1200,
    },
  });
  const pngData = resvg.render().asPng();
  fs.writeFileSync(OUTPUT_PATH, pngData);

  if (fetchError) {
    console.log(`Wrote ${OUTPUT_PATH} with fallback content (${fetchError})`);
    return;
  }

  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
