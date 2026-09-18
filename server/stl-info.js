/**
 * STL inspection: triangle count and bounding box for binary and ASCII files.
 *
 * Everything works on the buffer in place — no slicing, no toString() of the
 * whole file — so a 250 MB upload costs one buffer, not three.
 */

const BINARY_HEADER = 80;
const BINARY_COUNT_FIELD = 4;
const BINARY_TRIANGLE = 50;
const BINARY_MIN = BINARY_HEADER + BINARY_COUNT_FIELD;

/** Window probed when guessing whether a file is ASCII. */
const PROBE_BYTES = 65536;

const KW_SOLID = keyword("solid");
const KW_VERTEX = keyword("vertex");
const KW_FACET = keyword("facet");

function keyword(text) {
  return Array.from(text, (c) => c.charCodeAt(0));
}

function isSpace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0b || byte === 0x0c;
}

/** Case-insensitive comparison of buffer[start, end) against a lowercase keyword. */
function isWord(buffer, start, end, word) {
  if (end - start !== word.length) return false;
  for (let i = 0; i < word.length; i++) {
    let b = buffer[start + i];
    if (b >= 0x41 && b <= 0x5a) b += 0x20; // fold A-Z to a-z
    if (b !== word[i]) return false;
  }
  return true;
}

function fail(message) {
  const err = new Error(message);
  err.publicMessage = message;
  err.status = 400;
  return err;
}

function newBox() {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    seen: false
  };
}

function addPoint(box, x, y, z) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  if (x < box.min[0]) box.min[0] = x;
  if (y < box.min[1]) box.min[1] = y;
  if (z < box.min[2]) box.min[2] = z;
  if (x > box.max[0]) box.max[0] = x;
  if (y > box.max[1]) box.max[1] = y;
  if (z > box.max[2]) box.max[2] = z;
  box.seen = true;
}

function finishBox(box) {
  if (!box.seen) throw fail("The STL file contains no valid coordinates.");
  return { min: box.min, max: box.max };
}

/**
 * Binary STLs frequently start with the word "solid" in their 80 byte header,
 * so the only reliable discriminator is whether the file size matches the
 * triangle count announced at offset 80.
 */
function binaryTriangleCount(buffer) {
  if (buffer.length < BINARY_MIN) return -1;
  const count = buffer.readUInt32LE(BINARY_HEADER);
  const expected = BINARY_MIN + BINARY_TRIANGLE * count;
  if (buffer.length === expected) return count;
  // Some exporters append padding; accept that, but never a shortfall.
  if (count > 0 && buffer.length > expected) return count;
  return -1;
}

function looksLikeAscii(buffer) {
  let i = 0;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) i = 3;
  while (i < buffer.length && isSpace(buffer[i])) i++;
  if (!isWord(buffer, i, i + KW_SOLID.length, KW_SOLID)) return false;
  // A view, not a copy: indexOf then searches at most the probe window.
  const probe = buffer.subarray(0, Math.min(buffer.length, PROBE_BYTES));
  return probe.indexOf("facet", 0, "latin1") !== -1 || probe.indexOf("endsolid", 0, "latin1") !== -1;
}

function parseBinary(buffer, count) {
  const box = newBox();
  for (let t = 0; t < count; t++) {
    // 12 bytes normal, then three vertices, then a 2 byte attribute field.
    let off = BINARY_MIN + t * BINARY_TRIANGLE + 12;
    for (let v = 0; v < 3; v++, off += 12) {
      addPoint(box, buffer.readFloatLE(off), buffer.readFloatLE(off + 4), buffer.readFloatLE(off + 8));
    }
  }
  return { format: "binary", triangles: count, bbox: finishBox(box) };
}

function parseAscii(buffer) {
  const box = newBox();
  const coord = [0, 0, 0];
  let triangles = 0;
  let pending = 0; // coordinates still expected for the vertex being read
  let i = 0;
  const n = buffer.length;

  while (i < n) {
    while (i < n && isSpace(buffer[i])) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !isSpace(buffer[i])) i++;

    if (pending > 0) {
      const value = Number(buffer.toString("latin1", start, i));
      if (!Number.isFinite(value)) {
        pending = 0; // malformed vertex line — drop it and resynchronise
        continue;
      }
      coord[3 - pending] = value;
      if (--pending === 0) addPoint(box, coord[0], coord[1], coord[2]);
      continue;
    }

    if (isWord(buffer, start, i, KW_VERTEX)) pending = 3;
    else if (isWord(buffer, start, i, KW_FACET)) triangles++;
  }

  if (triangles === 0) throw fail("The STL file contains no triangles.");
  return { format: "ascii", triangles, bbox: finishBox(box) };
}

/**
 * Reads triangle count and bounding box from an STL buffer.
 * @param {Buffer} buffer raw file contents
 * @returns {{format:"binary"|"ascii", triangles:number, bbox:{min:number[], max:number[]}}}
 * @throws {Error} with a user-facing `message`/`publicMessage` when the data is unreadable
 */
export function parseStl(buffer) {
  if (!Buffer.isBuffer(buffer)) throw fail("No STL data was provided.");
  if (buffer.length < 15) throw fail("The file is too small to be an STL file.");

  const count = binaryTriangleCount(buffer);
  if (count >= 0 && buffer.length === BINARY_MIN + BINARY_TRIANGLE * count) {
    if (count === 0) throw fail("The STL file contains no triangles.");
    return parseBinary(buffer, count);
  }
  if (looksLikeAscii(buffer)) return parseAscii(buffer);
  if (count > 0) return parseBinary(buffer, count);

  if (buffer.length >= BINARY_MIN) {
    const announced = buffer.readUInt32LE(BINARY_HEADER);
    if (announced > 0 && buffer.length < BINARY_MIN + BINARY_TRIANGLE * announced) {
      throw fail("The STL file is incomplete: it is shorter than its declared triangle count.");
    }
  }
  throw fail("The file could not be read as either a binary or an ASCII STL.");
}

export default { parseStl };
