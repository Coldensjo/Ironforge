import * as THREE from 'three';
import type { SunLight } from 'three/addons/lights/SunLight.js';
import type { AsyncStorageApi } from '../worker/protocol';

/** The colour grading tables: 32 slices of 32x32 (red across, green down, blue by slice) side by side. */
const LUT_SIZE = 32;
const LUT_WIDTH = LUT_SIZE * LUT_SIZE;
const LUT_BYTES = LUT_WIDTH * LUT_SIZE * 4;
/** Weights are rounded to this before deciding whether the blend needs working out again. */
const WEIGHT_STEP = 1 / 256;

function identityTable(): Uint8Array {
	const data = new Uint8Array(LUT_BYTES);
	for (let y = 0; y < LUT_SIZE; y++) {
		for (let x = 0; x < LUT_WIDTH; x++) {
			const o = (y * LUT_WIDTH + x) * 4;
			data[o] = Math.round(((x % LUT_SIZE) * 255) / (LUT_SIZE - 1));
			data[o + 1] = Math.round((y * 255) / (LUT_SIZE - 1));
			data[o + 2] = Math.round((Math.floor(x / LUT_SIZE) * 255) / (LUT_SIZE - 1));
			data[o + 3] = 255;
		}
	}
	return data;
}

/**
 * The game's colour grading (LightData's ColorGradingFileDataID): a lookup table per light
 * keyframe that gives each zone and time of day its look. The tables in use are blended on the
 * CPU into one, as the light zones and keyframes are, and that one is applied to the frame.
 */
class ColorGrading {
	readonly texture: THREE.DataTexture;
	private readonly identity = identityTable();
	private readonly blended = new Float32Array(LUT_BYTES);
	/** Read tables by file ID; null while reading, or for good if it couldn't be read. */
	private readonly tables = new Map<number, Uint8Array | null>();
	private weights = new Map<number, number>();
	private key = '';

	constructor(private readonly storage: AsyncStorageApi) {
		this.texture = new THREE.DataTexture(this.identity.slice(), LUT_WIDTH, LUT_SIZE, THREE.RGBAFormat);
		this.texture.magFilter = THREE.LinearFilter;
		this.texture.minFilter = THREE.LinearFilter;
		this.texture.generateMipmaps = false;
		this.texture.needsUpdate = true;
	}

	/** Blends the tables by weight (file ID 0 = no grading); tables not read yet count as none. */
	set(weights: Map<number, number>): void {
		this.weights = weights;
		const missing = [...weights.keys()].filter((id) => id && !this.tables.has(id));
		if (missing.length) {
			for (const id of missing) this.tables.set(id, null);
			this.storage.loadTextures(missing, false).then((loaded) => {
				for (const { fdid, texture } of loaded) {
					const data = texture?.mips[0]?.data;
					const fits = texture?.format === 'rgba' && texture.width === LUT_WIDTH && texture.height === LUT_SIZE && data;
					this.tables.set(fdid, fits ? data : null);
				}
				this.key = '';
				this.set(this.weights);
			}, (e) => console.warn('Colour grading tables unavailable:', e));
		}

		const parts: [Uint8Array, number][] = [];
		let none = 0;
		for (const [id, weight] of weights) {
			const table = id ? this.tables.get(id) : null;
			if (table) parts.push([table, weight]);
			else none += weight;
		}
		if (none > 0 || !parts.length) parts.push([this.identity, none || 1]);
		const key = parts.map(([t, w]) => `${this.idOf(t)}:${Math.round(w / WEIGHT_STEP)}`).sort().join(',');
		if (key === this.key) return;
		this.key = key;

		const total = parts.reduce((s, [, w]) => s + w, 0);
		const out = this.blended.fill(0);
		for (const [table, weight] of parts) {
			const w = weight / total;
			for (let i = 0; i < LUT_BYTES; i++) out[i] += table[i] * w;
		}
		const data = this.texture.image.data as Uint8Array;
		for (let i = 0; i < LUT_BYTES; i++) data[i] = out[i] + 0.5;
		this.texture.needsUpdate = true;
	}

