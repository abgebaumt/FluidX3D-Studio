#pragma once

/*
 * Runtime mesh sealing — CONTRACT.md section 8, moved into the solver.
 *
 * Why this exists: FluidX3D's voxelize_mesh casts one ray per cell column and
 * stores the hit distances as integers (ushort distances[64], kernel.cpp near
 * line 2271). When a wall is thinner than one cell, its front and back hit land
 * on the same integer, the inside/outside state flips twice within the same
 * step, and the wall disappears entirely — not partially. That is a resolution
 * problem, not a mesh defect, so STL repair does not help.
 *
 * The fix is to rasterise every triangle into the cells it overlaps: a face
 * occupies cells regardless of how thin it is. Doing that here, at runtime,
 * means it happens at exactly the resolution the run uses. The earlier approach
 * (a pre-computed sealed STL from the server) froze the result for one cell
 * size; changing the VRAM target then fed a finer simulation with a coarser
 * geometry.
 *
 * The work is strictly local: only the mesh's bounding box plus a small margin
 * is touched, never the whole domain. For a 25 m model in a 60 m box that is a
 * few million cells instead of nearly two hundred million.
 *
 * Pipeline, ported one to one from server/voxel-seal.js (the tested reference):
 *
 *   shell rasterisation (separating-axis test, 13 axes)
 *     -> morphological closing (dilate, then erode; separable 1D passes)
 *     -> flood fill from the sub-grid border (iterative, explicit queue)
 *     -> thicken the shell to the requested minimum wall thickness
 *     -> OR the mask into lbm.flags
 *
 * Memory rules: one byte per cell for the mask, one more byte for the
 * ping-pong buffer of the morphology, four bytes per cell for the flood-fill
 * queue — never an object per cell.
 *
 * Grid convention: FluidX3D's voxelize_mesh kernel computes its ray origin as
 * position(xyz)+offset, which collapses to exactly (x, y, z). A mesh that has
 * been scaled, rotated and translated by the setup therefore lives in cell
 * index coordinates: cell (i,j,k) has its CENTRE at (i,j,k) and spans
 * [i-0.5, i+0.5] x [j-0.5, j+0.5] x [k-0.5, k+0.5]. That is the box the
 * triangle overlap test is run against, with half edge length 0.5.
 *
 * Header-only, C++17, no dependency beyond the standard library and FluidX3D's
 * own types from utilities.hpp. Nothing inside FluidX3D is modified.
 */

#include "lbm.hpp"

