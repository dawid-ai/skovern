import { open } from "node:fs/promises";

// Loop 047 (checker B1): read a zip's own directory BEFORE anything unpacks it, so a link, an
// unsafe name, or a local header that disagrees with the directory is refused up front — the
// system unzip never gets a chance to write through a link. Read-only: the end record, the
// central directory, and each entry's local header. No dependency.

export interface ZipEntry {
  name: string;
  /** Unix file-type bits from the external attributes, when the zip carries them (else 0). */
  unixType: number;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const MAX_ENTRIES = 10_000;
const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/** Why this zip can't be trusted to unpack, or null with its entries. Rejects zip64, a missing
 *  or malformed directory, and local headers whose name differs from the directory's. */
export async function readZipEntries(zipPath: string): Promise<{ entries: ZipEntry[] } | { reason: string }> {
  const fh = await open(zipPath, "r");
  try {
    const size = (await fh.stat()).size;
    // The end record sits in the last 22 bytes + up to 64 KB of comment.
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return { reason: "a damaged file list" };
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return { reason: "a file list we don't read (zip64)" };
    if (count > MAX_ENTRIES || cdOffset + cdSize > size) return { reason: "a damaged file list" };

    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CDH_SIG) return { reason: "a damaged file list" };
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      p += 46 + nameLen + extraLen + commentLen;

      // The local header is what a streaming unzip reads — it must name the same file.
      const lfh = Buffer.alloc(30 + nameLen);
      await fh.read(lfh, 0, lfh.length, localOffset);
      if (lfh.readUInt32LE(0) !== LFH_SIG || lfh.readUInt16LE(26) !== nameLen || lfh.subarray(30).toString("utf8") !== name) {
        return { reason: `a file whose two names disagree (${name})` };
      }
      entries.push({ name, unixType: (external >>> 16) & S_IFMT });
    }
    return { entries };
  } finally {
    await fh.close();
  }
}

// Windows device names, which can't be real files: CON, PRN, AUX, NUL, COM1–9, LPT1–9 (any extension).
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why a zip entry name is unsafe to unpack, or null when it's fine. Pure. Rejects anything that
 *  could land outside the target dir or that Windows treats specially. */
export function unsafeEntryReason(name: string): string | null {
  if (name.length === 0) return "an empty file name";
  if (name.includes("\0")) return "a file name with a null byte";
  if (/^[A-Za-z]:/.test(name)) return `a drive letter path (${name})`;
  if (name.startsWith("/") || name.startsWith("\\")) return `an absolute path (${name})`;
  const segs = name.split(/[\\/]/).filter((s) => s.length > 0);
  if (segs.some((s) => s === "..")) return `a path that climbs out of its folder (${name})`;
  if (segs.some((s) => s.includes(":"))) return `a hidden file stream (${name})`;
  if (segs.some((s) => /[. ]$/.test(s) && s !== ".")) return `a name Windows would change (${name})`;
  if (segs.some((s) => DEVICE.test(s))) return `a device name (${name})`;
  return null;
}

/** The first reason this listing is unsafe — a bad name, or anything that isn't a plain file or
 *  folder (a link, a device) — or null. Pure. */
export function checkZipEntries(entries: ZipEntry[]): string | null {
  for (const e of entries) {
    const r = unsafeEntryReason(e.name);
    if (r) return r;
    if (e.unixType !== 0 && e.unixType !== S_IFREG && e.unixType !== S_IFDIR) return `a link or special file (${e.name})`;
  }
  return null;
}