	private idOf(table: Uint8Array): number {
		if (table === this.identity) return 0;
		for (const [id, t] of this.tables) if (t === table) return id;
		return -1;
	}
}

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Yards of each view ray the height fog gathers over. */
const FOG_REACH = 1500;

/** Steps the sun-shaft march takes through the shadow map, per pixel. */
const SHAFT_STEPS = 24;

const FRAGMENT = /* glsl */ `
uniform sampler2D uScene;
uniform sampler2D uDepth;
uniform sampler2D uLut;
uniform float uGrading;
uniform float uFogOn;
uniform mat4 uInvProjection;
uniform mat4 uCameraWorld;
uniform vec3 uCameraPos;
uniform float uLogFar;
// The projection's depth terms, for a reversed depth buffer: view depth = y / (depth + x).
uniform vec2 uDepthDecode;
uniform float uFar;
uniform vec3 uFogColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
// x density at the base height (per yard), y falloff (per yard up), z base height, w sunlight in the fog.
uniform vec4 uFog;
#ifdef FOG_SHAFTS
	uniform sampler2DShadow uShadowMap;
	uniform mat4 uShadowMatrix[2];
	// x, y: view depth each cascade reaches.
	uniform vec2 uCascadeEnd;
#endif
varying vec2 vUv;

vec3 toSrgb(vec3 c) {
	c = clamp(c, 0.0, 1.0);
	return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// The table's two blue slices around the colour, each sampled bilinearly in red and green.
vec3 grade(vec3 c) {
	float b = c.b * ${(LUT_SIZE - 1).toFixed(1)};
	float b0 = floor(b);
	float b1 = min(b0 + 1.0, ${(LUT_SIZE - 1).toFixed(1)});
	vec2 uv = vec2((c.r * ${(LUT_SIZE - 1).toFixed(1)} + 0.5) / ${LUT_WIDTH.toFixed(1)}, (c.g * ${(LUT_SIZE - 1).toFixed(1)} + 0.5) / ${LUT_SIZE.toFixed(1)});
	vec3 s0 = texture2D(uLut, uv + vec2(b0 / ${LUT_SIZE.toFixed(1)}, 0.0)).rgb;
	vec3 s1 = texture2D(uLut, uv + vec2(b1 / ${LUT_SIZE.toFixed(1)}, 0.0)).rgb;
	return mix(s0, s1, b - b0);
}

// Fog thickness at a height: densest at the base (the lowest ground around), thinning upwards,
// and no denser below it (the sea floor, down through the water).
float fogDensity(float y) {
	return uFog.x * exp(clamp(-uFog.y * (y - uFog.z), -40.0, 0.0));
}

// Fog along the view ray from the camera to distance t (dir.y = dy), worked out exactly: the
// thinning part above the base, then even fog for any stretch below it.
float opticalDepth(float t, float dy) {
	float above = uCameraPos.y - uFog.z;
	if (above <= 0.0) return uFog.x * t;
	// Where a downward ray reaches the base.
	float toBase = dy < 0.0 ? above / -dy : 1e9;
	float upper = min(t, toBase);
	// The density at either end of the part above the base, relative to the base's: both at most 1,
	// so nothing overflows however high the camera is.
	float near = exp(-uFog.y * above);
	float far = exp(-uFog.y * max(uCameraPos.y + dy * upper - uFog.z, 0.0));
	float depth = abs(uFog.y * dy * upper) < 1e-3 ? uFog.x * near * upper : uFog.x * (near - far) / (uFog.y * dy);
	return depth + uFog.x * max(t - toBase, 0.0);
}

#ifdef FOG_SHAFTS
	// Whether the sun reaches a point, from the cascade covering its view depth.
	float sunReaches(vec3 p, float viewDepth) {
		if (viewDepth >= uCascadeEnd.y) return 1.0;
		int c = viewDepth < uCascadeEnd.x ? 0 : 1;
		vec4 s = uShadowMatrix[c] * vec4(p, 1.0);
		s.xyz /= s.w;
		// The atlas holds the cascades side by side; stay in this one's half.
		float left = float(c) * 0.5;
		if (s.x < left || s.x > left + 0.5 || s.y < 0.0 || s.y > 1.0) return 1.0;
		// Biased towards the sun, which is further up a reversed depth buffer and down a normal one.
		#ifdef USE_REVERSED_DEPTH_BUFFER
			if (s.z < 0.0) return 1.0;
			return texture(uShadowMap, vec3(s.xy, s.z + 0.001));
		#else
			if (s.z > 1.0) return 1.0;
			return texture(uShadowMap, vec3(s.xy, s.z - 0.001));
		#endif
	}
#endif

float noise(vec2 p) {
	return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
	vec3 color = texture2D(uScene, vUv).rgb;
	if (uFogOn > 0.5) {
		float depth = texture2D(uDepth, vUv).r;
		#ifdef USE_REVERSED_DEPTH_BUFFER
			// Reversed: 1 at the near plane, 0 at the far one (and where nothing was drawn).
			bool sky = depth <= 0.0;
		#else
			bool sky = depth >= 0.999999;
		#endif
		vec4 v = uInvProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
		vec3 viewDir = normalize(v.xyz / v.w);
		vec3 dir = normalize((uCameraWorld * vec4(viewDir, 0.0)).xyz);
		float forward = max(-viewDir.z, 1e-4);
		// Depth back to view depth, then to distance along the ray.
		#ifdef USE_REVERSED_DEPTH_BUFFER
			float viewDepth = uDepthDecode.y / (depth + uDepthDecode.x);
		#else
			float viewDepth = exp2(depth * uLogFar) - 1.0;
		#endif
		float dist = sky ? 20000.0 : viewDepth / forward;
		// The fog ends at the sea's surface (which writes no depth): below it is water, not air,
		// whether it's the sea floor or nothing at all.
		if (dir.y < 0.0 && uCameraPos.y > 0.0 && uCameraPos.y + dir.y * dist < 0.0) dist = uCameraPos.y / -dir.y;
		// Height fog is a local thing, gathering over the first stretch of view; past that the game's
		// own distance fog takes over. Without the limit, low views skim kilometres of it and white out.
		// (Eased in, so there's no visible edge where it stops.)
		float fogDist = ${FOG_REACH.toFixed(1)} * (1.0 - exp(-dist / ${FOG_REACH.toFixed(1)}));
		float transmit = exp(-opticalDepth(fogDist, dir.y));

		// Light scattered towards the eye: mostly the sky's fog colour, plus sunlight, strongest looking
		// towards the sun, and only where the sun reaches the fog.
		float cosSun = dot(dir, normalize(uSunDir));
		float phase = 0.25 + 3.0 * pow(max(cosSun, 0.0), 12.0);
		float sunlit = 1.0 - transmit;
		#ifdef FOG_SHAFTS
			float reach = min(dist, uCascadeEnd.y / forward);
			float stepLength = reach / ${SHAFT_STEPS}.0;
			float jitter = noise(gl_FragCoord.xy);
			float lit = 0.0;
			for (int i = 0; i < ${SHAFT_STEPS}; i++) {
				float t = (float(i) + jitter) * stepLength;
				vec3 p = uCameraPos + dir * t;
				lit += fogDensity(p.y) * exp(-opticalDepth(t, dir.y)) * sunReaches(p, t * forward) * stepLength;
			}
			// Past the shadow maps, all lit.
			sunlit = lit + max(exp(-opticalDepth(min(reach, fogDist), dir.y)) - transmit, 0.0);
		#endif
		color = color * transmit + uFogColor * (1.0 - transmit) * 0.75 + uSunColor * phase * sunlit * uFog.w;
	}
	color = toSrgb(color);
	if (uGrading > 0.5) color = grade(color);
	gl_FragColor = vec4(color, 1.0);
}
`;

