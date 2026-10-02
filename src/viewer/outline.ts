import * as THREE from 'three';
import { applyModelAnimation, type CopyUniforms, type SkinUniforms } from './modelMaterials';
import type { ModelShape, ObjectManager } from './objects';
import type { ObjectKind } from '../explorer/objects';

/** CSS pixels the stroke reaches out from the shape. */
const WIDTH = 2;
/** Faint yellow, as the selection circles; red where it's sunk into the ground or another model. */
const COLOR = new THREE.Vector4(1, 0.82, 0, 0.6);
const BURIED_COLOR = new THREE.Vector4(1, 0.15, 0.1, 0.75);
/** Directions sampled around each pixel for the shape's edge. */
const TAPS = 16;
/** Yards: something in front of a selection circle this close counts as burying it. */
const RING_REACH = 3;
/**
 * Radians either side of the circle's local +x (turned to face the camera's right) that are its
 * resize handle, drawn orange.
 */
export const RING_HANDLE_ARC = THREE.MathUtils.degToRad(22);

/** A placed thing to outline, as the object manager knows it. */
export interface OutlineTarget {
	wdt: number;
	kind: ObjectKind;
	uid: number;
}

/**
 * The frame's own depth at this pixel as view depth (yards from the camera), and whether a
 * fragment is buried: covered by something else only a little in front of it (closer than
 * reach), as when it's sunk into the ground or into another model. Something well in front,
 * a wall between it and the camera, doesn't count.
 */
const DEPTH_PARS = /* glsl */ `
uniform sampler2D uSceneDepth;
// The projection's depth terms, for a reversed depth buffer: view depth = y / (depth + x).
uniform vec2 uDepthDecode;
uniform float uLogFar;
float sceneViewDepth() {
	float depth = texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy), 0).r;
	#ifdef USE_REVERSED_DEPTH_BUFFER
		if (depth <= 0.0) return 1e9;
		return uDepthDecode.y / (depth + uDepthDecode.x);
	#else
		if (depth >= 0.999999) return 1e9;
		return exp2(depth * uLogFar) - 1.0;
	#endif
}
bool buriedAt(float own, float scene, float reach) {
	float gap = own - scene;
	return gap > 0.03 + own * 0.002 && gap < reach;
}
`;

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Outside the shape, near enough its edge: the stroke, red where the edge it follows is buried.
// Inside it stays as drawn.
const STROKE_FRAGMENT = /* glsl */ `
uniform sampler2D uMask;
uniform vec2 uTexel;
uniform float uWidth;
uniform vec4 uColor;
uniform vec4 uBuriedColor;
varying vec2 vUv;
void main() {
	if (texture2D(uMask, vUv).r > 0.5) discard;
	float covered = 0.0;
	float buried = 0.0;
	for (int i = 0; i < ${TAPS}; i++) {
		float a = float(i) * ${(Math.PI * 2 / TAPS).toFixed(6)};
		vec2 d = vec2(cos(a), sin(a)) * uWidth * uTexel;
		for (int r = 1; r <= 2; r++) {
			vec4 m = texture2D(uMask, vUv + d * float(r) * 0.5);
			float c = step(0.5, m.r);
			covered += c;
			buried += c * step(0.5, m.g);
		}
	}
	if (covered < 0.5) discard;
	gl_FragColor = buried / covered > 0.5 ? uBuriedColor : uColor;
}
`;

