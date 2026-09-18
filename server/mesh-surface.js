/**
 * Surface extraction from a voxel mask — stage 5 of the sealing pipeline in
 * CONTRACT.md section 8.
 *
 * This module knows nothing about how the mask was produced. It receives a
 * finished Uint8Array, runs marching cubes over it, optionally smooths the
 * result and writes a binary STL that FluidX3D voxelises with its normal code
 * path.
 *
 * Conventions
 * -----------
 * - The mask is read as a scalar field sampled at the CELL CENTRES, with the
 *   iso value 0.5. One marching cube therefore spans eight neighbouring cell
 *   centres, and its lower corner sits at cell (i, j, k).
 * - Cell (i, j, k) lives at `mask[i + nx * (j + ny * k)]` — x runs fastest,
 *   the same order FluidX3D uses for its own grids.
 * - Cubes are stepped from i = -1 to i = nx-1 (likewise j, k). Everything
 *   outside the mask counts as 0, so a body touching the grid border is still
 *   closed by a surface instead of leaking.
 * - Coordinates are metres in the caller's coordinate system:
 *   centre(i) = origin[0] + (i + 0.5) * cell.
 *
 * Memory: the mask is millions of cells, so nothing here allocates per cell.
 * The triangle buffer grows by doubling, vertex welding uses an open hash of
 * typed arrays, and adjacency is stored as CSR — no objects, no recursion.
 */

/** Iso value of the binary field: a cell is inside when its value is 1. */
const ISO = 0.5;

/** Corner offsets of the marching cube, in the classic Lorensen numbering. */
const CORNER_DX = [0, 1, 1, 0, 0, 1, 1, 0];
const CORNER_DY = [0, 0, 1, 1, 0, 0, 1, 1];
const CORNER_DZ = [0, 0, 0, 0, 1, 1, 1, 1];

/** The two corners each of the twelve cube edges connects. */
const EDGE_A = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3];
const EDGE_B = [1, 2, 3, 0, 5, 6, 7, 4, 4, 5, 6, 7];

/**
 * Standard marching cubes edge table: bit e is set when edge e is cut for the
 * given corner configuration. `MC_TRI_TABLE` is the authority — the test suite
 * checks that this table is exactly the set of edges the triangle table uses.
 */
export const MC_EDGE_TABLE = Int32Array.from([
  0x000, 0x109, 0x203, 0x30a, 0x406, 0x50f, 0x605, 0x70c,
  0x80c, 0x905, 0xa0f, 0xb06, 0xc0a, 0xd03, 0xe09, 0xf00,
  0x190, 0x099, 0x393, 0x29a, 0x596, 0x49f, 0x795, 0x69c,
  0x99c, 0x895, 0xb9f, 0xa96, 0xd9a, 0xc93, 0xf99, 0xe90,
  0x230, 0x339, 0x033, 0x13a, 0x636, 0x73f, 0x435, 0x53c,
  0xa3c, 0xb35, 0x83f, 0x936, 0xe3a, 0xf33, 0xc39, 0xd30,
  0x3a0, 0x2a9, 0x1a3, 0x0aa, 0x7a6, 0x6af, 0x5a5, 0x4ac,
  0xbac, 0xaa5, 0x9af, 0x8a6, 0xfaa, 0xea3, 0xda9, 0xca0,
  0x460, 0x569, 0x663, 0x76a, 0x066, 0x16f, 0x265, 0x36c,
  0xc6c, 0xd65, 0xe6f, 0xf66, 0x86a, 0x963, 0xa69, 0xb60,
  0x5f0, 0x4f9, 0x7f3, 0x6fa, 0x1f6, 0x0ff, 0x3f5, 0x2fc,
  0xdfc, 0xcf5, 0xfff, 0xef6, 0x9fa, 0x8f3, 0xbf9, 0xaf0,
  0x650, 0x759, 0x453, 0x55a, 0x256, 0x35f, 0x055, 0x15c,
  0xe5c, 0xf55, 0xc5f, 0xd56, 0xa5a, 0xb53, 0x859, 0x950,
  0x7c0, 0x6c9, 0x5c3, 0x4ca, 0x3c6, 0x2cf, 0x1c5, 0x0cc,
  0xfcc, 0xec5, 0xdcf, 0xcc6, 0xbca, 0xac3, 0x9c9, 0x8c0,
  0x8c0, 0x9c9, 0xac3, 0xbca, 0xcc6, 0xdcf, 0xec5, 0xfcc,
  0x0cc, 0x1c5, 0x2cf, 0x3c6, 0x4ca, 0x5c3, 0x6c9, 0x7c0,
  0x950, 0x859, 0xb53, 0xa5a, 0xd56, 0xc5f, 0xf55, 0xe5c,
  0x15c, 0x055, 0x35f, 0x256, 0x55a, 0x453, 0x759, 0x650,
  0xaf0, 0xbf9, 0x8f3, 0x9fa, 0xef6, 0xfff, 0xcf5, 0xdfc,
  0x2fc, 0x3f5, 0x0ff, 0x1f6, 0x6fa, 0x7f3, 0x4f9, 0x5f0,
  0xb60, 0xa69, 0x963, 0x86a, 0xf66, 0xe6f, 0xd65, 0xc6c,
  0x36c, 0x265, 0x16f, 0x066, 0x76a, 0x663, 0x569, 0x460,
  0xca0, 0xda9, 0xea3, 0xfaa, 0x8a6, 0x9af, 0xaa5, 0xbac,
  0x4ac, 0x5a5, 0x6af, 0x7a6, 0x0aa, 0x1a3, 0x2a9, 0x3a0,
  0xd30, 0xc39, 0xf33, 0xe3a, 0x936, 0x83f, 0xb35, 0xa3c,
  0x53c, 0x435, 0x73f, 0x636, 0x13a, 0x033, 0x339, 0x230,
  0xe90, 0xf99, 0xc93, 0xd9a, 0xa96, 0xb9f, 0x895, 0x99c,
  0x69c, 0x795, 0x49f, 0x596, 0x29a, 0x393, 0x099, 0x190,
  0xf00, 0xe09, 0xd03, 0xc0a, 0xb06, 0xa0f, 0x905, 0x80c,
  0x70c, 0x605, 0x50f, 0x406, 0x30a, 0x203, 0x109, 0x000
]);