namespace mesh_seal {

/* Sealing modes, matching sealing.mode in the setup config. */
enum Seal_Mode {
	SEAL_OFF   = 0, // "off"   — do nothing
	SEAL_SHELL = 1, // "shell" — keep the body hollow, only make its skin solid
	SEAL_FILL  = 2  // "fill"  — additionally fill the enclosed interior
};

/* Upper bound on the sub-grid a single sealing run may allocate. 64 M cells are
   64 MB of mask, 64 MB of scratch and 256 MB of flood-fill queue; beyond that
   the request is a wrong cell size rather than a real one. */
const ulong MAX_SEAL_CELLS = 64000000ull;

inline int mode_from_string(const string& mode) {
	if(mode=="shell") return SEAL_SHELL;
	if(mode=="fill" ) return SEAL_FILL;
	return SEAL_OFF; // "off" and anything unknown
}

/* ------------------------------------------------------------- sub-grid --- */

/* An axis-aligned block of the LBM lattice, addressed in global cell indices.
   Cells inside it are stored at i+(j+k*ny)*nx — x runs fastest, like FluidX3D's
   own linear index. */
struct Sub_Grid {
	uint x0=0u, y0=0u, z0=0u; // lower corner in global cell indices
	uint nx=1u, ny=1u, nz=1u; // extent in cells
	inline ulong cells() const { return (ulong)nx*(ulong)ny*(ulong)nz; }
	inline ulong plane() const { return (ulong)nx*(ulong)ny; }
	inline uint longest_side() const { return nx>ny ? (nx>nz ? nx : nz) : (ny>nz ? ny : nz); }
};

/* ------------------------------------------ stage 1: shell rasterisation --- */

/* Separating-axis overlap test between a triangle and an axis-aligned cube
   (Akenine-Moeller, "Fast 3D Triangle-Box Overlap Testing"). Thirteen axes:
   nine edge/box-axis cross products, three box normals, one triangle normal.
   Touching counts as overlap, which is what we want — a face lying exactly on a
   cell boundary must not fall through the lattice. */
inline bool triangle_box_overlap(
	const float cx, const float cy, const float cz, const float h, // box centre and half edge length
	const float ax, const float ay, const float az,                // triangle vertex a
	const float bx, const float by, const float bz,                // triangle vertex b
	const float gx, const float gy, const float gz                 // triangle vertex c
) {
	// Triangle vertices relative to the box centre.
	const float v0x=ax-cx, v0y=ay-cy, v0z=az-cz;
	const float v1x=bx-cx, v1y=by-cy, v1z=bz-cz;
	const float v2x=gx-cx, v2y=gy-cy, v2z=gz-cz;

	// Triangle edges.
	const float e0x=v1x-v0x, e0y=v1y-v0y, e0z=v1z-v0z;
	const float e1x=v2x-v1x, e1y=v2y-v1y, e1z=v2z-v1z;
	const float e2x=v0x-v2x, e2y=v0y-v2y, e2z=v0z-v2z;

	float p0, p1, p2, lo, hi, rad, fx, fy, fz;

	// --- nine axes: triangle edge x box axis ---
	fx = std::fabs(e0x); fy = std::fabs(e0y); fz = std::fabs(e0z);
	p0 = e0z*v0y-e0y*v0z; // e0 x (1,0,0)
	p2 = e0z*v2y-e0y*v2z;
	lo = p0<p2 ? p0 : p2; hi = p0<p2 ? p2 : p0;
	rad = (fz+fy)*h;
	if(lo>rad||hi<-rad) return false;
	p0 = -e0z*v0x+e0x*v0z; // e0 x (0,1,0)
	p2 = -e0z*v2x+e0x*v2z;
	lo = p0<p2 ? p0 : p2; hi = p0<p2 ? p2 : p0;
	rad = (fz+fx)*h;
	if(lo>rad||hi<-rad) return false;
	p1 = e0y*v1x-e0x*v1y; // e0 x (0,0,1)
	p2 = e0y*v2x-e0x*v2y;
	lo = p1<p2 ? p1 : p2; hi = p1<p2 ? p2 : p1;
	rad = (fy+fx)*h;
	if(lo>rad||hi<-rad) return false;

	fx = std::fabs(e1x); fy = std::fabs(e1y); fz = std::fabs(e1z);
	p0 = e1z*v0y-e1y*v0z; // e1 x (1,0,0)
	p2 = e1z*v2y-e1y*v2z;
	lo = p0<p2 ? p0 : p2; hi = p0<p2 ? p2 : p0;
	rad = (fz+fy)*h;
	if(lo>rad||hi<-rad) return false;
	p0 = -e1z*v0x+e1x*v0z; // e1 x (0,1,0)
	p2 = -e1z*v2x+e1x*v2z;
	lo = p0<p2 ? p0 : p2; hi = p0<p2 ? p2 : p0;
	rad = (fz+fx)*h;
	if(lo>rad||hi<-rad) return false;
	p0 = e1y*v0x-e1x*v0y; // e1 x (0,0,1)
	p1 = e1y*v1x-e1x*v1y;
	lo = p0<p1 ? p0 : p1; hi = p0<p1 ? p1 : p0;
	rad = (fy+fx)*h;
	if(lo>rad||hi<-rad) return false;

	fx = std::fabs(e2x); fy = std::fabs(e2y); fz = std::fabs(e2z);
	p0 = e2z*v0y-e2y*v0z; // e2 x (1,0,0)
	p1 = e2z*v1y-e2y*v1z;
	lo = p0<p1 ? p0 : p1; hi = p0<p1 ? p1 : p0;
	rad = (fz+fy)*h;
	if(lo>rad||hi<-rad) return false;
	p0 = -e2z*v0x+e2x*v0z; // e2 x (0,1,0)
	p1 = -e2z*v1x+e2x*v1z;
	lo = p0<p1 ? p0 : p1; hi = p0<p1 ? p1 : p0;
	rad = (fz+fx)*h;
	if(lo>rad||hi<-rad) return false;
	p1 = e2y*v1x-e2x*v1y; // e2 x (0,0,1)
	p2 = e2y*v2x-e2x*v2y;
	lo = p1<p2 ? p1 : p2; hi = p1<p2 ? p2 : p1;
	rad = (fy+fx)*h;
	if(lo>rad||hi<-rad) return false;

	// --- three box normals ---
	lo = v0x<v1x ? v0x : v1x; if(v2x<lo) lo = v2x;
	hi = v0x>v1x ? v0x : v1x; if(v2x>hi) hi = v2x;
	if(lo>h||hi<-h) return false;
	lo = v0y<v1y ? v0y : v1y; if(v2y<lo) lo = v2y;
	hi = v0y>v1y ? v0y : v1y; if(v2y>hi) hi = v2y;
	if(lo>h||hi<-h) return false;
	lo = v0z<v1z ? v0z : v1z; if(v2z<lo) lo = v2z;
	hi = v0z>v1z ? v0z : v1z; if(v2z>hi) hi = v2z;
	if(lo>h||hi<-h) return false;

	// --- the triangle normal (plane against box) ---
	const float nx = e0y*e1z-e0z*e1y;
	const float ny = e0z*e1x-e0x*e1z;
	const float nz = e0x*e1y-e0y*e1x;
	const float d = -(nx*v0x+ny*v0y+nz*v0z);
	const float support = (std::fabs(nx)+std::fabs(ny)+std::fabs(nz))*h; // support point of the box along +/- normal
	return d<=support&&d>=-support;
}

/* Every cell a triangle overlaps becomes 1.

   Parallelised over z-slabs rather than over triangles: each thread owns a
   disjoint range of layers and skips every triangle that does not reach into
   it, so two threads can never write the same byte. Walking the triangle list
   once per slab is cheap — the bounding-box rejection is a handful of
   comparisons — and it avoids both a data race and any locking. */
inline void rasterise_shell(vector<uchar>& mask, const Sub_Grid& g, const Mesh* mesh, const uint threads) {
	const uint triangles = mesh->triangle_number;
	const uint slabs = threads<g.nz ? threads : g.nz; // never more slabs than there are layers
	const int gx0=(int)g.x0, gx1=(int)(g.x0+g.nx-1u);
	const int gy0=(int)g.y0, gy1=(int)(g.y0+g.ny-1u);
	const int gz0=(int)g.z0, gz1=(int)(g.z0+g.nz-1u);
	const ulong nxl = (ulong)g.nx, nyl = (ulong)g.ny;
	uchar* m = mask.data();
	parallel_for(slabs, slabs, [&](uint s) {
		const int slab0 = gz0+(int)((ulong)g.nz*(ulong)s/(ulong)slabs);          // inclusive
		const int slab1 = gz0+(int)((ulong)g.nz*(ulong)(s+1u)/(ulong)slabs)-1;   // inclusive
		if(slab1<slab0) return;
		for(uint t=0u; t<triangles; t++) {
			const float3 a=mesh->p0[t], b=mesh->p1[t], c=mesh->p2[t];
			// Cell range of this triangle's own bounding box. A cell of half
			// width 0.5 centred on an integer overlaps [tmin, tmax] exactly for
			// ceil(tmin-0.5) <= index <= floor(tmax+0.5); the epsilon keeps a
			// triangle that lies exactly on a cell boundary inside the range.
			float tmin = a.x<b.x ? a.x : b.x; if(c.x<tmin) tmin = c.x;
			float tmax = a.x>b.x ? a.x : b.x; if(c.x>tmax) tmax = c.x;
			int i0 = (int)std::ceil(tmin-0.5f-1E-4f), i1 = (int)std::floor(tmax+0.5f+1E-4f);
			if(i1<gx0||i0>gx1) continue;
			if(i0<gx0) i0 = gx0;
			if(i1>gx1) i1 = gx1;

			tmin = a.y<b.y ? a.y : b.y; if(c.y<tmin) tmin = c.y;
			tmax = a.y>b.y ? a.y : b.y; if(c.y>tmax) tmax = c.y;
			int j0 = (int)std::ceil(tmin-0.5f-1E-4f), j1 = (int)std::floor(tmax+0.5f+1E-4f);
			if(j1<gy0||j0>gy1) continue;
			if(j0<gy0) j0 = gy0;
			if(j1>gy1) j1 = gy1;

			tmin = a.z<b.z ? a.z : b.z; if(c.z<tmin) tmin = c.z;
			tmax = a.z>b.z ? a.z : b.z; if(c.z>tmax) tmax = c.z;
			int k0 = (int)std::ceil(tmin-0.5f-1E-4f), k1 = (int)std::floor(tmax+0.5f+1E-4f);
			if(k0<slab0) k0 = slab0; // clip to this thread's layers as well
			if(k1>slab1) k1 = slab1;
			if(k1<k0||k1<gz0||k0>gz1) continue;
			if(k0<gz0) k0 = gz0;
			if(k1>gz1) k1 = gz1;

			for(int k=k0; k<=k1; k++) {
				for(int j=j0; j<=j1; j++) {
					const ulong row = ((ulong)(uint)(j-gy0)+(ulong)(uint)(k-gz0)*nyl)*nxl;
					for(int i=i0; i<=i1; i++) {
						const ulong index = row+(ulong)(uint)(i-gx0);
						if(m[index]!=0u) continue;
						if(triangle_box_overlap((float)i, (float)j, (float)k, 0.5f, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)) m[index] = 1u;
					}
				}
			}
		}
	});
}

/* --------------------------------------------- stage 2: morphology --------- */

/* One separable 1D pass over a single line of the sub-grid.

   The mask is binary, so a prefix sum over the line answers both filters in
   constant time per cell whatever the radius: the window contains at least one
   solid cell (dilate) or nothing but solid cells (erode).

   Cells outside the sub-grid are ignored, so the window is clipped rather than
   padded. Dilation therefore never invents material beyond the border and
   erosion never eats a body touching it — with the margin the caller lays
   around the object neither case can occur anyway. */
inline void filter_line(const uchar* src, uchar* dst, const uint count, const ulong stride, const ulong base, const uint radius, const bool is_max, uint* prefix) {
	prefix[0] = 0u;
	for(uint i=0u; i<count; i++) prefix[i+1u] = prefix[i]+(src[base+(ulong)i*stride]!=0u ? 1u : 0u);
	const uint last = count-1u;
	for(uint i=0u; i<count; i++) {
		const uint lo = i>radius ? i-radius : 0u;
		const uint hi = i+radius<last ? i+radius : last;
		const uint sum = prefix[hi+1u]-prefix[lo];
		dst[base+(ulong)i*stride] = (uchar)(is_max ? (sum>0u ? 1u : 0u) : (sum==hi-lo+1u ? 1u : 0u));
	}
}

/* One of the three separable passes. Lines are independent, so they are handed
   out to the thread pool; every thread gets its own slice of the prefix
   scratch buffer. */
inline void filter_axis(const vector<uchar>& src, vector<uchar>& dst, const Sub_Grid& g, const uint axis, const uint radius, const bool is_max, const uint threads, vector<uint>& scratch, const uint scratch_stride) {
	const ulong nxl=(ulong)g.nx, nyl=(ulong)g.ny, nxy=g.plane();
	const uint count = axis==0u ? g.nx : axis==1u ? g.ny : g.nz;
	const ulong stride = axis==0u ? 1ull : axis==1u ? nxl : nxy;
	const ulong lines = axis==0u ? nyl*(ulong)g.nz : axis==1u ? nxl*(ulong)g.nz : nxy;
	const uchar* s = src.data();
	uchar* d = dst.data();
	uint* scratch_data = scratch.data();
	parallel_for(lines, threads, [&](ulong line, uint t) {
		ulong base = 0ull;
		if(axis==0u) base = nxl*(line%nyl)+nxy*(line/nyl); // line = j+k*ny
		else if(axis==1u) base = (line%nxl)+nxy*(line/nxl); // line = i+k*nx
		else base = line;                                   // line = i+j*nx
		filter_line(s, d, count, stride, base, radius, is_max, scratch_data+(ulong)t*(ulong)scratch_stride);
	});
}

/* Separable morphology with a cube-shaped structuring element of edge
   2*radius+1: three 1D passes instead of one 3D kernel. Ping-pongs between the
   mask and one scratch buffer, so the peak is two bytes per cell. */
inline void morph(vector<uchar>& mask, const Sub_Grid& g, const uint radius, const bool is_max, const uint threads) {
	if(radius==0u) return;
	const uint scratch_stride = g.longest_side()+1u;
	vector<uint> scratch((std::size_t)((ulong)threads*(ulong)scratch_stride), 0u);
	vector<uchar> other((std::size_t)g.cells(), (uchar)0u);
	filter_axis(mask, other, g, 0u, radius, is_max, threads, scratch, scratch_stride);
	filter_axis(other, mask, g, 1u, radius, is_max, threads, scratch, scratch_stride);
	filter_axis(mask, other, g, 2u, radius, is_max, threads, scratch, scratch_stride);
	mask.swap(other);
}

/* Morphological closing: dilate, then erode. Seals openings up to 2*radius
   cells wide while leaving the outer shape where it was. (Named morph_close,
   not close_holes, so it does not collide with the close_holes parameter of
   seal_mesh_into_flags.) */
inline void morph_close(vector<uchar>& mask, const Sub_Grid& g, const uint radius, const uint threads) {
	if(radius==0u) return;
	morph(mask, g, radius, true, threads);
	morph(mask, g, radius, false, threads);
}

/* --------------------------------------------- stage 3: flood fill -------- */

/* Flood-fills from the sub-grid border through all non-solid cells. Everything
   the fill never reached is enclosed interior.

   Iterative with an explicit queue over cell indices — a body of a few million
   cells would blow the call stack with recursion. Every cell enters the queue
   at most once, so a buffer of one uint per cell is an exact bound.

   With `apply` the interior becomes solid; without it the mask comes back
   exactly as it went in and only the count is reported, which is how shell mode
   still learns whether the body is watertight.

   Returns the number of enclosed cells; zero means the fill escaped, i.e. the
   shell has an opening (or no cavity at all). */
inline ulong fill_interior(vector<uchar>& mask, const Sub_Grid& g, const bool apply) {
	const ulong n = g.cells();
	if(n>(ulong)max_uint) { // cannot happen for any sane domain, but the queue index is a uint
		print_warning("Sealing: the sub-grid is too large to flood-fill, skipped.");
		return 0ull;
	}
	const uint nx=g.nx, ny=g.ny, nz=g.nz;
	const ulong nxl=(ulong)nx, nxy=g.plane();
	const uchar OUTSIDE = 2u; // scratch marker, removed again before returning
	uchar* m = mask.data();
	vector<uint> queue((std::size_t)n, 0u);
	uint* q = queue.data();
	ulong head = 0ull, tail = 0ull;

	// Seed: every empty cell on the six border faces belongs to the outside.
	for(uint k=0u; k<nz; k++) {
		const bool z_border = k==0u||k==nz-1u;
		for(uint j=0u; j<ny; j++) {
			const ulong row = nxl*(ulong)j+nxy*(ulong)k;
			if(z_border||j==0u||j==ny-1u) {
				for(uint i=0u; i<nx; i++) {
					const ulong index = row+(ulong)i;
					if(m[index]==0u) { m[index] = OUTSIDE; q[tail++] = (uint)index; }
				}
			} else {
				ulong index = row;
				if(m[index]==0u) { m[index] = OUTSIDE; q[tail++] = (uint)index; }
				index = row+(ulong)(nx-1u);
				if(m[index]==0u) { m[index] = OUTSIDE; q[tail++] = (uint)index; }
			}
		}
	}

	while(head<tail) {
		const ulong index = (ulong)q[head++];
		const ulong k = index/nxy;
		const ulong rest = index-k*nxy;
		const ulong j = rest/nxl;
		const ulong i = rest-j*nxl;
		ulong o;
		if(i>0ull       ) { o = index-1ull; if(m[o]==0u) { m[o] = OUTSIDE; q[tail++] = (uint)o; } }
		if(i<(ulong)nx-1){ o = index+1ull; if(m[o]==0u) { m[o] = OUTSIDE; q[tail++] = (uint)o; } }
		if(j>0ull       ) { o = index-nxl; if(m[o]==0u) { m[o] = OUTSIDE; q[tail++] = (uint)o; } }
		if(j<(ulong)ny-1){ o = index+nxl; if(m[o]==0u) { m[o] = OUTSIDE; q[tail++] = (uint)o; } }
		if(k>0ull       ) { o = index-nxy; if(m[o]==0u) { m[o] = OUTSIDE; q[tail++] = (uint)o; } }
		if(k<(ulong)nz-1){ o = index+nxy; if(m[o]==0u) { m[o] = OUTSIDE; q[tail++] = (uint)o; } }
	}

	ulong interior = 0ull;
	for(ulong index=0ull; index<n; index++) {
		const uchar v = m[index];
		if(v==0u) { m[index] = apply ? 1u : 0u; interior++; } // never reached -> enclosed
		else if(v==OUTSIDE) m[index] = 0u;                    // reached -> plain empty again
	}
	return interior;
}

/* ------------------------------------------------------------ counting --- */

inline ulong count_solid(const vector<uchar>& mask, const uint threads) {
	const ulong n = (ulong)mask.size();
	vector<ulong> partial((std::size_t)threads, 0ull);
	const uchar* m = mask.data();
	ulong* p = partial.data();
	parallel_for(n, threads, [&](ulong index, uint t) { if(m[index]!=0u) p[t]++; });
	ulong total = 0ull;
	for(uint t=0u; t<threads; t++) total += partial[t];
	return total;
}

/* ---------------------------------------------------------- entry point --- */

/*
 * Seals `mesh` into `lbm.flags` at the resolution the run actually uses.
 *
 * Call this AFTER the mesh has been scaled, rotated and placed, and AFTER
 * FluidX3D's own voxelize_mesh_on_device has run for it — that call refreshes
 * the host copy of `flags` from the device, so anything written here before it
 * would be lost. Existing flags are never cleared, only OR-ed into, so several
 * objects and the boundary conditions coexist.
 *
 * mode          SEAL_OFF | SEAL_SHELL | SEAL_FILL
 * close_holes   morphological closing radius in cells, 0..8
 * min_thickness minimum wall thickness in cells, 1..16 (shell mode only; a
 *               filled body is solid anyway)
 * label         object name, used for the log line only
 */
inline void seal_mesh_into_flags(LBM& lbm, const Mesh* mesh, const uchar flag, const int mode, const int close_holes, const int min_thickness, const string& label="") {
	if(mode==SEAL_OFF) return;
	const string name = label=="" ? string("") : " \""+label+"\"";
	if(mesh==nullptr||mesh->triangle_number==0u) {
		print_warning("Sealing"+name+": the mesh has no triangles, skipped.");
		return;
	}
	Clock timer;

	const uint hardware_threads = (uint)thread::hardware_concurrency();
	const uint threads = hardware_threads>0u ? hardware_threads : 1u;

	const uint close_radius = (uint)(close_holes<0 ? 0 : (close_holes>8 ? 8 : close_holes));
	const uint thickness = (uint)(min_thickness<1 ? 1 : (min_thickness>16 ? 16 : min_thickness));
	// Thickening is a shell-mode step; in fill mode the body is solid anyway.
	const uint thicken_radius = mode==SEAL_SHELL ? thickness-1u : 0u;
	// At least radius+2 empty cells around the object. This is a lower bound,
	// not a preference: with a thinner border the closing would reach the outer
	// cell layer, the flood fill would find no outside left and would declare
	// the whole sub-grid solid.
	const uint margin = (close_radius>thicken_radius ? close_radius : thicken_radius)+2u;

	// Bounding box of the placed mesh in cell indices, widened by the margin.
	const int Nx=(int)lbm.get_Nx(), Ny=(int)lbm.get_Ny(), Nz=(int)lbm.get_Nz();
	int i0 = (int)std::ceil(mesh->pmin.x-0.5f)-(int)margin, i1 = (int)std::floor(mesh->pmax.x+0.5f)+(int)margin;
	int j0 = (int)std::ceil(mesh->pmin.y-0.5f)-(int)margin, j1 = (int)std::floor(mesh->pmax.y+0.5f)+(int)margin;
	int k0 = (int)std::ceil(mesh->pmin.z-0.5f)-(int)margin, k1 = (int)std::floor(mesh->pmax.z+0.5f)+(int)margin;
	if(i1<0||j1<0||k1<0||i0>Nx-1||j0>Ny-1||k0>Nz-1) {
		print_warning("Sealing"+name+": the object lies outside the domain, skipped.");
		return;
	}
	const bool clamped = i0<0||j0<0||k0<0||i1>Nx-1||j1>Ny-1||k1>Nz-1;
	if(i0<0) i0 = 0;
	if(j0<0) j0 = 0;
	if(k0<0) k0 = 0;
	if(i1>Nx-1) i1 = Nx-1;
	if(j1>Ny-1) j1 = Ny-1;
	if(k1>Nz-1) k1 = Nz-1;

	Sub_Grid g;
	g.x0 = (uint)i0; g.nx = (uint)(i1-i0+1);
	g.y0 = (uint)j0; g.ny = (uint)(j1-j0+1);
	g.z0 = (uint)k0; g.nz = (uint)(k1-k0+1);
	const ulong n = g.cells();
	if(n>MAX_SEAL_CELLS) {
		print_warning("Sealing"+name+": the sub-grid would be too large at "+to_string(n)+" cells (limit "+to_string(MAX_SEAL_CELLS)+"). Not sealed.");
		return;
	}

	// Stage 1 — shell. This is the actual fix: a face occupies cells no matter
	// how thin it is.
	vector<uchar> mask((std::size_t)n, (uchar)0u);
	rasterise_shell(mask, g, mesh, threads);
	const ulong shell_cells = count_solid(mask, threads);
	if(shell_cells==0ull) {
		print_warning("Sealing"+name+": not a single cell was hit, the placement does not match the domain.");
		return;
	}

	// Stage 2 — close holes. Keep the raw shell only when it is needed to tell
	// "no opening" from "no cavity left" further down.
	vector<uchar> raw_shell;
	if(close_radius>0u) {
		raw_shell = mask;
		morph_close(mask, g, close_radius, threads);
	}

	// Stage 3 — flood fill. It runs in both modes because whether the body is
	// watertight is worth reporting either way; only in fill mode is the result
	// written back into the mask.
	const ulong interior = fill_interior(mask, g, mode==SEAL_FILL);
	const ulong filled_cells = mode==SEAL_FILL ? interior : 0ull;
	bool closed = interior>0ull;
	// A generous closing radius can swallow a small cavity whole. That body is
	// watertight, it simply has no interior left, so fall back to the raw shell.
	if(!closed&&close_radius>0u) closed = fill_interior(raw_shell, g, false)>0ull;
	raw_shell.clear();
	raw_shell.shrink_to_fit();

	// Stage 4 — thicken the shell to the requested wall thickness.
	if(thicken_radius>0u) morph(mask, g, thicken_radius, true, threads);

	// Transfer. Only ever OR — flags of other objects and of the boundary
	// conditions must survive.
	vector<ulong> partial_solid((std::size_t)threads, 0ull), partial_added((std::size_t)threads, 0ull);
	const uchar* m = mask.data();
	ulong* ps = partial_solid.data();
	ulong* pa = partial_added.data();
	const ulong nxl=(ulong)g.nx, nxy=g.plane();
	const uint x0=g.x0, y0=g.y0, z0=g.z0;
	parallel_for(n, threads, [&](ulong index, uint t) {
		if(m[index]==0u) return;
		const ulong k = index/nxy;
		const ulong rest = index-k*nxy;
		const ulong j = rest/nxl;
		const ulong i = rest-j*nxl;
		const ulong cell = lbm.index(x0+(uint)i, y0+(uint)j, z0+(uint)k);
		ps[t]++;
		if((lbm.flags[cell]&flag)!=flag) pa[t]++;
		lbm.flags[cell] |= flag;
	});
	ulong solid_cells = 0ull, added_cells = 0ull;
	for(uint t=0u; t<threads; t++) { solid_cells += partial_solid[t]; added_cells += partial_added[t]; }

	print_info("Sealing"+name+": sub-grid "+to_string(g.nx)+" x "+to_string(g.ny)+" x "+to_string(g.nz)+" = "+to_string(n)+" cells, shell "+to_string(shell_cells)
		+", filled "+to_string(filled_cells)+", solid "+to_string(solid_cells)+" ("+to_string(added_cells)+" new), hull "+(closed ? string("closed") : string("open"))
		+", "+to_string((float)timer.stop(), 2u)+" s");
	if(mode==SEAL_FILL&&!closed) print_warning("Sealing"+name+": the hull is open, nothing was filled. Increase \"Close holes\" or check the mesh.");
	if(clamped) print_warning("Sealing"+name+": the object reaches the edge of the domain; outside and inside cannot be told apart there.");
}

} // namespace mesh_seal