/** The height fog's look, set from the light zones each update. */
export interface FogSettings {
	/** Fog colour (the game's sky fog colour) and the sun's or moon's, linear. */
	color: THREE.Color;
	sunColor: THREE.Color;
	/** Towards the light. */
	sunDir: THREE.Vector3;
	/** Per yard at the base height. */
	density: number;
	/** Per yard of height: how fast it thins upwards. */
	falloff: number;
	/** World height (y) the fog is densest at. */
	base: number;
	/** How strongly sunlight lights the fog (0 for none). */
	sunlight: number;
}

/**
 * Draws the scene into an off-screen, multisampled target, then onto the screen through a
 * full-screen pass that does what has to see the whole frame: the colour grading.
 */
export class PostPass {
	readonly grading: ColorGrading;
	private readonly target: THREE.WebGLRenderTarget;
	private readonly quad: THREE.Mesh;
	private readonly quadScene = new THREE.Scene();
	/** Unused by the full-screen shader, but three needs a camera it can update for a reversed depth buffer. */
	private readonly quadCamera = new THREE.OrthographicCamera();
	private readonly size = new THREE.Vector2();
	private readonly uniforms = {
		uScene: { value: null as THREE.Texture | null },
		uLut: { value: null as THREE.Texture | null },
		uGrading: { value: 1 },
		uDepth: { value: null as THREE.Texture | null },
		uFogOn: { value: 1 },
		uInvProjection: { value: new THREE.Matrix4() },
		uCameraWorld: { value: new THREE.Matrix4() },
		uCameraPos: { value: new THREE.Vector3() },
		uLogFar: { value: 1 },
		uDepthDecode: { value: new THREE.Vector2() },
		uFar: { value: 1 },
		uFogColor: { value: new THREE.Color() },
		uSunColor: { value: new THREE.Color() },
		uSunDir: { value: new THREE.Vector3(0, 1, 0) },
		uFog: { value: new THREE.Vector4(0, 0.02, 0, 0) },
		uShadowMap: { value: null as THREE.Texture | null },
		uShadowMatrix: { value: [new THREE.Matrix4(), new THREE.Matrix4()] },
		uCascadeEnd: { value: new THREE.Vector2() },
	};
	private readonly material: THREE.ShaderMaterial;
	/** Whether the fog is drawn at all (the setting), and whether it's wanted now (not under water). */
	private fogEnabled = true;
	private fogWanted = true;
	private sun: SunLight | null = null;

