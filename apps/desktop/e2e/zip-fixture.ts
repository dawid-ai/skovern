// Test-only: build a small "stored" (uncompressed) zip in memory, so the helper set-up tests (047)
// can craft any entry — including hostile names and symlinks — the same way on Windows and Linux.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data?: string | Buffer;
  /** A Unix symlink whose target is `data`. */
  symlink?: boolean;
  /** A different name in the local header than in the file list (a smuggling trick). */
  localName?: string;
  /** Raw name bytes for both headers, overriding `name` (e.g. non-ASCII). */
  rawName?: Buffer;
  /** General-purpose flags in both headers (e.g. 0x0008, a data descriptor). */
  flags?: number;
  /** Extra-field bytes in the file list / the local header. */
  extra?: Buffer;
  localExtra?: Buffer;
}

/** One extra field: id, then its data. */
export function extraField(id: number, data: Buffer = Buffer.alloc(4)): Buffer {
  const h = Buffer.alloc(4);
  h.writeUInt16LE(id, 0);
  h.writeUInt16LE(data.length, 2);
  return Buffer.concat([h, data]);
}

export function makeZip(entries: ZipEntry[], opts: { comment?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = e.rawName ?? Buffer.from(e.name, "utf8");
    const localName = e.rawName ?? Buffer.from(e.localName ?? e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "", "utf8");
    const extra = e.extra ?? Buffer.alloc(0);
    const localExtra = e.localExtra ?? Buffer.alloc(0);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    locals.push(local, localName, localExtra, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.symlink ? 0x031e : 20, 4); // made by Unix (3) for a symlink
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.flags ?? 0, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    const mode = e.symlink ? 0o120777 : e.name.endsWith("/") ? 0o040755 : 0o100644;
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name, extra);
    offset += local.length + localName.length + localExtra.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = Buffer.from(opts.comment ?? "", "utf8");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, end, comment]);
}

/** A zip shaped like Ollama's Windows build: the executable at the root plus a lib folder. */
export function fakeOllamaZip(): Buffer {
  return makeZip([
    { name: "lib/" },
    { name: "lib/ollama/" },
    { name: "lib/ollama/ggml.dll", data: "not really a dll" },
    { name: process.platform === "win32" ? "ollama.exe" : "ollama", data: "not really ollama" },
  ]);
}
