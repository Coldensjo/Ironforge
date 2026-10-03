import * as THREE from 'three';

/** Points on each circle. */
const RING_POINTS = 72;

/**
 * A terrain brush's outline on the ground: its edge, and an inner circle where its soft edge
 * begins. Drawn over everything, following the ground's shape.
 */
export class BrushRing {
	private readonly outer: THREE.LineLoop;
	private readonly inner: THREE.LineLoop;

	constructor(scene: THREE.Scene) {
		const ring = (opacity: number) => {
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RING_POINTS * 3), 3));
			const line = new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color: 0xffd100, transparent: true, opacity, depthTest: false, depthWrite: false, fog: false }));
			line.renderOrder = 11;
			line.frustumCulled = false;
			line.visible = false;
			scene.add(line);
			return line;
		};
		this.outer = ring(0.95);
		this.inner = ring(0.45);
	}

	/** Draws it round a point (radius in yards; softness the share that fades), or hides it for null. */
	show(center: THREE.Vector3 | null, radius: number, softness: number, color: number, groundAt: (x: number, z: number) => number): void {
		this.outer.visible = this.inner.visible = center !== null;
		if (!center) return;
		this.draw(this.outer, center, radius, groundAt);
		this.draw(this.inner, center, radius * (1 - softness), groundAt);
		(this.outer.material as THREE.LineBasicMaterial).color.setHex(color);
		(this.inner.material as THREE.LineBasicMaterial).color.setHex(color);
	}

	private draw(line: THREE.LineLoop, center: THREE.Vector3, radius: number, groundAt: (x: number, z: number) => number): void {
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

/** How much of a brush's effect reaches a point d yards from its middle: full inside, easing to nothing at the edge. */
export function falloff(d: number, radius: number, softness: number): number {
	if (d > radius) return 0;
	const hard = radius * (1 - softness);
	const t = d <= hard ? 0 : (d - hard) / (radius - hard);
	return 1 - t * t * (3 - 2 * t);
}