const RING_VERTEX = /* glsl */ `
// Across the flat circle: local x, and the circle's own y before it was laid down (-z).
varying vec2 vAcross;
void main() {
	vAcross = vec2(position.x, -position.z);
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Red where the ground or another model covers the circle; the selected model itself standing
// in front of it (the mask's nearest depth is the frame's) doesn't count.
const RING_FRAGMENT = /* glsl */ `
${DEPTH_PARS}
uniform sampler2D uMask;
uniform vec4 uColor;
uniform vec4 uBuriedColor;
uniform vec4 uHandleColor;
varying vec2 vAcross;
void main() {
	if (abs(atan(vAcross.y, vAcross.x)) < ${RING_HANDLE_ARC.toFixed(6)}) {
		gl_FragColor = uHandleColor;
		return;
	}
	float own = 1.0 / gl_FragCoord.w;
	float scene = sceneViewDepth();
	vec4 mask = texelFetch(uMask, ivec2(gl_FragCoord.xy), 0);
	bool itself = mask.r > 0.5 && abs(scene - mask.b) < 0.05 + scene * 0.004;
	gl_FragColor = !itself && buriedAt(own, scene, ${RING_REACH.toFixed(1)}) ? uBuriedColor : uColor;
}
`;

interface Drawn {
	mesh: THREE.Mesh;
	/** The model's own materials the mask's were made from. */
	source: THREE.Material[];
	copy: CopyUniforms;
	reach: THREE.IUniform<number>;
}

/**
 * A faint stroke around the editor's selection, drawn over the finished frame, and the
 * selection circles. The selected models are drawn again on their own as a mask, which also
 * notes which of their pixels are buried (see DEPTH_PARS), and the pixels just outside it are
 * coloured, red along buried parts. The stroke shows through what stands well in front, so a
 * selection behind a wall can still be seen.
 */
export class SelectionOutline {
	/** What to outline; set every frame or whenever it changes. */
	targets: OutlineTarget[] = [];
	/** Drawn over the frame after the stroke, with ringMaterial able to tell buried parts: the selection circles. */
	readonly overlay = new THREE.Scene();
	readonly ringMaterial: THREE.ShaderMaterial;

	/** Covered (r), buried (g), the nearest selected surface's view depth (b). */
	private readonly mask = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
	private readonly maskScene = new THREE.Scene();
	private readonly drawn = new Map<string, Drawn>();
	private readonly quadScene = new THREE.Scene();
	/** Unused by the full-screen shader, but three needs a camera it can update for a reversed depth buffer. */
	private readonly quadCamera = new THREE.OrthographicCamera();
	private readonly depthUniforms = {
		uSceneDepth: { value: null as THREE.Texture | null },
		uDepthDecode: { value: new THREE.Vector2() },
		uLogFar: { value: 1 },
	};
	private readonly strokeUniforms = {
		uMask: { value: this.mask.texture },
		uTexel: { value: new THREE.Vector2() },
		uWidth: { value: WIDTH },
		uColor: { value: COLOR },
		uBuriedColor: { value: BURIED_COLOR },
	};
	private readonly size = new THREE.Vector2();
	private readonly clearColor = new THREE.Color();

	constructor(private readonly objects: ObjectManager, sceneDepth: THREE.Texture) {
		this.depthUniforms.uSceneDepth.value = sceneDepth;
		const stroke = new THREE.ShaderMaterial({
			vertexShader: QUAD_VERTEX,
			fragmentShader: STROKE_FRAGMENT,
			uniforms: this.strokeUniforms,
			transparent: true,
			depthTest: false,
			depthWrite: false,
		});
		const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), stroke);
		quad.frustumCulled = false;
		this.quadScene.add(quad);
		this.ringMaterial = new THREE.ShaderMaterial({
			vertexShader: RING_VERTEX,
			fragmentShader: RING_FRAGMENT,
			uniforms: {
				...this.depthUniforms,
				uMask: this.strokeUniforms.uMask,
				uColor: { value: new THREE.Vector4(1, 0.82, 0, 0.85) },
				uBuriedColor: { value: new THREE.Vector4(1, 0.15, 0.1, 0.85) },
				uHandleColor: { value: new THREE.Vector4(1, 0.5, 0.05, 0.95) },
			},
			transparent: true,
			depthTest: false,
			depthWrite: false,
			side: THREE.DoubleSide,
		});
	}

	/** Draws the stroke and the circles onto the screen; call after the frame is drawn. */
	render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
		this.sync(this.targets.flatMap((t) => this.objects.shapeOf(t.wdt, t.kind, t.uid)));
		const rings = this.overlay.children.some((c) => c.visible);
		if (!this.drawn.size && !rings) return;
		renderer.getDrawingBufferSize(this.size);
		if (this.mask.width !== this.size.x || this.mask.height !== this.size.y) this.mask.setSize(this.size.x, this.size.y);
		// After the frame: three has turned the camera's projection to a reversed depth buffer's.
		const p = camera.projectionMatrix.elements;
		this.depthUniforms.uDepthDecode.value.set(p[10], p[14]);
		this.depthUniforms.uLogFar.value = Math.log2(camera.far + 1);
		const autoClear = renderer.autoClear;
		const clearAlpha = renderer.getClearAlpha();
		renderer.getClearColor(this.clearColor);
		renderer.setRenderTarget(this.mask);
		renderer.setClearColor(0x000000, 0);
		renderer.clear(true, true, false);
		renderer.autoClear = false;
		renderer.render(this.maskScene, camera);
		renderer.setRenderTarget(null);
		if (this.drawn.size) {
			this.strokeUniforms.uTexel.value.set(1 / this.size.x, 1 / this.size.y);
			this.strokeUniforms.uWidth.value = WIDTH * renderer.getPixelRatio();
			renderer.render(this.quadScene, this.quadCamera);
		}
		if (rings) renderer.render(this.overlay, camera);
		renderer.autoClear = autoClear;
		renderer.setClearColor(this.clearColor, clearAlpha);
	}

	/** One mesh per model shown; made again when the model is (reloaded, or another look). */
	private sync(shapes: ModelShape[]): void {
		const wanted = new Set<string>();
		for (const shape of shapes) {
			wanted.add(shape.key);
			let drawn = this.drawn.get(shape.key);
			if (drawn && (drawn.mesh.geometry !== shape.geometry || drawn.source !== shape.materials)) {
				this.drop(shape.key);
				drawn = undefined;
			}
			if (!drawn) {
				const copy: CopyUniforms = { instancePhase: { value: 0 }, instanceAnim: { value: 0 } };
				const reach = { value: 1 };
				// The model's geometry is shared, not copied: freeing a copy would free its buffers too.
				const mesh = new THREE.Mesh(shape.geometry, shape.materials.map((m) => this.maskMaterial(m, shape.skin, copy, reach)));
				mesh.matrixAutoUpdate = false;
				mesh.frustumCulled = false;
				this.maskScene.add(mesh);
				drawn = { mesh, source: shape.materials, copy, reach };
				this.drawn.set(shape.key, drawn);
			}
			drawn.mesh.matrix.copy(shape.matrix);
			drawn.mesh.matrixWorldNeedsUpdate = true;
			drawn.copy.instancePhase.value = shape.phase;
			drawn.copy.instanceAnim.value = shape.walking ? 1 : 0;
			// Anything closer in front than the model is big counts as burying it.
			const e = shape.matrix.elements;
			drawn.reach.value = Math.max(1, shape.radius * Math.hypot(e[0], e[1], e[2]));
		}
		for (const key of [...this.drawn.keys()]) if (!wanted.has(key)) this.drop(key);
	}

	/**
	 * A batch drawn into the mask: cut-outs (leaves, railings) keep their holes; glows and other
	 * blended batches aren't part of the shape. copy: the one copy's point in its loop, when skinned.
	 */
	private maskMaterial(source: THREE.Material, skin: SkinUniforms | null, copy: CopyUniforms, reach: THREE.IUniform<number>): THREE.MeshBasicMaterial {
		const cutOut = source.alphaTest > 0 || source.transparent;
		const material = new THREE.MeshBasicMaterial({
			color: 0xffffff,
			map: cutOut ? (source as THREE.MeshBasicMaterial).map ?? null : null,
			alphaTest: cutOut ? 0.5 : 0,
			side: source.side,
			fog: false,
		});
		material.visible = source.blending === THREE.NormalBlending;
		if (skin) applyModelAnimation(material, skin, null, copy);
		const animate = material.onBeforeCompile;
		material.onBeforeCompile = (shader, renderer) => {
			animate.call(material, shader, renderer);
			Object.assign(shader.uniforms, this.depthUniforms, { uReach: reach });
			shader.fragmentShader = shader.fragmentShader
				.replace('#include <common>', `#include <common>\n${DEPTH_PARS}\nuniform float uReach;`)
				.replace('#include <dithering_fragment>', /* glsl */ `#include <dithering_fragment>
					float own = 1.0 / gl_FragCoord.w;
					gl_FragColor = vec4(1.0, buriedAt(own, sceneViewDepth(), uReach) ? 1.0 : 0.0, own, 1.0);`);
		};
		material.customProgramCacheKey = () => `outline-mask-${skin ? 1 : 0}`;
		return material;
	}

	private drop(key: string): void {
		const drawn = this.drawn.get(key);
		if (!drawn) return;
		this.maskScene.remove(drawn.mesh);
		for (const m of drawn.mesh.material as THREE.Material[]) m.dispose();
		this.drawn.delete(key);
	}
}