/**
 * Standard marching cubes triangle table, written without the trailing -1
 * padding and expanded to 256 x 16 below. Every row lists edge numbers, three
 * per triangle, wound so that the normal points towards the corners whose bit
 * is set — the corners below the iso value. With the bit assignment used in
 * `surfaceFromMask` that is the air side, which is what makes the divergence
 * theorem give a positive volume.
 *
 * Ambiguous faces (two diagonally opposite corners of the same sign) are
 * always resolved by separating them. Both cubes sharing such a face use the
 * same rule, so the extracted surface stays closed.
 */
const TRI_ROWS = [
  [], [0, 8, 3], [0, 1, 9], [1, 8, 3, 9, 8, 1],
  [1, 2, 10], [0, 8, 3, 1, 2, 10], [9, 2, 10, 0, 2, 9], [2, 8, 3, 2, 10, 8, 10, 9, 8],
  [3, 11, 2], [0, 11, 2, 8, 11, 0], [1, 9, 0, 2, 3, 11], [1, 11, 2, 1, 9, 11, 9, 8, 11],
  [3, 10, 1, 11, 10, 3], [0, 10, 1, 0, 8, 10, 8, 11, 10], [3, 9, 0, 3, 11, 9, 11, 10, 9], [9, 8, 10, 10, 8, 11],
  [4, 7, 8], [4, 3, 0, 7, 3, 4], [0, 1, 9, 8, 4, 7], [4, 1, 9, 4, 7, 1, 7, 3, 1],
  [1, 2, 10, 8, 4, 7], [3, 4, 7, 3, 0, 4, 1, 2, 10], [9, 2, 10, 9, 0, 2, 8, 4, 7], [2, 10, 9, 2, 9, 7, 2, 7, 3, 7, 9, 4],
  [8, 4, 7, 3, 11, 2], [11, 4, 7, 11, 2, 4, 2, 0, 4], [9, 0, 1, 8, 4, 7, 2, 3, 11], [4, 7, 11, 9, 4, 11, 9, 11, 2, 9, 2, 1],
  [3, 10, 1, 3, 11, 10, 7, 8, 4], [1, 11, 10, 1, 4, 11, 1, 0, 4, 7, 11, 4], [4, 7, 8, 9, 0, 11, 9, 11, 10, 11, 0, 3], [4, 7, 11, 4, 11, 9, 9, 11, 10],
  [9, 5, 4], [9, 5, 4, 0, 8, 3], [0, 5, 4, 1, 5, 0], [8, 5, 4, 8, 3, 5, 3, 1, 5],
  [1, 2, 10, 9, 5, 4], [3, 0, 8, 1, 2, 10, 4, 9, 5], [5, 2, 10, 5, 4, 2, 4, 0, 2], [2, 10, 5, 3, 2, 5, 3, 5, 4, 3, 4, 8],
  [9, 5, 4, 2, 3, 11], [0, 11, 2, 0, 8, 11, 4, 9, 5], [0, 5, 4, 0, 1, 5, 2, 3, 11], [2, 1, 5, 2, 5, 8, 2, 8, 11, 4, 8, 5],
  [10, 3, 11, 10, 1, 3, 9, 5, 4], [4, 9, 5, 0, 8, 1, 8, 10, 1, 8, 11, 10], [5, 4, 0, 5, 0, 11, 5, 11, 10, 11, 0, 3], [5, 4, 8, 5, 8, 10, 10, 8, 11],
  [9, 7, 8, 5, 7, 9], [9, 3, 0, 9, 5, 3, 5, 7, 3], [0, 7, 8, 0, 1, 7, 1, 5, 7], [1, 5, 3, 3, 5, 7],
  [9, 7, 8, 9, 5, 7, 10, 1, 2], [10, 1, 2, 9, 5, 0, 5, 3, 0, 5, 7, 3], [8, 0, 2, 8, 2, 5, 8, 5, 7, 10, 5, 2], [2, 10, 5, 2, 5, 3, 3, 5, 7],
  [7, 9, 5, 7, 8, 9, 3, 11, 2], [9, 5, 7, 9, 7, 2, 9, 2, 0, 2, 7, 11], [2, 3, 11, 0, 1, 8, 1, 7, 8, 1, 5, 7], [11, 2, 1, 11, 1, 7, 7, 1, 5],
  [9, 5, 8, 8, 5, 7, 10, 1, 3, 10, 3, 11], [5, 7, 0, 5, 0, 9, 7, 11, 0, 1, 0, 10, 11, 10, 0], [11, 10, 0, 11, 0, 3, 10, 5, 0, 8, 0, 7, 5, 7, 0], [11, 10, 5, 7, 11, 5],
  [10, 6, 5], [0, 8, 3, 5, 10, 6], [9, 0, 1, 5, 10, 6], [1, 8, 3, 1, 9, 8, 5, 10, 6],
  [1, 6, 5, 2, 6, 1], [1, 6, 5, 1, 2, 6, 3, 0, 8], [9, 6, 5, 9, 0, 6, 0, 2, 6], [5, 9, 8, 5, 8, 2, 5, 2, 6, 3, 2, 8],
  [2, 3, 11, 10, 6, 5], [11, 0, 8, 11, 2, 0, 10, 6, 5], [0, 1, 9, 2, 3, 11, 5, 10, 6], [5, 10, 6, 1, 9, 2, 9, 11, 2, 9, 8, 11],
  [6, 3, 11, 6, 5, 3, 5, 1, 3], [0, 8, 11, 0, 11, 5, 0, 5, 1, 5, 11, 6], [3, 11, 6, 0, 3, 6, 0, 6, 5, 0, 5, 9], [6, 5, 9, 6, 9, 11, 11, 9, 8],
  [5, 10, 6, 4, 7, 8], [4, 3, 0, 4, 7, 3, 6, 5, 10], [1, 9, 0, 5, 10, 6, 8, 4, 7], [10, 6, 5, 1, 9, 7, 1, 7, 3, 7, 9, 4],
  [6, 1, 2, 6, 5, 1, 4, 7, 8], [1, 2, 5, 5, 2, 6, 3, 0, 4, 3, 4, 7], [8, 4, 7, 9, 0, 5, 0, 6, 5, 0, 2, 6], [7, 3, 9, 7, 9, 4, 3, 2, 9, 5, 9, 6, 2, 6, 9],
  [3, 11, 2, 7, 8, 4, 10, 6, 5], [5, 10, 6, 4, 7, 2, 4, 2, 0, 2, 7, 11], [0, 1, 9, 4, 7, 8, 2, 3, 11, 5, 10, 6], [9, 2, 1, 9, 11, 2, 9, 4, 11, 7, 11, 4, 5, 10, 6],
  [8, 4, 7, 3, 11, 5, 3, 5, 1, 5, 11, 6], [5, 1, 11, 5, 11, 6, 1, 0, 11, 7, 11, 4, 0, 4, 11], [0, 5, 9, 0, 6, 5, 0, 3, 6, 11, 6, 3, 8, 4, 7], [6, 5, 9, 6, 9, 11, 4, 7, 9, 7, 11, 9],
  [10, 4, 9, 6, 4, 10], [4, 10, 6, 4, 9, 10, 0, 8, 3], [10, 0, 1, 10, 6, 0, 6, 4, 0], [8, 3, 1, 8, 1, 6, 8, 6, 4, 6, 1, 10],
  [1, 4, 9, 1, 2, 4, 2, 6, 4], [3, 0, 8, 1, 2, 9, 2, 4, 9, 2, 6, 4], [0, 2, 4, 4, 2, 6], [8, 3, 2, 8, 2, 4, 4, 2, 6],
  [10, 4, 9, 10, 6, 4, 11, 2, 3], [0, 8, 2, 2, 8, 11, 4, 9, 10, 4, 10, 6], [3, 11, 2, 0, 1, 6, 0, 6, 4, 6, 1, 10], [6, 4, 1, 6, 1, 10, 4, 8, 1, 2, 1, 11, 8, 11, 1],
  [9, 6, 4, 9, 3, 6, 9, 1, 3, 11, 6, 3], [8, 11, 1, 8, 1, 0, 11, 6, 1, 9, 1, 4, 6, 4, 1], [3, 11, 6, 3, 6, 0, 0, 6, 4], [6, 4, 8, 11, 6, 8],
  [7, 10, 6, 7, 8, 10, 8, 9, 10], [0, 7, 3, 0, 10, 7, 0, 9, 10, 6, 7, 10], [10, 6, 7, 1, 10, 7, 1, 7, 8, 1, 8, 0], [10, 6, 7, 10, 7, 1, 1, 7, 3],
  [1, 2, 6, 1, 6, 8, 1, 8, 9, 8, 6, 7], [2, 6, 9, 2, 9, 1, 6, 7, 9, 0, 9, 3, 7, 3, 9], [7, 8, 0, 7, 0, 6, 6, 0, 2], [7, 3, 2, 6, 7, 2],
  [2, 3, 11, 10, 6, 8, 10, 8, 9, 8, 6, 7], [2, 0, 7, 2, 7, 11, 0, 9, 7, 6, 7, 10, 9, 10, 7], [1, 8, 0, 1, 7, 8, 1, 10, 7, 6, 7, 10, 2, 3, 11], [11, 2, 1, 11, 1, 7, 10, 6, 1, 6, 7, 1],
  [8, 9, 6, 8, 6, 7, 9, 1, 6, 11, 6, 3, 1, 3, 6], [0, 9, 1, 11, 6, 7], [7, 8, 0, 7, 0, 6, 3, 11, 0, 11, 6, 0], [7, 11, 6],
  [7, 6, 11], [3, 0, 8, 11, 7, 6], [0, 1, 9, 11, 7, 6], [8, 1, 9, 8, 3, 1, 11, 7, 6],
  [10, 1, 2, 6, 11, 7], [1, 2, 10, 3, 0, 8, 6, 11, 7], [2, 9, 0, 2, 10, 9, 6, 11, 7], [6, 11, 7, 2, 10, 3, 10, 8, 3, 10, 9, 8],
  [7, 2, 3, 6, 2, 7], [7, 0, 8, 7, 6, 0, 6, 2, 0], [2, 7, 6, 2, 3, 7, 0, 1, 9], [1, 6, 2, 1, 8, 6, 1, 9, 8, 8, 7, 6],
  [10, 7, 6, 10, 1, 7, 1, 3, 7], [10, 7, 6, 1, 7, 10, 1, 8, 7, 1, 0, 8], [0, 3, 7, 0, 7, 10, 0, 10, 9, 6, 10, 7], [7, 6, 10, 7, 10, 8, 8, 10, 9],
  [6, 8, 4, 11, 8, 6], [3, 6, 11, 3, 0, 6, 0, 4, 6], [8, 6, 11, 8, 4, 6, 9, 0, 1], [9, 4, 6, 9, 6, 3, 9, 3, 1, 11, 3, 6],
  [6, 8, 4, 6, 11, 8, 2, 10, 1], [1, 2, 10, 3, 0, 11, 0, 6, 11, 0, 4, 6], [4, 11, 8, 4, 6, 11, 0, 2, 9, 2, 10, 9], [10, 9, 3, 10, 3, 2, 9, 4, 3, 11, 3, 6, 4, 6, 3],
  [8, 2, 3, 8, 4, 2, 4, 6, 2], [0, 4, 2, 4, 6, 2], [1, 9, 0, 2, 3, 4, 2, 4, 6, 4, 3, 8], [1, 9, 4, 1, 4, 2, 2, 4, 6],
  [8, 1, 3, 8, 6, 1, 8, 4, 6, 6, 10, 1], [10, 1, 0, 10, 0, 6, 6, 0, 4], [4, 6, 3, 4, 3, 8, 6, 10, 3, 0, 3, 9, 10, 9, 3], [10, 9, 4, 6, 10, 4],
  [4, 9, 5, 7, 6, 11], [0, 8, 3, 4, 9, 5, 11, 7, 6], [5, 0, 1, 5, 4, 0, 7, 6, 11], [11, 7, 6, 8, 3, 4, 3, 5, 4, 3, 1, 5],
  [9, 5, 4, 10, 1, 2, 7, 6, 11], [6, 11, 7, 1, 2, 10, 0, 8, 3, 4, 9, 5], [7, 6, 11, 5, 4, 10, 4, 2, 10, 4, 0, 2], [3, 4, 8, 3, 5, 4, 3, 2, 5, 10, 5, 2, 11, 7, 6],
  [7, 2, 3, 7, 6, 2, 5, 4, 9], [9, 5, 4, 0, 8, 6, 0, 6, 2, 6, 8, 7], [3, 6, 2, 3, 7, 6, 1, 5, 0, 5, 4, 0], [6, 2, 8, 6, 8, 7, 2, 1, 8, 4, 8, 5, 1, 5, 8],
  [9, 5, 4, 10, 1, 6, 1, 7, 6, 1, 3, 7], [1, 6, 10, 1, 7, 6, 1, 0, 7, 8, 7, 0, 9, 5, 4], [4, 0, 10, 4, 10, 5, 0, 3, 10, 6, 10, 7, 3, 7, 10], [7, 6, 10, 7, 10, 8, 5, 4, 10, 4, 8, 10],
  [6, 9, 5, 6, 11, 9, 11, 8, 9], [3, 6, 11, 0, 6, 3, 0, 5, 6, 0, 9, 5], [0, 11, 8, 0, 5, 11, 0, 1, 5, 5, 6, 11], [6, 11, 3, 6, 3, 5, 5, 3, 1],
  [1, 2, 10, 9, 5, 11, 9, 11, 8, 11, 5, 6], [0, 11, 3, 0, 6, 11, 0, 9, 6, 5, 6, 9, 1, 2, 10], [11, 8, 5, 11, 5, 6, 8, 0, 5, 10, 5, 2, 0, 2, 5], [6, 11, 3, 6, 3, 5, 2, 10, 3, 10, 5, 3],
  [5, 8, 9, 5, 2, 8, 5, 6, 2, 3, 8, 2], [9, 5, 6, 9, 6, 0, 0, 6, 2], [1, 5, 8, 1, 8, 0, 5, 6, 8, 3, 8, 2, 6, 2, 8], [1, 5, 6, 2, 1, 6],
  [1, 3, 6, 1, 6, 10, 3, 8, 6, 5, 6, 9, 8, 9, 6], [10, 1, 0, 10, 0, 6, 9, 5, 0, 5, 6, 0], [0, 3, 8, 5, 6, 10], [10, 5, 6],
  [11, 5, 10, 7, 5, 11], [11, 5, 10, 11, 7, 5, 8, 3, 0], [5, 11, 7, 5, 10, 11, 1, 9, 0], [10, 7, 5, 10, 11, 7, 9, 8, 1, 8, 3, 1],
  [11, 1, 2, 11, 7, 1, 7, 5, 1], [0, 8, 3, 1, 2, 7, 1, 7, 5, 7, 2, 11], [9, 7, 5, 9, 2, 7, 9, 0, 2, 2, 11, 7], [7, 5, 2, 7, 2, 11, 5, 9, 2, 3, 2, 8, 9, 8, 2],
  [2, 5, 10, 2, 3, 5, 3, 7, 5], [8, 2, 0, 8, 5, 2, 8, 7, 5, 10, 2, 5], [9, 0, 1, 5, 10, 3, 5, 3, 7, 3, 10, 2], [9, 8, 2, 9, 2, 1, 8, 7, 2, 10, 2, 5, 7, 5, 2],
  [1, 3, 5, 3, 7, 5], [0, 8, 7, 0, 7, 1, 1, 7, 5], [9, 0, 3, 9, 3, 5, 5, 3, 7], [9, 8, 7, 5, 9, 7],
  [5, 8, 4, 5, 10, 8, 10, 11, 8], [5, 0, 4, 5, 11, 0, 5, 10, 11, 11, 3, 0], [0, 1, 9, 8, 4, 10, 8, 10, 11, 10, 4, 5], [10, 11, 4, 10, 4, 5, 11, 3, 4, 9, 4, 1, 3, 1, 4],
  [2, 5, 1, 2, 8, 5, 2, 11, 8, 4, 5, 8], [0, 4, 11, 0, 11, 3, 4, 5, 11, 2, 11, 1, 5, 1, 11], [0, 2, 5, 0, 5, 9, 2, 11, 5, 4, 5, 8, 11, 8, 5], [9, 4, 5, 2, 11, 3],
  [2, 5, 10, 3, 5, 2, 3, 4, 5, 3, 8, 4], [5, 10, 2, 5, 2, 4, 4, 2, 0], [3, 10, 2, 3, 5, 10, 3, 8, 5, 4, 5, 8, 0, 1, 9], [5, 10, 2, 5, 2, 4, 1, 9, 2, 9, 4, 2],
  [8, 4, 5, 8, 5, 3, 3, 5, 1], [0, 4, 5, 1, 0, 5], [8, 4, 5, 8, 5, 3, 9, 0, 5, 0, 3, 5], [9, 4, 5],
  [4, 11, 7, 4, 9, 11, 9, 10, 11], [0, 8, 3, 4, 9, 7, 9, 11, 7, 9, 10, 11], [1, 10, 11, 1, 11, 4, 1, 4, 0, 7, 4, 11], [3, 1, 4, 3, 4, 8, 1, 10, 4, 7, 4, 11, 10, 11, 4],
  [4, 11, 7, 9, 11, 4, 9, 2, 11, 9, 1, 2], [9, 7, 4, 9, 11, 7, 9, 1, 11, 2, 11, 1, 0, 8, 3], [11, 7, 4, 11, 4, 2, 2, 4, 0], [11, 7, 4, 11, 4, 2, 8, 3, 4, 3, 2, 4],
  [2, 9, 10, 2, 7, 9, 2, 3, 7, 7, 4, 9], [9, 10, 7, 9, 7, 4, 10, 2, 7, 8, 7, 0, 2, 0, 7], [3, 7, 10, 3, 10, 2, 7, 4, 10, 1, 10, 0, 4, 0, 10], [1, 10, 2, 8, 7, 4],
  [4, 9, 1, 4, 1, 7, 7, 1, 3], [4, 9, 1, 4, 1, 7, 0, 8, 1, 8, 7, 1], [4, 0, 3, 7, 4, 3], [4, 8, 7],
  [9, 10, 8, 10, 11, 8], [3, 0, 9, 3, 9, 11, 11, 9, 10], [0, 1, 10, 0, 10, 8, 8, 10, 11], [3, 1, 10, 11, 3, 10],
  [1, 2, 11, 1, 11, 9, 9, 11, 8], [3, 0, 9, 3, 9, 11, 1, 2, 9, 2, 11, 9], [0, 2, 11, 8, 0, 11], [3, 2, 11],
  [2, 3, 8, 2, 8, 10, 10, 8, 9], [9, 10, 2, 0, 9, 2], [2, 3, 8, 2, 8, 10, 0, 1, 8, 1, 10, 8], [1, 10, 2],
  [1, 3, 8, 9, 1, 8], [0, 9, 1], [0, 3, 8], []
];

