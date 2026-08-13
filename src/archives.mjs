// Looking inside a .zip without unpacking it.
//
// A zipped ROM is common — one archive holding one game — and leaving every
// .zip unsorted because "an archive could be anything" is unhelpful when the
// archive plainly says what it holds. Reading the central directory gives the
// names of the files inside for the cost of two small reads, no decompression
// and no dependency.
//
// Only the *names* are read. Nothing is extracted, so a zipped disc image whose
// contents would need a header check stays unidentified, which is the honest
// answer rather than a guess.

import fs from 'node:fs';

// End Of Central Directory record: "PK\5\6". It is the last thing in the file,
// followed by a comment of up to 64 KB, so that is how far back to look.
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 0xffff;

// Central directory file header: "PK\1\2".
const CENTRAL_SIGNATURE = 0x02014b50;

// A guard against a malformed or hostile archive claiming a million entries.
const MAX_ENTRIES = 5000;

/**
 * The filenames inside a zip, without extracting anything.
 *
 * @param {string} absPath
 * @returns {string[]} entry names, or [] if this is not a readable zip
 */
export function zipEntryNames(absPath) {
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < EOCD_MIN_SIZE) return [];

    // 1. Find the end-of-central-directory record by scanning backwards.
    const tailLength = Math.min(size, EOCD_MIN_SIZE + MAX_COMMENT);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(fd, tail, 0, tailLength, size - tailLength);

    let eocd = -1;
    for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return [];

    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    // 0xffff/0xffffffff mean "see the ZIP64 record", which is not worth
    // supporting here: an archive with 65k entries is not one game.
    if (!count || count === 0xffff || dirOffset === 0xffffffff) return [];
    if (dirOffset + dirSize > size) return [];

    // 2. Read the central directory and walk its fixed-size headers.
    const dir = Buffer.alloc(dirSize);
    fs.readSync(fd, dir, 0, dirSize, dirOffset);

    const names = [];
    let at = 0;
    for (let i = 0; i < Math.min(count, MAX_ENTRIES); i++) {
      if (at + 46 > dir.length) break;
      if (dir.readUInt32LE(at) !== CENTRAL_SIGNATURE) break;
      const nameLength = dir.readUInt16LE(at + 28);
      const extraLength = dir.readUInt16LE(at + 30);
      const commentLength = dir.readUInt16LE(at + 32);
      const start = at + 46;
      if (start + nameLength > dir.length) break;
      names.push(dir.toString('utf8', start, start + nameLength));
      at = start + nameLength + extraLength + commentLength;
    }
    return names;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch { /* already gone */ }
    }
  }
}