	constructor(renderer: THREE.WebGLRenderer, storage: AsyncStorageApi) {
		this.grading = new ColorGrading(storage);
		this.target = new THREE.WebGLRenderTarget(1, 1, {
			type: THREE.HalfFloatType,
			samples: Math.min(4, renderer.capabilities.maxSamples),
			depthBuffer: true,
			// Float depth: what a reversed depth buffer needs to be precise from near to far.
			depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
		});
		this.uniforms.uScene.value = this.target.texture;
		this.uniforms.uDepth.value = this.target.depthTexture;
		this.uniforms.uLut.value = this.grading.texture;
		const material = (this.material = new THREE.ShaderMaterial({
			uniforms: this.uniforms,
			vertexShader: VERTEX,
			fragmentShader: FRAGMENT,
			depthTest: false,
			depthWrite: false,
		}));
		this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
		this.quad.frustumCulled = false;
		this.quadScene.add(this.quad);
	}

	/** The frame's depth, once drawn (read by the selection outline). */
	get depthTexture(): THREE.DepthTexture {
		return this.target.depthTexture!;
	}

	/** Whether the game's colour grading is applied. */
	get gradingOn(): boolean {
		return this.uniforms.uGrading.value > 0.5;
	}

	set gradingOn(on: boolean) {
		this.uniforms.uGrading.value = on ? 1 : 0;
	}

	/** Whether there's height fog and sun shafts (the setting). */
	get fogOn(): boolean {
		return this.fogEnabled;
	}

	set fogOn(on: boolean) {
		this.fogEnabled = on;
	}