/** The triangle table as a flat 256 x 16 table, padded with -1. */
export const MC_TRI_TABLE = buildTriTable();

function buildTriTable() {
  const table = new Int8Array(256 * 16).fill(-1);
  for (let i = 0; i < 256; i++) {
    const row = TRI_ROWS[i];
    for (let k = 0; k < row.length; k++) table[i * 16 + k] = row[k];
  }
  return table;
}

/** Error carrying a message the HTTP layer can hand to the user. */
function fail(message) {
  const err = new Error(message);
  err.publicMessage = message;
  err.status = 400;
  return err;
}

function checkGrid(mask, grid) {
  if (!(mask instanceof Uint8Array)) throw fail("The voxel mask must be a Uint8Array.");
  if (!grid || typeof grid !== "object") throw fail("No grid was given.");

  const dims = grid.dims;
  if (!Array.isArray(dims) || dims.length !== 3) throw fail("The grid needs dims as [nx, ny, nz].");
  for (const d of dims) {
    if (!Number.isInteger(d) || d < 1) throw fail("The grid dimensions must be whole numbers of at least 1.");
  }

  const origin = grid.origin;
  if (!Array.isArray(origin) || origin.length !== 3 || !origin.every(Number.isFinite)) {
    throw fail("The grid needs origin as [x, y, z] in metres.");
  }

  const cell = grid.cell;
  if (!Number.isFinite(cell) || cell <= 0) throw fail("The cell size must be a number greater than zero.");

  const [nx, ny, nz] = dims;
  const cells = nx * ny * nz;
  if (!Number.isSafeInteger(cells)) throw fail("The grid is too large.");
  if (mask.length < cells) {
    throw fail(`The mask is too small: ${mask.length} values for ${nx} x ${ny} x ${nz} cells.`);
  }
  return { nx, ny, nz, cell, ox: origin[0], oy: origin[1], oz: origin[2] };
}

