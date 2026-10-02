import { signal } from '@preact/signals';
import * as THREE from 'three';
import { HALF_CELL, latticeBox, latticeIndex, type HeightTile } from '../viewer/terrainEdit';
import type { EditDocument, TerrainPatch } from './document';

export type BrushKind = 'raise' | 'lower' | 'flatten' | 'smooth';

/** What the brush needs from the viewer: the detailed ground under it. */
export interface SculptHost {
	scene: THREE.Scene;
	/** The detailed tiles whose ground lies in a box of the world (x, z). */
	heightTilesIn(minX: number, minZ: number, maxX: number, maxZ: number): HeightTile[];
	/** After a stroke: a tile's bounds and its ground clutter catch up. */
	heightsChanged(tile: HeightTile): void;
}

/** Yards per second raise and lower move the ground at full strength, at the brush's middle. */
const MAX_LIFT = 30;
/** How quickly flatten and smooth close the gap at full strength (share per second, roughly). */
const MAX_BLEND = 12;
/** Points on the brush circle. */
const RING_POINTS = 72;

/**
 * Lattice neighbours a point is smoothed towards: for an outer point the four outer points
 * round it and the four cell centres between; for a cell centre its four corners.
 */
const OUTER_NEIGHBOURS = [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const INNER_NEIGHBOURS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

interface Stroke {
	/** Per tile: the points touched, with their height change from before the stroke. */
	touched: Map<HeightTile, Map<number, number>>;
	/** Flatten: the height it levels to (the ground under the brush when the stroke began). */
	level: number;
	last: number;
}

/**
 * The terrain brushes: raise, lower, flatten and smooth, over a circle with a soft edge. While
 * the button is held, each frame moves the ground under the brush (the tile's heights and its
 * saved changes at once); letting go records the stroke as one step.
 */
export class TerrainBrush {
	readonly kind = signal<BrushKind>('raise');
	/** Radius, yards. */
	readonly size = signal(10);
	/** 0-1. */
	readonly strength = signal(0.4);
	/** Share of the radius that fades out towards the edge, 0 (hard) to 1 (all of it). */
	readonly softness = signal(0.6);

	private stroke: Stroke | null = null;
	private readonly outer: THREE.LineLoop;
	private readonly inner: THREE.LineLoop;

	constructor(private readonly host: SculptHost, private readonly doc: EditDocument) {
		const ring = (color: number, opacity: number) => {
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RING_POINTS * 3), 3));
			const line = new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, fog: false }));
			line.renderOrder = 11;
			line.frustumCulled = false;
			line.visible = false;
			host.scene.add(line);
			return line;
		};
		this.outer = ring(0xffd100, 0.95);
		this.inner = ring(0xffd100, 0.45);
	}

	get active(): boolean {
		return this.stroke !== null;
	}

	/**
	 * Call every frame: draws the brush where the mouse meets the ground (center, or null for
	 * nowhere) and, mid-stroke, works the ground there. invert swaps raise and lower (Shift).
	 */
	update(center: THREE.Vector3 | null, groundAt: (x: number, z: number) => number, invert: boolean): void {
		const shown = center !== null;
		this.outer.visible = this.inner.visible = shown;
		if (!center) return;
		const r = this.size.value;
		this.drawRing(this.outer, center, r, groundAt);
		this.drawRing(this.inner, center, r * (1 - this.softness.value), groundAt);
		const color = this.kind.value === 'lower' !== invert ? 0x7fb2ff : 0xffd100;
		(this.outer.material as THREE.LineBasicMaterial).color.setHex(color);
		(this.inner.material as THREE.LineBasicMaterial).color.setHex(color);
		const stroke = this.stroke;
		if (!stroke) return;
		const now = performance.now();
		const dt = Math.min(0.1, (now - stroke.last) / 1000);
		stroke.last = now;
		if (dt > 0) this.apply(stroke, center, dt, invert);
	}

	/** Starts a stroke under the brush. */
	start(center: THREE.Vector3): void {
		this.stroke = { touched: new Map(), level: center.y, last: performance.now() };
	}

	/** Ends the stroke: one undoable step with every point it moved. */
	end(): void {
		const stroke = this.stroke;
		if (!stroke) return;
		this.stroke = null;
		const patches: TerrainPatch[] = [];
		for (const [tile, points] of stroke.touched) {
			const delta = this.doc.heightDelta(tile.key, true)!;
			const list = Uint32Array.from(points.keys());
			patches.push({ tile: tile.key, points: list, before: Float32Array.from(points.values()), after: Float32Array.from(list, (p) => delta[p]) });
			this.host.heightsChanged(tile);
		}
		this.doc.commitTerrain(patches);
	}

	/** Drops a stroke unfinished, putting the ground back as it was before it. */
	cancel(): void {
		const stroke = this.stroke;
		if (!stroke) return;
		this.stroke = null;
		for (const [tile, points] of stroke.touched) {
			const delta = this.doc.heightDelta(tile.key, true)!;
			for (const [p, before] of points) {
				delta[p] = before;
				tile.current[p] = tile.original[p] + before;
			}
			tile.update();
			this.host.heightsChanged(tile);
		}
	}

	/** One frame of the brush: every lattice point inside it moved by the brush's rule. */
	private apply(stroke: Stroke, center: THREE.Vector3, dt: number, invert: boolean): void {
		const r = this.size.value;
		const strength = this.strength.value;
		const kind = this.kind.value === 'raise' || this.kind.value === 'lower'
			? (this.kind.value === 'raise') !== invert ? 'raise' : 'lower'
			: this.kind.value;
		const lift = MAX_LIFT * strength * strength * dt;
		const blend = MAX_BLEND * strength * dt;
		const hard = r * (1 - this.softness.value);
		for (const tile of this.host.heightTilesIn(center.x - r, center.z - r, center.x + r, center.z + r)) {
			const box = latticeBox(tile, center.x, center.z, r);
			if (!box) continue;
			const delta = this.doc.heightDelta(tile.key, true)!;
			let touched = stroke.touched.get(tile);
			if (!touched) {
				touched = new Map();
				stroke.touched.set(tile, touched);
			}
			// New heights first, then written: smoothing reads its neighbours as they were.
			const changes: [number, number][] = [];
			const [x0, z0, x1, z1] = box;
			for (let hz = z0; hz <= z1; hz++) {
				for (let hx = x0; hx <= x1; hx++) {
					const i = latticeIndex(hx, hz);
					if (i < 0) continue;
					const d = Math.hypot(tile.originX + hx * HALF_CELL - center.x, tile.originZ + hz * HALF_CELL - center.z);
					if (d > r) continue;
					// Full inside the hard part, easing to nothing at the edge.
					const t = d <= hard ? 0 : (d - hard) / (r - hard);
					const f = 1 - t * t * (3 - 2 * t);
					const h = tile.current[i];
					let next = h;
					if (kind === 'raise') next = h + lift * f;
					else if (kind === 'lower') next = h - lift * f;
					else if (kind === 'flatten') next = h + (stroke.level - h) * Math.min(1, blend * f);
					else {
						let sum = 0, n = 0;
						for (const [dx, dz] of hx % 2 === 0 ? OUTER_NEIGHBOURS : INNER_NEIGHBOURS) {
							const v = tile.heightAt(hx + dx, hz + dz);
							if (Number.isNaN(v)) continue;
							sum += v;
							n++;
						}
						if (n) next = h + (sum / n - h) * Math.min(1, blend * f);
					}
					if (next !== h) changes.push([i, next]);
				}
			}
			for (const [i, h] of changes) {
				if (!touched.has(i)) touched.set(i, delta[i]);
				tile.current[i] = h;
				delta[i] = h - tile.original[i];
			}
			if (changes.length) tile.update(box);
		}
	}

	private drawRing(line: THREE.LineLoop, center: THREE.Vector3, radius: number, groundAt: (x: number, z: number) => number): void {
		const position = line.geometry.getAttribute('position') as THREE.BufferAttribute;
		for (let k = 0; k < RING_POINTS; k++) {
			const a = (k / RING_POINTS) * Math.PI * 2;
			const x = center.x + Math.cos(a) * radius;
			const z = center.z + Math.sin(a) * radius;
			const y = groundAt(x, z);
			position.setXYZ(k, x, (Number.isFinite(y) ? y : center.y) + 0.2, z);
		}
		position.needsUpdate = true;
	}
}
