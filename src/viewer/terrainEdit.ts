import * as THREE from 'three';
import { TILE_CELLS, TILE_SIZE } from '../formats/adt';

/** Points per row of a tile's outer grid, and how many outer points there are. */
const OUTER_ROW = TILE_CELLS + 1;
const OUTER_COUNT = OUTER_ROW * OUTER_ROW;
/** Every height point of a tile: the 129x129 outer grid, then the 128x128 inner grid. */
export const LATTICE_POINTS = OUTER_COUNT + TILE_CELLS * TILE_CELLS;
/** Lattice steps (half a cell, in yards): outer points are on even steps, inner points on odd ones. */
export const HALF_CELL = TILE_SIZE / TILE_CELLS / 2;
const STEPS = TILE_CELLS * 2;

/** A lattice point's index from its half-cell coordinates, or -1 for none (even/odd mixes). */
export function latticeIndex(hx: number, hz: number): number {
	if (hx < 0 || hz < 0 || hx > STEPS || hz > STEPS) return -1;
	if (hx % 2 === 0 && hz % 2 === 0) return (hz / 2) * OUTER_ROW + hx / 2;
	if (hx % 2 === 1 && hz % 2 === 1) return OUTER_COUNT + ((hz - 1) / 2) * TILE_CELLS + (hx - 1) / 2;
	return -1;
}

/** A lattice index's half-cell coordinates. */
export function latticePoint(index: number): [number, number] {
	if (index < OUTER_COUNT) return [(index % OUTER_ROW) * 2, Math.floor(index / OUTER_ROW) * 2];
	const i = index - OUTER_COUNT;
	return [(i % TILE_CELLS) * 2 + 1, Math.floor(i / TILE_CELLS) * 2 + 1];
}

/** The heights a detailed tile was drawn with, for the parts of the viewer that read them. */
export interface HeightTargets {
	geometry: THREE.BufferGeometry;
	/** 129x129 outer heights used for height queries (changed in place). */
	queryHeights: Float32Array;
	/** The ground clutter's copy (changed in place), if the tile has clutter. */
	clutter: { outer: Float32Array; inner: Float32Array } | null;
}

/**
 * A detailed tile's ground as the editor reshapes it. Every vertex of its mesh sits on a point of
 * the height lattice (chunk edges and the skirts repeat points), so a height change moves all of
 * them: the skirts keep their drop. Heights are the original plus a delta, which is what's saved.
 */
export class HeightTile {
	/** Heights as the map has them, and as now shown. */
	readonly original = new Float32Array(LATTICE_POINTS);
	readonly current = new Float32Array(LATTICE_POINTS);
	/** Vertices per lattice point (compressed rows: start offsets, then vertex indices). */
	private readonly starts = new Uint32Array(LATTICE_POINTS + 1);
	private readonly vertices: Uint32Array;
	/** How far each vertex sits below its point (the skirts' drop; 0 on the surface). */
	private readonly drop: Float32Array;
	private readonly positions: THREE.BufferAttribute;
	private readonly normals: THREE.BufferAttribute;

	constructor(readonly key: string, readonly originX: number, readonly originZ: number, private readonly targets: HeightTargets) {
		this.positions = targets.geometry.getAttribute('position') as THREE.BufferAttribute;
		this.normals = targets.geometry.getAttribute('normal') as THREE.BufferAttribute;
		const p = this.positions.array as Float32Array;
		const count = this.positions.count;
		const pointOf = new Int32Array(count);
		this.original.fill(-Infinity);
		const counts = new Uint32Array(LATTICE_POINTS);
		for (let v = 0; v < count; v++) {
			const index = latticeIndex(Math.round(p[v * 3] / HALF_CELL), Math.round(p[v * 3 + 2] / HALF_CELL));
			pointOf[v] = index;
			if (index < 0) continue;
			counts[index]++;
			// The highest vertex at a point is the surface; skirts hang below it.
			this.original[index] = Math.max(this.original[index], p[v * 3 + 1]);
		}
		for (let i = 0; i < LATTICE_POINTS; i++) {
			this.starts[i + 1] = this.starts[i] + counts[i];
			if (this.original[i] === -Infinity) this.original[i] = 0;
		}
		this.vertices = new Uint32Array(this.starts[LATTICE_POINTS]);
		this.drop = new Float32Array(count);
		const fill = this.starts.slice(0, LATTICE_POINTS);
		for (let v = 0; v < count; v++) {
			const index = pointOf[v];
			if (index < 0) continue;
			this.vertices[fill[index]++] = v;
			this.drop[v] = this.original[index] - p[v * 3 + 1];
		}
		this.current.set(this.original);
	}

	/** Sets the shown heights from saved deltas (original + delta), all of them or a box of points. */
	setDelta(delta: Float32Array | undefined, box?: LatticeBox): void {
		const [x0, z0, x1, z1] = box ?? [0, 0, STEPS, STEPS];
		for (let hz = z0; hz <= z1; hz++) {
			for (let hx = x0; hx <= x1; hx++) {
				const i = latticeIndex(hx, hz);
				if (i >= 0) this.current[i] = this.original[i] + (delta?.[i] ?? 0);
			}
		}
		this.update(box);
	}

