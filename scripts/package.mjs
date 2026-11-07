import { createReadStream } from "node:fs";
import { readdir, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "dist");
const outputFile = path.join(outputDir, "NEXARA-package.zip");
const excluded = new Set([".git", "node_modules", "dist", ".DS_Store"]);
const files = [];

async function walk(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute, relative);
    } else if (entry.isFile()) {
      files.push({ name: relative, data: await readFile(absolute) });
    }
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

await walk(root);
const webBuild = path.join(root, "apps", "web", "dist");
try {
  const info = await stat(webBuild);
  if (info.isDirectory()) await walk(webBuild, "browser");
} catch {
  throw new Error("Browser build missing. Run npm run build before packaging.");
}
files.sort((a, b) => a.name.localeCompare(b.name));
const local = [];
const central = [];
let offset = 0;
const stamp = dosDateTime();

for (const file of files) {
  const name = Buffer.from(file.name.replaceAll("\\", "/"), "utf8");
  const compressed = deflateRawSync(file.data, { level: 9 });
  const crc = crc32(file.data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(stamp.time, 10);
  header.writeUInt16LE(stamp.date, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(file.data.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  local.push(header, name, compressed);

  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(0x0800, 8);
  directory.writeUInt16LE(8, 10);
  directory.writeUInt16LE(stamp.time, 12);
  directory.writeUInt16LE(stamp.date, 14);
  directory.writeUInt32LE(crc, 16);
  directory.writeUInt32LE(compressed.length, 20);
  directory.writeUInt32LE(file.data.length, 24);
  directory.writeUInt16LE(name.length, 28);
  directory.writeUInt16LE(0, 30);
  directory.writeUInt16LE(0, 32);
  directory.writeUInt16LE(0, 34);
  directory.writeUInt16LE(0, 36);
  directory.writeUInt32LE(0, 38);
  directory.writeUInt32LE(offset, 42);
  central.push(directory, name);
  offset += header.length + name.length + compressed.length;
}

const centralSize = central.reduce((sum, part) => sum + part.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);
await mkdir(outputDir, { recursive: true });
await writeFile(outputFile, Buffer.concat([...local, ...central, end]));
console.log(`Created ${path.relative(root, outputFile)} with ${files.length} files.`);