/**
 * Marching cubes over a binary voxel mask.
 *
 * @param {Uint8Array} mask cell values, 0 outside and 1 inside, x fastest
 * @param {{origin:number[], cell:number, dims:number[]}} grid cell centres in metres
 * @returns {Float32Array} nine values per triangle (three vertices, x y z)
 */
export function surfaceFromMask(mask, grid) {
  const { nx, ny, nz, cell, ox, oy, oz } = checkGrid(mask, grid);

  // Scratch state, allocated once for the whole run.
  const val = new Float64Array(8);      // corner values of the current cube
  const cx = new Float64Array(8);       // corner coordinates of the current cube
  const cy = new Float64Array(8);
  const cz = new Float64Array(8);
  const ex = new Float64Array(12);      // cut point per cube edge
  const ey = new Float64Array(12);
  const ez = new Float64Array(12);

  let out = new Float32Array(1 << 16);
  let n = 0;

  const planeStride = nx * ny;

  for (let k = -1; k < nz; k++) {
    const z0 = oz + (k + 0.5) * cell;
    const z1 = z0 + cell;
    const kLow = k >= 0 && k < nz;
    const kHigh = k + 1 >= 0 && k + 1 < nz;

    for (let j = -1; j < ny; j++) {
      const y0 = oy + (j + 0.5) * cell;
      const y1 = y0 + cell;
      const jLow = j >= 0 && j < ny;
      const jHigh = j + 1 >= 0 && j + 1 < ny;

      // Row start offsets of the four (y, z) combinations the cube touches;
      // -1 marks a row that lies outside the mask and therefore reads as 0.
      const p0 = jLow && kLow ? nx * j + planeStride * k : -1;                  // corners 0 and 1
      const p3 = jHigh && kLow ? nx * (j + 1) + planeStride * k : -1;           // corners 3 and 2
      const p4 = jLow && kHigh ? nx * j + planeStride * (k + 1) : -1;           // corners 4 and 5
      const p7 = jHigh && kHigh ? nx * (j + 1) + planeStride * (k + 1) : -1;    // corners 7 and 6
      if (p0 < 0 && p3 < 0 && p4 < 0 && p7 < 0) continue; // nothing but zeros in this row

      // Corners on the low-x side, carried over from the previous cube.
      let c0 = 0, c3 = 0, c4 = 0, c7 = 0;

      for (let i = -1; i < nx; i++) {
        const ih = i + 1;
        const inHigh = ih < nx;
        const c1 = inHigh && p0 >= 0 && mask[p0 + ih] ? 1 : 0;
        const c2 = inHigh && p3 >= 0 && mask[p3 + ih] ? 1 : 0;
        const c5 = inHigh && p4 >= 0 && mask[p4 + ih] ? 1 : 0;
        const c6 = inHigh && p7 >= 0 && mask[p7 + ih] ? 1 : 0;

        // The classic table numbers a corner by "below the iso value", so the
        // bit stands for an EMPTY cell. That is what makes the winding put the
        // normal on the air side, i.e. outwards, and the enclosed volume
        // positive.
        const cube = (c0 ^ 1) | ((c1 ^ 1) << 1) | ((c2 ^ 1) << 2) | ((c3 ^ 1) << 3)
          | ((c4 ^ 1) << 4) | ((c5 ^ 1) << 5) | ((c6 ^ 1) << 6) | ((c7 ^ 1) << 7);
        const cut = MC_EDGE_TABLE[cube];

        if (cut !== 0) {
          const x0 = ox + (i + 0.5) * cell;
          const x1 = x0 + cell;

          val[0] = c0; val[1] = c1; val[2] = c2; val[3] = c3;
          val[4] = c4; val[5] = c5; val[6] = c6; val[7] = c7;
          for (let c = 0; c < 8; c++) {
            cx[c] = CORNER_DX[c] ? x1 : x0;
            cy[c] = CORNER_DY[c] ? y1 : y0;
            cz[c] = CORNER_DZ[c] ? z1 : z0;
          }

          for (let e = 0; e < 12; e++) {
            if ((cut & (1 << e)) === 0) continue;
            const a = EDGE_A[e];
            const b = EDGE_B[e];
            const va = val[a];
            const vb = val[b];
            const d = vb - va;
            const t = d === 0 ? 0.5 : (ISO - va) / d;
            ex[e] = cx[a] + t * (cx[b] - cx[a]);
            ey[e] = cy[a] + t * (cy[b] - cy[a]);
            ez[e] = cz[a] + t * (cz[b] - cz[a]);
          }

          const row = cube * 16;
          for (let s = 0; s < 16 && MC_TRI_TABLE[row + s] >= 0; s += 3) {
            if (n + 9 > out.length) {
              const grown = new Float32Array(out.length * 2);
              grown.set(out);
              out = grown;
            }
            for (let v = 0; v < 3; v++) {
              const e = MC_TRI_TABLE[row + s + v];
              out[n++] = ex[e];
              out[n++] = ey[e];
              out[n++] = ez[e];
            }
          }
        }

        c0 = c1; c3 = c2; c4 = c5; c7 = c6;
      }
    }
  }

  return out.slice(0, n);
}

