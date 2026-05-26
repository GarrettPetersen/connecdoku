import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FREDOKA_ONE_WOFF_PATH = path.join(
  __dirname,
  "node_modules",
  "@fontsource",
  "fredoka-one",
  "files",
  "fredoka-one-latin-400-normal.woff",
);
const FREDOKA_ONE_TTF_PATH = path.join(__dirname, ".cache", "fredoka-one-latin-400-normal.ttf");

function pad4(value) {
  return (value + 3) & ~3;
}

function maxPowerOfTwoAtMost(n) {
  let value = 1;
  while (value * 2 <= n) value *= 2;
  return value;
}

function woffToSfnt(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "wOFF") {
    throw new Error("Expected a WOFF font file.");
  }

  const flavor = buffer.readUInt32BE(4);
  const numTables = buffer.readUInt16BE(12);
  const totalSfntSize = buffer.readUInt32BE(16);
  const recordOffset = 44;
  const tableRecords = [];

  for (let i = 0; i < numTables; i += 1) {
    const entryOffset = recordOffset + i * 20;
    const tag = buffer.toString("ascii", entryOffset, entryOffset + 4);
    tableRecords.push({
      tag,
      offset: buffer.readUInt32BE(entryOffset + 4),
      compLength: buffer.readUInt32BE(entryOffset + 8),
      origLength: buffer.readUInt32BE(entryOffset + 12),
      checksum: buffer.readUInt32BE(entryOffset + 16),
    });
  }

  tableRecords.sort((a, b) => a.tag.localeCompare(b.tag));

  const sfnt = Buffer.alloc(totalSfntSize);
  sfnt.writeUInt32BE(flavor, 0);
  sfnt.writeUInt16BE(numTables, 4);

  const maxPower = maxPowerOfTwoAtMost(numTables);
  const searchRange = maxPower * 16;
  const entrySelector = Math.log2(maxPower);
  const rangeShift = numTables * 16 - searchRange;

  sfnt.writeUInt16BE(searchRange, 6);
  sfnt.writeUInt16BE(entrySelector, 8);
  sfnt.writeUInt16BE(rangeShift, 10);

  let currentOffset = 12 + numTables * 16;

  tableRecords.forEach((record, index) => {
    const source = buffer.subarray(record.offset, record.offset + record.compLength);
    const tableData =
      record.compLength < record.origLength ? zlib.inflateSync(source) : Buffer.from(source);

    if (tableData.length !== record.origLength) {
      throw new Error(`WOFF table ${record.tag} expanded to ${tableData.length}, expected ${record.origLength}.`);
    }

    const dirOffset = 12 + index * 16;
    sfnt.write(record.tag, dirOffset, 4, "ascii");
    sfnt.writeUInt32BE(record.checksum >>> 0, dirOffset + 4);
    sfnt.writeUInt32BE(currentOffset, dirOffset + 8);
    sfnt.writeUInt32BE(record.origLength, dirOffset + 12);

    tableData.copy(sfnt, currentOffset);
    currentOffset += pad4(record.origLength);
  });

  return sfnt;
}

export function ensureFredokaFontPath() {
  const overridePath = process.env.FREDOKA_ONE_FONT_PATH;
  if (overridePath && fs.existsSync(overridePath)) {
    return overridePath;
  }
  if (fs.existsSync(FREDOKA_ONE_TTF_PATH)) {
    return FREDOKA_ONE_TTF_PATH;
  }
  if (!fs.existsSync(FREDOKA_ONE_WOFF_PATH)) {
    return null;
  }

  fs.mkdirSync(path.dirname(FREDOKA_ONE_TTF_PATH), { recursive: true });
  const woffBuffer = fs.readFileSync(FREDOKA_ONE_WOFF_PATH);
  const sfntBuffer = woffToSfnt(woffBuffer);
  fs.writeFileSync(FREDOKA_ONE_TTF_PATH, sfntBuffer);
  return FREDOKA_ONE_TTF_PATH;
}