	/** The fog's look for now; null when there's to be none (under water, where the view has its own). */
	setFog(fog: FogSettings | null): void {
		this.fogWanted = fog !== null;
		if (!fog) return;
		const u = this.uniforms;
		u.uFogColor.value.copy(fog.color);
		u.uSunColor.value.copy(fog.sunColor);
		u.uSunDir.value.copy(fog.sunDir);
		u.uFog.value.set(fog.density, fog.falloff, fog.base, fog.sunlight);
	}

	/** The light whose shadow map the sun shafts are traced through, or null for none. */
	setShadowLight(sun: SunLight | null): void {
		this.sun = sun;
	}

	/**
	 * renderer.compileAsync for objects drawn through this pass. A shader is built for the target
	 * it draws into (the screen's sRGB and tone mapping, or this target's linear colour), so it
	 * must be warmed with this target set; warmed for the screen, the real one is compiled anyway
	 * on first draw, stalling that frame. shadowPass: the object's materials are depth materials
	 * for the shadow maps, which three draws without the scene's fog.
	 */
	async compileAsync(renderer: THREE.WebGLRenderer, object: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene, shadowPass = false): Promise<void> {
		const previous = renderer.getRenderTarget();
		const fog = scene.fog;
		renderer.setRenderTarget(this.target);
		if (shadowPass) scene.fog = null;
		let compiled: Promise<unknown>;
		try {
			// The programs are created here, synchronously; only the wait for them is async.
			compiled = renderer.compileAsync(object, camera, scene);
		} finally {
			renderer.setRenderTarget(previous);
			scene.fog = fog;
		}
		await compiled;
		// A program's first use reads back its link status and uniforms: a round trip to the
		// GPU process that waits for all the drawing queued before it, tens of ms mid-frame.
		// Done now, between frames, there's less queued for it to wait on.
		const materials = new Set<THREE.Material>();
		object.traverse((o) => {
			const material = (o as THREE.Mesh).material;
			if (material) for (const m of Array.isArray(material) ? material : [material]) materials.add(m);
		});
		for (const material of materials) {
			const program = (renderer.properties.get(material) as { currentProgram?: { getUniforms(): unknown } }).currentProgram;
			program?.getUniforms();
		}
	}

	render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
		const u = this.uniforms;
		u.uFogOn.value = this.fogEnabled && this.fogWanted ? 1 : 0;
		u.uCameraWorld.value.copy(camera.matrixWorld);
		u.uCameraPos.value.setFromMatrixPosition(camera.matrixWorld);
		u.uLogFar.value = Math.log2(camera.far + 1);
		u.uFar.value = camera.far;
		// Sun shafts need the shadow map, which only exists once a shadow pass has drawn it.
		const shadow = this.sun?.castShadow ? this.sun.shadow : null;
		const shafts = !!shadow?.map?.depthTexture && u.uFogOn.value > 0;
		if (shadow && shafts) {
			u.uShadowMap.value = shadow.map!.depthTexture;
			u.uShadowMatrix.value[0].copy(shadow.getMatrix(0));
			u.uShadowMatrix.value[1].copy(shadow.getMatrix(1));
			const cascades = (shadow as unknown as { _cascadeData: THREE.Vector4[] })._cascadeData;
			u.uCascadeEnd.value.set(cascades[0].y, cascades[1].y);
		}
		if (shafts !== 'FOG_SHAFTS' in this.material.defines) {
			this.material.defines = shafts ? { FOG_SHAFTS: '' } : {};
			this.material.needsUpdate = true;
		}

		renderer.getDrawingBufferSize(this.size);
		if (this.target.width !== this.size.x || this.target.height !== this.size.y) this.target.setSize(this.size.x, this.size.y);
		renderer.setRenderTarget(this.target);
		renderer.render(scene, camera);
		renderer.setRenderTarget(null);
		// After drawing: three turns the camera's projection to a reversed depth buffer's when it first draws with it.
		const p = camera.projectionMatrix.elements;
		u.uDepthDecode.value.set(p[10], p[14]);
		u.uInvProjection.value.copy(camera.projectionMatrixInverse);
		renderer.render(this.quadScene, this.quadCamera);
	}
}