/** Accepts any numeric array or typed array of triangle corners. */
function asTriangles(triangles) {
  const usable = Array.isArray(triangles)
    || (ArrayBuffer.isView(triangles) && !(triangles instanceof DataView));
  if (!usable) throw fail("No triangle data was given.");
  if (triangles.length % 9 !== 0) {
    throw fail("The triangle list must contain nine values per triangle.");
  }
  return triangles;
}

const STL_HEADER_BYTES = 80;
const STL_TRIANGLE_BYTES = 50;

/** Below this the cross product is noise, so the normal is written as zero. */
const MIN_CROSS_LENGTH = 1e-20;

/**
 * Writes a binary STL.
 *
 * @param {Float32Array|Float64Array} triangles nine values per triangle
 * @param {string} [header] header text, cut or zero padded to 80 bytes
 * @returns {Buffer} the complete file
 */
export function writeBinaryStl(triangles, header = "FluidX3D Studio") {
  const tri = asTriangles(triangles);
  const count = tri.length / 9;
  const buffer = Buffer.alloc(STL_HEADER_BYTES + 4 + STL_TRIANGLE_BYTES * count);

  // A binary header starting with "solid" makes naive readers try ASCII.
  let text = typeof header === "string" ? header : String(header ?? "");
  if (/^\s*solid/i.test(text)) text = `binary ${text}`;
  buffer.write(text.slice(0, STL_HEADER_BYTES), 0, STL_HEADER_BYTES, "latin1");
  buffer.writeUInt32LE(count, STL_HEADER_BYTES);

  let off = STL_HEADER_BYTES + 4;
  for (let t = 0; t < count; t++) {
    const s = t * 9;
    const ax = tri[s], ay = tri[s + 1], az = tri[s + 2];
    const bx = tri[s + 3], by = tri[s + 4], bz = tri[s + 5];
    const cx = tri[s + 6], cy = tri[s + 7], cz = tri[s + 8];

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > MIN_CROSS_LENGTH && Number.isFinite(len)) {
      nx /= len; ny /= len; nz /= len;
    } else {
      nx = 0; ny = 0; nz = 0; // degenerate triangle: a zero normal, never NaN
    }

    buffer.writeFloatLE(nx, off); buffer.writeFloatLE(ny, off + 4); buffer.writeFloatLE(nz, off + 8);
    buffer.writeFloatLE(ax, off + 12); buffer.writeFloatLE(ay, off + 16); buffer.writeFloatLE(az, off + 20);
    buffer.writeFloatLE(bx, off + 24); buffer.writeFloatLE(by, off + 28); buffer.writeFloatLE(bz, off + 32);
    buffer.writeFloatLE(cx, off + 36); buffer.writeFloatLE(cy, off + 40); buffer.writeFloatLE(cz, off + 44);
    buffer.writeUInt16LE(0, off + 48);
    off += STL_TRIANGLE_BYTES;
  }
  return buffer;
}

