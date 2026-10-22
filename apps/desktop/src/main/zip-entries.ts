import { open } from "node:fs/promises";

// Loop 047 (checker B1, iteration-2 N-a): read a zip's own directory BEFORE anything unpacks it,
// and accept only the plain shape Ollama's build has, so the system unzip can't see anything this
// check didn't: one end record at the very end (no comment), a file list that fills exactly the
// space before it, stored or deflated entries with no flags beyond the harmless ones, names of
// plain printable ASCII that match byte for byte in both headers, and no extra fields except
// timestamps (an Info-ZIP Unicode-path or attribute field could hand the unzip a different name
// or file type). Read-only. No dependency.

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
// General-purpose flags we accept: bits 1–2 (deflate speed hints) and 11 (UTF-8 names). Anything
// else — encryption, a data descriptor (bit 3), patched data — is refused.
const OK_FLAGS = 0x0806;
const OK_METHODS = new Set([0, 8]); // stored, deflate
// Extra fields we accept: NTFS timestamps (0x000a) and extended timestamps (0x5455).
const OK_EXTRAS = new Set([0x000a, 0x5455]);

/** Why these extra-field bytes aren't just timestamps, or null. */
function badExtra(buf: Buffer): string | null {
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) return "a damaged extra field";
    const id = buf.readUInt16LE(i);
    const len = buf.readUInt16LE(i + 2);
    if (i + 4 + len > buf.length) return "a damaged extra field";
    if (!OK_EXTRAS.has(id)) return `an extra field we don't accept (0x${id.toString(16).padStart(4, "0")})`;
    i += 4 + len;
  }
  return null;
}

/** Why this zip can't be trusted to unpack, or its entries. */
export async function readZipEntries(zipPath: string): Promise<{ entries: ZipEntry[] } | { reason: string }> {
  const fh = await open(zipPath, "r");
  const read = async (pos: number, len: number): Promise<Buffer | null> => {
    const b = Buffer.alloc(len);
    const { bytesRead } = await fh.read(b, 0, len, pos);
    return bytesRead === len ? b : null;
  };
  try {
    const size = (await fh.stat()).size;
    if (size < 22) return { reason: "a damaged file list" };
    // Exactly one place for the end record: the last 22 bytes, with no comment after it.
    const eocdPos = size - 22;
    const e = await read(eocdPos, 22);
    if (!e || e.readUInt32LE(0) !== EOCD_SIG) return { reason: "a file list we don't read (a comment or a damaged end)" };
    const [disk, cdDisk, onDisk, count] = [e.readUInt16LE(4), e.readUInt16LE(6), e.readUInt16LE(8), e.readUInt16LE(10)];
    const cdSize = e.readUInt32LE(12);
    const cdOffset = e.readUInt32LE(16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return { reason: "a file list we don't read (zip64)" };
    if (disk !== 0 || cdDisk !== 0 || onDisk !== count || e.readUInt16LE(20) !== 0) return { reason: "a damaged file list" };
    // The file list must end exactly where the end record starts.
    if (count > MAX_ENTRIES || cdOffset + cdSize !== eocdPos) return { reason: "a damaged file list" };

    const cd = await read(cdOffset, cdSize);
    if (!cd) return { reason: "a damaged file list" };
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CDH_SIG) return { reason: "a damaged file list" };
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      const localOffset = cd.readUInt32LE(p + 42);
      const end = p + 46 + nameLen + extraLen + commentLen;
      if (end > cd.length) return { reason: "a damaged file list" };
      const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      p = end;

      // Plain printable ASCII only, so no two readers can decode a name differently.
      if (nameBytes.some((b) => b < 0x20 || b > 0x7e)) return { reason: "a file name with unusual characters" };
      const name = nameBytes.toString("latin1");
      if ((flags & ~OK_FLAGS) !== 0) return { reason: `a file stored in a way we don't accept (${name})` };
      if (!OK_METHODS.has(method)) return { reason: `a file packed in a way we don't accept (${name})` };
      const xc = badExtra(extra);
      if (xc) return { reason: `${xc} (${name})` };

      // The local header is what a streaming unzip reads: same name bytes, same flags and method,
      // and only timestamp extras.
      if (localOffset >= cdOffset) return { reason: `a damaged file list (${name})` };
      const lfh = await read(localOffset, 30);
      if (!lfh || lfh.readUInt32LE(0) !== LFH_SIG) return { reason: `a damaged file list (${name})` };
      const lNameLen = lfh.readUInt16LE(26);
      const lExtraLen = lfh.readUInt16LE(28);
      const lRest = await read(localOffset + 30, lNameLen + lExtraLen);
      if (!lRest || lNameLen !== nameLen || !lRest.subarray(0, lNameLen).equals(nameBytes)) {
        return { reason: `a file whose two names disagree (${name})` };
      }
      if (lfh.readUInt16LE(6) !== flags || lfh.readUInt16LE(8) !== method) return { reason: `a file whose two headers disagree (${name})` };
      const xl = badExtra(lRest.subarray(lNameLen));
      if (xl) return { reason: `${xl} (${name})` };

      entries.push({ name, unixType: (external >>> 16) & S_IFMT });
    }
    // Nothing hidden after the last entry.
    if (p !== cd.length) return { reason: "a damaged file list" };
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