	/**
	 * Pushes the shown heights in a box of lattice points (half-cell coordinates, inclusive) to
	 * the mesh, its normals, the height queries and the clutter.
	 */
	update(box?: LatticeBox): void {
		const [x0, z0, x1, z1] = box ?? [0, 0, STEPS, STEPS];
		const p = this.positions.array as Float32Array;
		const n = this.normals.array as Float32Array;
		const normal = new THREE.Vector3();
		// Normals reach one point further: a neighbour's height change tilts them.
		for (let hz = Math.max(0, z0 - 2); hz <= Math.min(STEPS, z1 + 2); hz++) {
			for (let hx = Math.max(0, x0 - 2); hx <= Math.min(STEPS, x1 + 2); hx++) {
				const i = latticeIndex(hx, hz);
				if (i < 0) continue;
				const inside = hx >= x0 && hx <= x1 && hz >= z0 && hz <= z1;
				this.normalAt(hx, hz, normal);
				const h = this.current[i];
				for (let k = this.starts[i]; k < this.starts[i + 1]; k++) {
					const v = this.vertices[k];
					if (inside) p[v * 3 + 1] = h - this.drop[v];
					// Skirts keep pointing up.
					if (this.drop[v] === 0) {
						n[v * 3] = normal.x;
						n[v * 3 + 1] = normal.y;
						n[v * 3 + 2] = normal.z;
					}
				}
				if (!inside) continue;
				if (i < OUTER_COUNT) {
					this.targets.queryHeights[i] = h;
					if (this.targets.clutter) this.targets.clutter.outer[i] = h;
				} else if (this.targets.clutter) {
					this.targets.clutter.inner[i - OUTER_COUNT] = h;
				}
			}
		}
		this.positions.needsUpdate = true;
		this.normals.needsUpdate = true;
	}

	/** Recomputes the mesh's bounds once a stroke is done, so it's culled correctly. */
	finish(): void {
		this.targets.geometry.computeBoundingSphere();
		this.targets.geometry.computeBoundingBox();
	}

	/** Height at half-cell coordinates (clamped to the tile). */
	heightAt(hx: number, hz: number): number {
		const i = latticeIndex(hx, hz);
		return i >= 0 ? this.current[i] : NaN;
	}

	/**
	 * A point's normal, as the mesh's triangles around it make it: an outer point is fanned by
	 * its four neighbouring outer points and the four cell centres between them; an inner point
	 * (a cell centre) by its cell's four corners.
	 */
	private normalAt(hx: number, hz: number, out: THREE.Vector3): THREE.Vector3 {
		const ring = hx % 2 === 0
			? [[2, 0], [1, 1], [0, 2], [-1, 1], [-2, 0], [-1, -1], [0, -2], [1, -1]]
			: [[1, -1], [1, 1], [-1, 1], [-1, -1]];
		const h = this.current[latticeIndex(hx, hz)];
		let nx = 0, ny = 0, nz = 0;
		let prev: [number, number, number] | null = null;
		let first: [number, number, number] | null = null;
		for (const [dx, dz] of ring) {
			const i = latticeIndex(hx + dx, hz + dz);
			const q: [number, number, number] | null = i >= 0 ? [dx * HALF_CELL, this.current[i] - h, dz * HALF_CELL] : null;
			if (prev && q) {
				// (prev x q), z south: points up for a counter-clockwise turn seen from above.
				nx += prev[1] * q[2] - prev[2] * q[1];
				ny += prev[2] * q[0] - prev[0] * q[2];
				nz += prev[0] * q[1] - prev[1] * q[0];
			}
			first ??= q;
			prev = q;
		}
		if (prev && first) {
			nx += prev[1] * first[2] - prev[2] * first[1];
			ny += prev[2] * first[0] - prev[0] * first[2];
			nz += prev[0] * first[1] - prev[1] * first[0];
		}
		out.set(nx, ny, nz);
		if (out.y < 0) out.negate();
		return out.lengthSq() > 0 ? out.normalize() : out.set(0, 1, 0);
	}
}

/** A box of lattice points in half-cell coordinates: [x0, z0, x1, z1], inclusive. */
export type LatticeBox = [number, number, number, number];

/** The lattice points a world-space circle covers on a tile (clamped to it), as a box. */
export function latticeBox(tile: { originX: number; originZ: number }, x: number, z: number, radius: number): LatticeBox | null {
	const x0 = Math.max(0, Math.floor((x - radius - tile.originX) / HALF_CELL));
	const z0 = Math.max(0, Math.floor((z - radius - tile.originZ) / HALF_CELL));
	const x1 = Math.min(STEPS, Math.ceil((x + radius - tile.originX) / HALF_CELL));
	const z1 = Math.min(STEPS, Math.ceil((z + radius - tile.originZ) / HALF_CELL));
	return x0 > x1 || z0 > z1 ? null : [x0, z0, x1, z1];
}