/** Grid the vertex welding rounds to, in metres — far below one cell. */
const WELD_QUANTUM = 1e-6;

/** Taubin's shrink free pair: a smoothing pass followed by an inflating one. */
const TAUBIN_LAMBDA = 0.5;
const TAUBIN_MU = -0.53;

const hashScratchF = new Float32Array(3);
const hashScratchI = new Int32Array(hashScratchF.buffer);

function mix(h, v) {
  h ^= v;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h;
}

/**
 * Welds the triangle corners into shared vertices by their rounded
 * coordinates. Open hashing over typed arrays — no strings, no objects.
 */
function weld(tri) {
  const corners = tri.length / 3;
  let capacity = 16;
  while (capacity < corners * 2) capacity *= 2;
  const mask = capacity - 1;

  const head = new Int32Array(capacity).fill(-1);
  const next = new Int32Array(corners).fill(-1);
  const px = new Float32Array(corners);
  const py = new Float32Array(corners);
  const pz = new Float32Array(corners);
  const cornerOf = new Int32Array(corners);

  let unique = 0;
  for (let c = 0; c < corners; c++) {
    const s = c * 3;
    hashScratchF[0] = Math.round(tri[s] / WELD_QUANTUM) * WELD_QUANTUM;
    hashScratchF[1] = Math.round(tri[s + 1] / WELD_QUANTUM) * WELD_QUANTUM;
    hashScratchF[2] = Math.round(tri[s + 2] / WELD_QUANTUM) * WELD_QUANTUM;
    const x = hashScratchF[0], y = hashScratchF[1], z = hashScratchF[2];

    let h = mix(mix(mix(0x9e3779b9, hashScratchI[0]), hashScratchI[1]), hashScratchI[2]);
    const bucket = h & mask;

    let found = -1;
    for (let v = head[bucket]; v >= 0; v = next[v]) {
      if (px[v] === x && py[v] === y && pz[v] === z) { found = v; break; }
    }
    if (found < 0) {
      found = unique++;
      px[found] = x; py[found] = y; pz[found] = z;
      next[found] = head[bucket];
      head[bucket] = found;
    }
    cornerOf[c] = found;
  }
  return { unique, px, py, pz, cornerOf };
}

