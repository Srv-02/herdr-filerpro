// Crafted archives for the extract tests (not a test itself): a tiny ustar writer and a stored (uncompressed) zip
// writer, so member names like "../escape.txt", "/abs.txt" and symlink members can be built the same way on every OS,
// without the archive tools refusing to write them.
import zlib from "node:zlib";

// entries: [{ name, data?: string|Buffer, type?: "file"|"dir"|"symlink", target? }]
export function tarBuffer(entries) {
  const blocks = [];
  for (const e of entries) {
    const type = e.type ?? "file";
    const data = type === "file" ? Buffer.from(e.data ?? "") : Buffer.alloc(0);
    const h = Buffer.alloc(512);
    let name = e.name, prefix = "";
    if (Buffer.byteLength(name) > 100) { // ustar: split at a slash into prefix (155) and name (100)
      const i = name.lastIndexOf("/", name.length - 1 - 0);
      prefix = name.slice(0, i); name = name.slice(i + 1);
    }
    h.write(name, 0, 100, "utf8");
    h.write(type === "dir" ? "0000755\0" : type === "symlink" ? "0000777\0" : "0000644\0", 100, 8, "ascii");
    h.write("0000000\0", 108, 8, "ascii");
    h.write("0000000\0", 116, 8, "ascii");
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    h.write(`${Math.floor(Date.UTC(2026, 0, 1) / 1000).toString(8).padStart(11, "0")}\0`, 136, 12, "ascii");
    h.write("        ", 148, 8, "ascii");
    h.write(type === "dir" ? "5" : type === "symlink" ? "2" : "0", 156, 1, "ascii");
    if (type === "symlink") h.write(e.target, 157, 100, "utf8");
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    if (prefix) h.write(prefix, 345, 155, "utf8");
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

// entries as tarBuffer; a symlink is stored as a unix symlink (external attributes 0120777) with the target as data.
// encrypted: sets the encryption flag on every file entry (the data is not really encrypted; enough for unzip to ask
// for a password).
export function zipBuffer(entries, { encrypted = false } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const type = e.type ?? "file";
    const name = Buffer.from(type === "dir" && !e.name.endsWith("/") ? `${e.name}/` : e.name);
    const data = type === "file" ? Buffer.from(e.data ?? "") : type === "symlink" ? Buffer.from(e.target) : Buffer.alloc(0);
    const crc = zlib.crc32(data);
    const flags = encrypted && type === "file" ? 0x0801 : 0x0800; // bit 11: UTF-8 names
    const mode = type === "dir" ? 0o040755 : type === "symlink" ? 0o120777 : 0o100644;
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(flags), u16(0), u16(0), u16(0x5c21), u32(crc), u32(data.length), u32(data.length),
      u16(name.length), u16(0), name, data]);
    const central = Buffer.concat([u32(0x02014b50), u16(0x0314), u16(20), u16(flags), u16(0), u16(0), u16(0x5c21), u32(crc), u32(data.length),
      u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(mode * 0x10000), u32(offset), name]);
    locals.push(local); centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
  return Buffer.concat([...locals, cd, end]);
}