/**
 * Optional Laplacian smoothing over the shared vertices.
 *
 * Plain Laplacian smoothing shrinks a closed body, and a shrunken body changes
 * the aerodynamics — so this uses Taubin's lambda/mu pair, where every
 * smoothing pass is followed by an inflating one. The total displacement can
 * additionally be capped (half a cell is a sensible bound).
 *
 * @param {Float32Array} triangles nine values per triangle
 * @param {number} iterations lambda/mu passes; 0 passes the input straight through
 * @param {{lambda?:number, mu?:number, maxDisplacement?:number}} [options]
 * @returns {Float32Array} the smoothed triangles, same order and winding
 */
export function smoothSurface(triangles, iterations = 0, options = {}) {
  const tri = asTriangles(triangles);
  const passes = Math.max(0, Math.floor(Number(iterations) || 0));
  if (passes === 0 || tri.length === 0) return triangles;

  const lambda = Number.isFinite(options.lambda) ? options.lambda : TAUBIN_LAMBDA;
  const mu = Number.isFinite(options.mu) ? options.mu : TAUBIN_MU;
  const limit = Number.isFinite(options.maxDisplacement) && options.maxDisplacement >= 0
    ? options.maxDisplacement
    : Infinity;

  const { unique, px, py, pz, cornerOf } = weld(tri);
  const triCount = tri.length / 9;

  // Adjacency in CSR form. Every triangle contributes its three edges in both
  // directions; in a closed mesh each edge appears twice, so the neighbours
  // stay uniformly weighted.
  const offset = new Int32Array(unique + 1);
  for (let t = 0; t < triCount; t++) {
    const a = cornerOf[t * 3], b = cornerOf[t * 3 + 1], c = cornerOf[t * 3 + 2];
    offset[a] += 2; offset[b] += 2; offset[c] += 2;
  }
  let sum = 0;
  for (let v = 0; v < unique; v++) {
    const d = offset[v];
    offset[v] = sum;
    sum += d;
  }
  offset[unique] = sum;

  const adjacency = new Int32Array(sum);
  const cursor = offset.slice(0, unique);
  for (let t = 0; t < triCount; t++) {
    const a = cornerOf[t * 3], b = cornerOf[t * 3 + 1], c = cornerOf[t * 3 + 2];
    adjacency[cursor[a]++] = b; adjacency[cursor[a]++] = c;
    adjacency[cursor[b]++] = c; adjacency[cursor[b]++] = a;
    adjacency[cursor[c]++] = a; adjacency[cursor[c]++] = b;
  }

  const ox = limit === Infinity ? null : px.slice(0, unique);
  const oy = limit === Infinity ? null : py.slice(0, unique);
  const oz = limit === Infinity ? null : pz.slice(0, unique);

  const tx = new Float32Array(unique);
  const ty = new Float32Array(unique);
  const tz = new Float32Array(unique);

  for (let it = 0; it < passes; it++) {
    relax(lambda);
    relax(mu);
  }

  const out = new Float32Array(tri.length);
  for (let c = 0; c < tri.length / 3; c++) {
    const v = cornerOf[c];
    out[c * 3] = px[v];
    out[c * 3 + 1] = py[v];
    out[c * 3 + 2] = pz[v];
  }
  return out;

  /** One weighted move of every vertex towards the average of its neighbours. */
  function relax(factor) {
    for (let v = 0; v < unique; v++) {
      const from = offset[v];
      const to = offset[v + 1];
      const degree = to - from;
      if (degree === 0) { tx[v] = px[v]; ty[v] = py[v]; tz[v] = pz[v]; continue; }
      let sx = 0, sy = 0, sz = 0;
      for (let a = from; a < to; a++) {
        const w = adjacency[a];
        sx += px[w]; sy += py[w]; sz += pz[w];
      }
      tx[v] = px[v] + factor * (sx / degree - px[v]);
      ty[v] = py[v] + factor * (sy / degree - py[v]);
      tz[v] = pz[v] + factor * (sz / degree - pz[v]);
    }
    if (ox) clampToLimit();
    px.set(tx.subarray(0, unique));
    py.set(ty.subarray(0, unique));
    pz.set(tz.subarray(0, unique));
  }

  /** Keeps every vertex within `limit` of where marching cubes put it. */
  function clampToLimit() {
    for (let v = 0; v < unique; v++) {
      const dx = tx[v] - ox[v];
      const dy = ty[v] - oy[v];
      const dz = tz[v] - oz[v];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d <= limit || d === 0) continue;
      const f = limit / d;
      tx[v] = ox[v] + dx * f;
      ty[v] = oy[v] + dy * f;
      tz[v] = oz[v] + dz * f;
    }
  }
}

export default { surfaceFromMask, writeBinaryStl, smoothSurface, MC_EDGE_TABLE, MC_TRI_TABLE };
