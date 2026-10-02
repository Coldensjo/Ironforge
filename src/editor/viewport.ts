import { signal } from '@preact/signals';
import * as THREE from 'three';
import { TILE_SIZE } from '../formats/adt';
import type { Placement } from '../explorer/objects';
import { spawnKind, type SpawnInfo } from '../explorer/spawns';
import { bindKeys, workspace } from '../app/input';
import type { ObjectManager } from '../viewer/objects';
import { RING_HANDLE_ARC, type SelectionOutline } from '../viewer/outline';
import type { ContinentPlacement } from '../viewer/terrain';
import { spawnId, type EditDocument, type SpawnEdit } from './document';
import { TerrainBrush, type BrushKind, type SculptHost } from './sculpt';

const MAP_ORIGIN = 32 * TILE_SIZE;
/** Pixels the mouse moves with a button down before a click becomes a drag. */
const DRAG_THRESHOLD = 4;
/** Yards; how far along the mouse's ray to look for things and for the ground. */
const PICK_DISTANCE = 1200;
/** Yards; the map's own props further than this can't be picked (there are a great many). */
const PROP_RANGE = 250;
/** Degrees a wheel step turns what's held; with Shift, a fine step. */
const TURN_STEP = 15;
const FINE_TURN_STEP = 1;
/** Yards Page Up / Page Down move the selection; with Shift, a bigger step. */
const RAISE_STEP = 0.1;
const BIG_RAISE_STEP = 1;
/** Radians per pixel of a rotate drag, and the scale factor's rate per pixel of a scale drag. */
const ROTATE_RATE = 0.01;
const SCALE_RATE = 0.006;
/** Yards: the largest selection circle. */
const MAX_RING = 3;
/** Most selection circles drawn at once. */
const MAX_RINGS = 200;

/**
 * World axes (x north, y west, z up) -> continent space (x east, y up, z south), as a rotation;
 * its inverse takes a placed model's rotation back to world axes (see spawnMatrix).
 */
const WORLD_TO_CONTINENT = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(
	0, -1, 0, 0,
	0, 0, 1, 0,
	-1, 0, 0, 0,
	0, 0, 0, 1,
));
const CONTINENT_TO_WORLD = WORLD_TO_CONTINENT.clone().invert();

export type Tool = 'select' | 'move' | 'rotate' | 'scale' | 'place' | 'sculpt';

/**
 * Something chosen in the palette, to put down where clicked: an NPC or game object template
 * (entry), or one of the game's map models, a prop or a building (entry: its file).
 */
export interface Stamp {
	type: 'npc' | 'object' | 'm2' | 'wmo';
	entry: number;
	name: string;
}

/** What the viewport needs from the viewer. */
export interface EditorHost extends SculptHost {
	/** Shows a tile's ground height changes again (if the tile is loaded in detail). */
	refreshTerrain(tile: string): void;
	canvas: HTMLCanvasElement;
	camera: THREE.PerspectiveCamera;
	scene: THREE.Scene;
	objects: ObjectManager;
	/** The stroke around the selection, and the overlay the selection circles are drawn in. */
	outline: SelectionOutline;
	mapPlacement(mapId: number): ContinentPlacement | null;
	/** The map at a point of the world (x, z), or with a WDT file ID; null over the open sea. */
	mapAt(x: number, z: number): ContinentPlacement | null;
	mapOfWdt(wdt: number): ContinentPlacement | null;
	/** Ground height (-Infinity in a hole), in world space. */
	heightAt(x: number, z: number): number;
	/** A new spawn of a creature or game object template (from the worker). */
	templateSpawn(type: 'npc' | 'object', entry: number, mapId: number, guid: number): Promise<SpawnInfo | null>;
	/** Captures the mouse for looking around; whether it's captured. */
	lockLook(): void;
	readonly looking: boolean;
	/** Flies the camera to look at a point from a distance. */
	focus(point: THREE.Vector3, distance: number): void;
}

/** Spawns being moved: as each was when the move started, and the edit each had. */
interface Held {
	/** now: where it's shown at the moment, for carrying on from there when snapping starts or stops. */
	items: { id: string; start: SpawnInfo; before: SpawnEdit | undefined; now?: SpawnInfo }[];
	/** The one under the mouse, which the others keep their places around. */
	anchor: SpawnInfo;
	/** 'drag' while the button is held; 'carry' follows the mouse until a click (copies, stamps). */
	mode: 'drag' | 'carry';
	/** Raised or lowered by Shift+drag, yards. */
	lift: number;
	/** Turned by the wheel, radians. */
	turn: number;
	/**
	 * For a drag: the ground under the mouse when it was grabbed (world space). What's held moves
	 * as far as the mouse does from there, rather than jumping to put its feet under the mouse.
	 */
	grab?: THREE.Vector3;
	/** Shift held: its feet go onto whatever is under the mouse, the ground or the top of another thing. */
	snap?: boolean;
}

/** A rotate or scale drag: how far the mouse has gone since the button went down. */
interface Adjust {
	/** handle: the selection circle's orange handle, dragged out from its centre or in towards it. */
	kind: 'rotate' | 'scale' | 'handle';
	items: { id: string; start: SpawnInfo; before: SpawnEdit | undefined }[];
	/** Pixels for rotate and scale; for the handle, yards from the circle's centre. */
	from: number;
	/** The handle's circle's centre, world space. */
	center?: THREE.Vector3;
}

/** A selection circle under the mouse. */
interface RingHit {
	spawn: SpawnInfo;
	/** On its resize handle. */
	handle: boolean;
	center: THREE.Vector3;
	/** Yards from the centre, at the circle's level. */
	distance: number;
}

/** Where the mouse went down, until it moves far enough to be a drag. */
interface Press {
	x: number;
	y: number;
	hit: SpawnInfo | null;
	ctrl: boolean;
	/** Pressed on a selection circle's resize handle. */
	handle?: RingHit;
}

/**
 * The world editor's 3D view: picking, the tools (select, move, rotate, scale, place), box
 * selection and the selection circles. Changes go to the document; this only turns the mouse
 * into them. Only active in the edit workspace.
 */
export class EditorViewport {
	readonly tool = signal<Tool>('move');
	/** The template being put down by the place tool. */
	readonly stamp = signal<Stamp | null>(null);
	/** Whether clicks also pick the map's own props and buildings. */
	readonly props = signal(true);
	readonly buildings = signal(false);
	/** New stamps face a random way. */
	readonly randomTurn = signal(false);
	/** What Ctrl+C last copied, for Ctrl+V. */
	readonly clipboard = signal<SpawnInfo[]>([]);
	/** A line for the status bar about what the mouse would do. */
	readonly hint = signal('');
	/** The terrain brushes (the sculpt tool). */
	readonly brush: TerrainBrush;

	private readonly raycaster = new THREE.Raycaster();
	private readonly mouse = new THREE.Vector2();
	private press: Press | null = null;
	private held: Held | null = null;
	private adjust: Adjust | null = null;
	private lastHover = 0;
	/** Whether the mouse is over the 3D view, and Shift is held (the sculpt tool reads both each frame). */
	private overView = false;
	private shift = false;
	private readonly rings: THREE.Mesh[] = [];
	/** The spawn each shown ring is under, by ring. */
	private readonly ringSpawns: SpawnInfo[] = [];
	private readonly ringGeometry = new THREE.RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2);
	private readonly marquee: HTMLDivElement;

	constructor(private readonly host: EditorHost, private readonly doc: EditDocument) {
		this.marquee = document.createElement('div');
		this.marquee.className = 'ed-marquee';
		this.marquee.hidden = true;
		document.body.append(this.marquee);
		this.brush = new TerrainBrush(host, doc);
		host.canvas.addEventListener('pointerleave', () => (this.overView = false));

		const canvas = host.canvas;
		canvas.addEventListener('pointerdown', (e) => this.active && this.onPointerDown(e));
		window.addEventListener('pointermove', (e) => this.active && this.onPointerMove(e));
		window.addEventListener('pointerup', (e) => this.active && this.onPointerUp(e));
		canvas.addEventListener('contextmenu', (e) => this.active && e.preventDefault());
		// Captured ahead of the camera's zoom (and with Ctrl, the browser's): the wheel turns what's
		// held, or with Alt the selection; with Ctrl it raises or lowers them.
		window.addEventListener('wheel', (e) => this.active && this.onWheel(e), { capture: true, passive: false });
		bindKeys('edit', (e) => this.onKey(e));
		// Alt is held for turning; let go, it would otherwise move focus to the browser's menu.
		window.addEventListener('keyup', (e) => {
			if (this.active && e.key === 'Alt') e.preventDefault();
			if (this.active && e.key === 'Shift') this.setSnap(false);
			if (e.key === 'Shift') this.shift = false;
		});
		workspace.subscribe((w) => {
			if (w !== 'edit') this.cancel();
			this.updateHint();
		});
		this.tool.subscribe(() => {
			if (this.tool.value !== 'sculpt') this.brush.end();
			this.updateHint();
		});
		this.brush.kind.subscribe(() => this.updateHint());
	}

	private get active(): boolean {
		return workspace.value === 'edit';
	}

	/** Moves the selection circles to the selected spawns, and works the terrain brush; call every frame. */
	update(): void {
		const sculpting = this.active && this.tool.value === 'sculpt' && (this.overView || this.brush.active) && !this.host.looking;
		let center: THREE.Vector3 | null = null;
		if (sculpting) {
			this.raycaster.setFromCamera(this.ndc(this.mouse.x, this.mouse.y), this.host.camera);
			center = this.groundHit(this.raycaster.ray, false);
		}
		this.brush.update(center, (x, z) => this.host.heightAt(x, z), this.shift);
		const shown = this.active && !document.body.classList.contains('ui-hidden') ? this.doc.selection.value.slice(0, MAX_RINGS) : [];
		this.host.outline.targets = shown.flatMap((s) => {
			const placement = this.host.mapPlacement(s.place.map);
			return placement ? [{ wdt: placement.wdt, kind: spawnKind(s.type), uid: s.guid }] : [];
		});
		const right = new THREE.Vector3().setFromMatrixColumn(this.host.camera.matrixWorld, 0);
		const handleTurn = Math.atan2(-right.z, right.x);
		let n = 0;
		for (const s of shown) {
			const placement = this.host.mapPlacement(s.place.map);
			const at = placement && this.host.objects.spawnAt(placement.wdt, spawnKind(s.type), s.guid);
			if (!at) continue;
			const ring = this.rings[n] ?? this.addRing();
			const scale = Math.hypot(at.matrix.elements[0], at.matrix.elements[1], at.matrix.elements[2]);
			ring.position.setFromMatrixPosition(at.matrix);
			ring.position.y += 0.05;
			// The bounds reach well past the feet (arms, weapons, a tail); a person gets about a yard.
			// Trees and buildings would get huge ones: a few yards at most.
			ring.scale.setScalar(THREE.MathUtils.clamp(Math.min(at.radius, at.height) * scale * 0.5, 0.5, MAX_RING));
			// The resize handle (local +x) faces the camera's right, where it can always be seen.
			ring.rotation.y = handleTurn;
			ring.visible = true;
			this.ringSpawns[n] = s;
			n++;
		}
		for (let i = n; i < this.rings.length; i++) this.rings[i].visible = false;
	}

	private addRing(): THREE.Mesh {
		// Drawn over the finished frame, red where the ground or another model covers it.
		const ring = new THREE.Mesh(this.ringGeometry, this.host.outline.ringMaterial);
		ring.frustumCulled = false;
		this.host.outline.overlay.add(ring);
		this.rings.push(ring);
		return ring;
	}

	// --- Commands (also from the menus and toolbar) ---

	/** Chooses a template to put down: the place tool, with a copy following the mouse. */
	async startPlacing(stamp: Stamp): Promise<boolean> {
		this.cancel();
		this.stamp.value = stamp;
		this.tool.value = 'place';
		return this.nextStamp();
	}

	/** Copies the selection; the copies follow the mouse until a click puts them down. */
	duplicate(): void {
		this.pasteCopies(this.doc.selection.value);
	}

	/** Keeps the selection as it stands now, for pasting (as often as wanted) later. */
	copy(): void {
		const selected = this.doc.selection.value;
		if (!selected.length) return;
		this.clipboard.value = selected.map((s) => ({ ...s, place: { ...s.place } }));
	}

	cut(): void {
		if (!this.doc.selection.value.length) return;
		this.copy();
		this.remove();
	}

	/** New copies of what was copied, following the mouse until a click puts them down. */
	paste(): void {
		this.pasteCopies(this.clipboard.value);
	}

	private pasteCopies(from: SpawnInfo[]): void {
		if (!from.length) return;
		this.cancel();
		const copies = from.map((s) => {
			const copy: SpawnInfo = { ...s, guid: this.doc.nextGuid(s.type, s.place.map), created: true, place: { ...s.place } };
			this.doc.preview(copy);
			return copy;
		});
		this.doc.select(copies);
		this.hold(copies, copies[0], 'carry', copies.map(() => undefined));
		this.moveHeld();
	}

	remove(): void {
		this.cancel();
		this.doc.remove(this.doc.selection.value);
		this.doc.select([]);
	}

	/** Flies the camera to the selection. */
	focusSelection(): void {
		const selected = this.doc.selection.value;
		const points = selected.map((s) => this.worldPosition(s)).filter((p): p is THREE.Vector3 => !!p);
		if (!points.length) return;
		const box = new THREE.Box3().setFromPoints(points);
		const center = box.getCenter(new THREE.Vector3());
		this.host.focus(center, Math.max(12, box.getSize(new THREE.Vector3()).length() * 1.2));
	}

	/** Moves the selection up or down. */
	raise(yards: number): void {
		this.doc.update(this.doc.selection.value, (s) => ({ ...s, place: { ...s.place, z: s.place.z + yards } }), 'raise');
	}

	/** Turns the selection, each about its own upright axis. */
	turn(degrees: number): void {
		const r = THREE.MathUtils.degToRad(degrees);
		this.doc.update(this.doc.selection.value, (s) => turned(s, r), 'turn');
	}

	/** Puts down what's carried, or drops it (Esc); ends the place tool's stamping. */
	cancel(): void {
		this.press = null;
		this.marquee.hidden = true;
		if (this.adjust) {
			for (const item of this.adjust.items) this.doc.restore(item.id);
			this.adjust = null;
		}
		const held = this.held;
		if (!held) return;
		this.held = null;
		for (const item of held.items) this.doc.restore(item.id);
		if (held.mode === 'carry') this.doc.select(this.doc.selection.value.filter((s) => !held.items.some((i) => i.id === spawnId(s))));
	}

	// --- Mouse ---

	private ndc(x: number, y: number): THREE.Vector2 {
		const rect = this.host.canvas.getBoundingClientRect();
		return new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
	}

	private pickAt(x: number, y: number): SpawnInfo | null {
		this.raycaster.setFromCamera(this.ndc(x, y), this.host.camera);
		this.raycaster.far = PICK_DISTANCE;
		const hit = this.host.objects.pickPlaced(this.raycaster, this.props.value, this.buildings.value, PROP_RANGE);
		if (!hit) return null;
		return hit.placement.spawn ?? this.modelInfo(hit.placement, hit.wdt);
	}

	/** The selected spawn whose circle is under the mouse (the nearest, where they overlap), or null. */
	private ringAt(x: number, y: number): RingHit | null {
		this.raycaster.setFromCamera(this.ndc(x, y), this.host.camera);
		const ray = this.raycaster.ray;
		const point = new THREE.Vector3();
		let best: RingHit | null = null;
		let bestDistance = Infinity;
		this.rings.forEach((ring, i) => {
			if (!ring.visible) return;
			// Where the ray crosses the ring's level: inside its radius, or on its handle, which
			// is thin, so it's given some room either side of the line.
			const t = (ring.position.y - ray.origin.y) / ray.direction.y;
			if (!(t > 0) || t > PICK_DISTANCE || t >= bestDistance) return;
			ray.at(t, point);
			const dx = point.x - ring.position.x, dz = point.z - ring.position.z;
			const distance = Math.hypot(dx, dz);
			const r = ring.scale.x;
			// Angle from the handle's middle, the circle's local +x: (cos, 0, -sin) of its turn.
			const along = (dx * Math.cos(ring.rotation.y) - dz * Math.sin(ring.rotation.y)) / (distance || 1);
			const handle = distance > r * 0.6 && distance < r * 1.4 && Math.acos(THREE.MathUtils.clamp(along, -1, 1)) < RING_HANDLE_ARC + 0.1;
			if (distance > r && !handle) return;
			best = { spawn: this.ringSpawns[i], handle, center: ring.position.clone(), distance };
			bestDistance = t;
		});
		return best;
	}

	private onPointerDown(e: PointerEvent): void {
		if (e.button === 2) {
			// Right button held: look around and fly, as in the game.
			this.host.lockLook();
			return;
		}
		if (e.button !== 0 || this.host.looking) return;
		this.mouse.set(e.clientX, e.clientY);
		if (this.tool.value === 'sculpt') {
			this.raycaster.setFromCamera(this.ndc(e.clientX, e.clientY), this.host.camera);
			const center = this.groundHit(this.raycaster.ray, false);
			if (center) this.brush.start(center);
			return;
		}
		if (this.held?.mode === 'carry') {
			this.putDown();
			return;
		}
		// The resize handle is drawn over everything, so it comes first.
		const ring = this.ringAt(e.clientX, e.clientY);
		const handle = ring?.handle ? ring : undefined;
		const hit = handle?.spawn ?? this.pickAt(e.clientX, e.clientY) ?? ring?.spawn ?? null;
		this.press = { x: e.clientX, y: e.clientY, hit, ctrl: e.ctrlKey || e.metaKey, handle };
	}

	private onPointerMove(e: PointerEvent): void {
		this.shift = e.shiftKey;
		if (this.host.looking) return;
		this.mouse.set(e.clientX, e.clientY);
		this.overView = e.target === this.host.canvas;
		if (this.tool.value === 'sculpt') {
			this.host.canvas.style.cursor = this.overView ? 'crosshair' : '';
			return;
		}
		const press = this.press;
		if (press && !this.held && !this.adjust && this.marquee.hidden && Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_THRESHOLD) this.startDrag(press);
		if (this.held) {
			this.setSnap(e.shiftKey);
			this.moveHeld();
			return;
		}
		if (this.adjust) {
			if (this.adjust.kind === 'handle') this.resizeByHandle(e.clientX, e.clientY);
			else this.adjustBy(this.adjust.kind === 'rotate' ? e.clientX - this.adjust.from : this.adjust.from - e.clientY);
			return;
		}
		if (press && !this.marquee.hidden) {
			this.drawMarquee(press.x, press.y, e.clientX, e.clientY);
			return;
		}
		if (e.target !== this.host.canvas || performance.now() - this.lastHover < 80) return;
		this.lastHover = performance.now();
		const ring = this.ringAt(e.clientX, e.clientY);
		this.host.canvas.style.cursor = ring?.handle ? 'nwse-resize' : this.pickAt(e.clientX, e.clientY) ?? ring ? 'var(--wow-cursor-grab, grab)' : '';
	}

	private onPointerUp(e: PointerEvent): void {
		if (e.button === 2 && this.host.looking) document.exitPointerLock();
		if (e.button !== 0) return;
		if (this.brush.active) {
			this.brush.end();
			return;
		}
		const press = this.press;
		this.press = null;
		if (this.held?.mode === 'drag') {
			this.commitHeld();
			return;
		}
		if (this.adjust) {
			const { items } = this.adjust;
			this.adjust = null;
			this.doc.commit(items.map((i) => ({ id: i.id, before: i.before, after: this.doc.shown(i.id) })));
			return;
		}
		if (!press) return;
		if (!this.marquee.hidden) {
			this.marquee.hidden = true;
			this.boxSelect(press, e.clientX, e.clientY);
			return;
		}
		// A click: select what's under it (Ctrl adds or takes away), or nothing.
		if (press.ctrl && press.hit) this.doc.toggle(press.hit);
		else if (!press.ctrl) this.doc.select(press.hit ? [press.hit] : []);
	}

	/** The mouse moved far enough with the button down: move, turn, scale, or draw a box. */
	private startDrag(press: Press): void {
		const tool = this.tool.value;
		// Ctrl only ever adds to the selection: a Ctrl+click that slips draws a box, never moves.
		// The resize handle resizes whatever the tool.
		if (!press.hit || press.ctrl || (!press.handle && (tool === 'select' || tool === 'place'))) {
			this.marquee.hidden = false;
			this.drawMarquee(press.x, press.y, press.x, press.y);
			return;
		}
		// Dragging something unselected selects it alone first.
		const id = spawnId(press.hit);
		if (!this.doc.selection.value.some((s) => spawnId(s) === id)) this.doc.select([press.hit]);
		const selected = this.doc.selection.value;
		const items = selected.map((s) => ({ id: spawnId(s), start: s, before: this.doc.editOf(spawnId(s)) }));
		if (press.handle) {
			this.adjust = { kind: 'handle', items, from: Math.max(press.handle.distance, 0.05), center: press.handle.center };
		} else if (tool === 'move') {
			const anchor = selected.find((s) => spawnId(s) === id) ?? selected[0];
			this.raycaster.setFromCamera(this.ndc(press.x, press.y), this.host.camera);
			const grab = this.groundHit(this.raycaster.ray, anchor.type !== 'wmo') ?? undefined;
			this.held = { items, anchor, mode: 'drag', lift: 0, turn: 0, grab };
			this.host.canvas.style.cursor = 'var(--wow-cursor-grab, grabbing)';
		} else if (tool === 'rotate' || tool === 'scale') {
			this.adjust = { kind: tool, items, from: tool === 'rotate' ? press.x : press.y };
		}
	}

	private hold(infos: SpawnInfo[], anchor: SpawnInfo, mode: Held['mode'], before: (SpawnEdit | undefined)[]): void {
		this.held = { items: infos.map((s, i) => ({ id: spawnId(s), start: s, before: before[i] })), anchor, mode, lift: 0, turn: 0 };
	}

	/** What's held follows the ground under the mouse, keeping its shape; lifted and turned as asked. */
	private moveHeld(): void {
		const held = this.held;
		if (!held) return;
		const placement = this.host.mapPlacement(held.anchor.place.map);
		if (!placement) return;
		this.raycaster.setFromCamera(this.ndc(this.mouse.x, this.mouse.y), this.host.camera);
		const ray = this.raycaster.ray;
		let hit = this.groundHit(ray, held.anchor.type !== 'wmo');
		if (held.snap) {
			// Onto the top of another prop or object, if that's nearer than the ground; never onto what's held.
			const top = this.host.objects.pickPlaced(this.raycaster, true, false, PROP_RANGE, this.heldKeys(held));
			if (top && (!hit || top.distance < hit.distanceTo(ray.origin))) hit = ray.at(top.distance, new THREE.Vector3());
		}
		if (!hit) return;
		// World -> WoW coordinates for this map (the inverse of placing a spawn).
		let dx: number, dy: number, dz: number;
		if (held.grab && !held.snap) {
			// Moved by as much as the ground under the mouse has.
			dx = held.grab.z - hit.z;
			dy = held.grab.x - hit.x;
			dz = hit.y - held.grab.y + held.lift;
		} else {
			// Carried or snapping: its feet go where the mouse points.
			const a = held.anchor.place;
			dx = MAP_ORIGIN + placement.offsetY * TILE_SIZE - hit.z - a.x;
			dy = MAP_ORIGIN + placement.offsetX * TILE_SIZE - hit.x - a.y;
			dz = hit.y + held.lift - a.z;
		}
		for (const item of held.items) {
			const p = item.start.place;
			item.now = turned({ ...item.start, place: { ...p, x: p.x + dx, y: p.y + dy, z: p.z + dz } }, held.turn);
			this.doc.preview(item.now);
		}
	}

	/** Object keys (wdt:kind:uid) of what's held, for seeing through it. */
	private heldKeys(held: Held): Set<string> {
		const keys = new Set<string>();
		for (const { start: s } of held.items) {
			const placement = this.host.mapPlacement(s.place.map);
			if (placement) keys.add(`${placement.wdt}:${spawnKind(s.type)}:${s.guid}`);
		}
		return keys;
	}

	/** Starts or stops snapping; what's held carries on from where it is, rather than jumping back. */
	private setSnap(on: boolean): void {
		const held = this.held;
		if (!held || !!held.snap === on) return;
		const anchorId = spawnId(held.anchor);
		for (const item of held.items) item.start = item.now ?? item.start;
		held.anchor = held.items.find((i) => i.id === anchorId)?.start ?? held.anchor;
		held.lift = 0;
		held.turn = 0;
		held.snap = on;
		// A drag goes on moving as far as the mouse does, from the ground under it now.
		if (held.mode === 'drag' && !on) {
			this.raycaster.setFromCamera(this.ndc(this.mouse.x, this.mouse.y), this.host.camera);
			held.grab = this.groundHit(this.raycaster.ray, held.anchor.type !== 'wmo') ?? undefined;
		}
		this.moveHeld();
	}

	private commitHeld(): void {
		const held = this.held;
		if (!held) return;
		this.held = null;
		this.doc.commit(held.items.map((i) => ({ id: i.id, before: i.before, after: this.doc.shown(i.id) })));
		this.host.canvas.style.cursor = '';
	}

	/** A click while carrying: down it goes. Stamping goes on with a fresh copy. */
	private putDown(): void {
		this.commitHeld();
		if (this.tool.value === 'place' && this.stamp.value) void this.nextStamp();
	}

	/** A new copy of the chosen template, following the mouse. */
	private async nextStamp(): Promise<boolean> {
		const stamp = this.stamp.value;
		if (!stamp) return false;
		this.raycaster.setFromCamera(this.ndc(this.mouse.x, this.mouse.y), this.host.camera);
		const ground = this.groundHit(this.raycaster.ray) ?? this.host.camera.position;
		const map = this.host.mapAt(ground.x, ground.z) ?? this.host.mapAt(this.host.camera.position.x, this.host.camera.position.z);
		if (!map) return false;
		const guid = this.doc.nextGuid(stamp.type, map.mapId);
		const info = stamp.type === 'm2' || stamp.type === 'wmo'
			? modelSpawn(stamp.type, stamp.entry, stamp.name, map.mapId, guid)
			: await this.host.templateSpawn(stamp.type, stamp.entry, map.mapId, guid);
		// The tool may have changed meanwhile.
		if (!info || this.stamp.value !== stamp || this.tool.value !== 'place' || this.held) return false;
		const made: SpawnInfo = { ...info, created: true };
		if (this.randomTurn.value) made.place.o = Math.random() * Math.PI * 2;
		this.doc.preview(made);
		this.hold([made], made, 'carry', [undefined]);
		this.moveHeld();
		return true;
	}

	/** Rotate or scale drag: each selected spawn turned about its own axis, or resized. */
	private adjustBy(pixels: number): void {
		const adjust = this.adjust!;
		for (const item of adjust.items) {
			if (adjust.kind === 'rotate') this.doc.preview(turned(item.start, pixels * ROTATE_RATE));
			else this.doc.preview({ ...item.start, place: { ...item.start.place, scale: Math.max(0.05, item.start.place.scale * Math.exp(pixels * SCALE_RATE)) } });
		}
	}

	/** Handle drag: the selection resized by how much further from the circle's centre the mouse is than it was. */
	private resizeByHandle(x: number, y: number): void {
		const adjust = this.adjust!;
		const center = adjust.center!;
		this.raycaster.setFromCamera(this.ndc(x, y), this.host.camera);
		const ray = this.raycaster.ray;
		const t = (center.y - ray.origin.y) / ray.direction.y;
		// Looking level with the circle, or above it from below, the mouse doesn't meet its level.
		if (!(t > 0) || t > PICK_DISTANCE) return;
		const point = ray.at(t, new THREE.Vector3());
		const factor = Math.hypot(point.x - center.x, point.z - center.z) / adjust.from;
		for (const item of adjust.items) {
			this.doc.preview({ ...item.start, place: { ...item.start.place, scale: Math.max(0.05, item.start.place.scale * factor) } });
		}
	}

	private onWheel(e: WheelEvent): void {
		if (e.target !== this.host.canvas || this.host.looking) return;
		const direction = -Math.sign(e.deltaY || e.deltaX);
		const step = (e.shiftKey ? FINE_TURN_STEP : TURN_STEP) * direction;
		if (this.tool.value === 'sculpt' && (e.altKey || e.ctrlKey || e.metaKey)) {
			// The brush: Alt+wheel its size, Ctrl+wheel its strength.
			if (e.altKey) this.brush.size.value = THREE.MathUtils.clamp(Math.round(this.brush.size.value * (direction > 0 ? 1.15 : 1 / 1.15)), 2, 80);
			else this.brush.strength.value = THREE.MathUtils.clamp(Math.round((this.brush.strength.value + direction * 0.05) * 100) / 100, 0.05, 1);
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		if (e.ctrlKey || e.metaKey) {
			// Up and down; with Shift, by a yard. Even with nothing to move, not the browser's zoom.
			const yards = (e.shiftKey ? BIG_RAISE_STEP : RAISE_STEP) * direction;
			if (this.held) {
				this.held.lift += yards;
				this.moveHeld();
			} else if (this.adjust) {
				return;
			} else if (this.doc.selection.value.length) {
				this.raise(yards);
			}
		} else if (this.held) {
			this.held.turn += THREE.MathUtils.degToRad(step);
			this.moveHeld();
		} else if (e.altKey && this.doc.selection.value.length) {
			this.turn(step);
		} else {
			return; // the camera's zoom
		}
		e.preventDefault();
		e.stopPropagation();
	}

	private drawMarquee(x0: number, y0: number, x1: number, y1: number): void {
		const s = this.marquee.style;
		s.left = `${Math.min(x0, x1)}px`;
		s.top = `${Math.min(y0, y1)}px`;
		s.width = `${Math.abs(x1 - x0)}px`;
		s.height = `${Math.abs(y1 - y0)}px`;
	}

	/** Selects what stands inside a box drawn on screen (Ctrl adds to the selection). */
	private boxSelect(press: Press, x: number, y: number): void {
		const a = this.ndc(press.x, press.y);
		const b = this.ndc(x, y);
		const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
		const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
		const camera = this.host.camera;
		const p = new THREE.Vector3();
		const found = this.host.objects.placedWhere((m) => {
			p.setFromMatrixPosition(m);
			if (p.distanceTo(camera.position) > PICK_DISTANCE) return false;
			p.project(camera);
			return p.z < 1 && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
		}, this.props.value, this.buildings.value, PROP_RANGE, camera.position);
		const infos = found.map((f) => f.placement.spawn ?? this.modelInfo(f.placement, f.wdt)).filter((i): i is SpawnInfo => !!i);
		// What the box was started on counts too, even when its feet aren't inside.
		if (press.hit) infos.push(press.hit);
		const all = press.ctrl ? [...this.doc.selection.value, ...infos] : infos;
		const ids = new Set<string>();
		this.doc.select(all.filter((s) => !ids.has(spawnId(s)) && !!ids.add(spawnId(s))));
	}

	// --- Keys ---

	private onKey(e: KeyboardEvent): boolean {
		// While looking around, the letters fly the camera.
		if (this.host.looking) return false;
		const ctrl = e.ctrlKey || e.metaKey;
		if (e.key === 'Shift' && this.held) {
			this.setSnap(true);
			return true;
		}
		const tools: Record<string, Tool> = { KeyQ: 'select', KeyW: 'move', KeyE: 'rotate', KeyR: 'scale', KeyT: 'sculpt' };
		const brushes: Record<string, BrushKind> = { Digit1: 'raise', Digit2: 'lower', Digit3: 'flatten', Digit4: 'smooth' };
		if (e.key === 'Shift') this.shift = true;
		if (this.tool.value === 'sculpt' && !ctrl && brushes[e.code]) {
			this.brush.kind.value = brushes[e.code];
			return true;
		}
		if (ctrl && e.code === 'KeyZ') {
			this.cancel();
			if (e.shiftKey) this.doc.redo();
			else this.doc.undo();
		} else if (ctrl && e.code === 'KeyY') {
			this.cancel();
			this.doc.redo();
		} else if (ctrl && e.code === 'KeyD') this.duplicate();
		else if (ctrl && e.code === 'KeyC' && this.doc.selection.value.length) this.copy();
		else if (ctrl && e.code === 'KeyX' && this.doc.selection.value.length) this.cut();
		else if (ctrl && e.code === 'KeyV' && this.clipboard.value.length) this.paste();
		else if (!ctrl && tools[e.code]) {
			this.cancel();
			this.stamp.value = null;
			this.tool.value = tools[e.code];
		} else if (e.code === 'KeyF' && !ctrl) this.focusSelection();
		else if ((e.code === 'Delete' || e.code === 'Backspace') && this.doc.selection.value.length) this.remove();
		else if ((e.code === 'PageUp' || e.code === 'PageDown') && this.doc.selection.value.length) {
			this.raise((e.shiftKey ? BIG_RAISE_STEP : RAISE_STEP) * (e.code === 'PageUp' ? 1 : -1));
		} else if (e.code === 'Escape') {
			if (this.brush.active) {
				this.brush.cancel();
				return true;
			}
			if (this.held || this.adjust || this.press) this.cancel();
			if (this.tool.value === 'place') {
				this.stamp.value = null;
				this.tool.value = 'move';
			} else if (this.doc.selection.value.length) this.doc.select([]);
			else return false;
		} else return false;
		return true;
	}

	private updateHint(): void {
		this.hint.value = {
			select: 'Click to select · Ctrl+click adds · drag a box around things',
			move: 'Drag to move along the ground · Shift snaps onto what\'s under the mouse · Ctrl+wheel up and down · wheel turns',
			rotate: 'Drag left and right to turn the selection',
			scale: 'Drag up and down to resize the selection',
			place: 'Click to put it down · Shift snaps onto props · wheel turns it, Ctrl+wheel raises it · Esc stops placing',
			sculpt: {
				raise: 'Hold the mouse to raise the ground (Shift lowers) · Alt+wheel brush size · Ctrl+wheel strength · 1-4 brushes',
				lower: 'Hold the mouse to lower the ground (Shift raises) · Alt+wheel brush size · Ctrl+wheel strength · 1-4 brushes',
				flatten: 'Hold the mouse to level the ground to where you started · Alt+wheel brush size · Ctrl+wheel strength',
				smooth: 'Hold the mouse to smooth bumps and edges · Alt+wheel brush size · Ctrl+wheel strength',
			}[this.brush?.kind.value ?? 'raise'],
		}[this.tool.value];
	}

	// --- Geometry ---

	/** The animations an NPC's model has, once it has loaded (for greying out poses it can't do). */
	animationsOf(s: SpawnInfo): number[] | undefined {
		const placement = this.host.mapPlacement(s.place.map);
		return placement ? this.host.objects.spawnAt(placement.wdt, 'creature', s.guid)?.animations : undefined;
	}

	private worldPosition(s: SpawnInfo): THREE.Vector3 | null {
		const placement = this.host.mapPlacement(s.place.map);
		const at = placement && this.host.objects.spawnAt(placement.wdt, spawnKind(s.type), s.guid);
		return at ? new THREE.Vector3().setFromMatrixPosition(at.matrix) : null;
	}

	/** Where a ray first meets the ground (or, with buildings, a building), if within reach. */
	private groundHit(ray: THREE.Ray, buildings = true): THREE.Vector3 | null {
		let best = (buildings && this.host.objects.raycastBuildings(ray.origin, ray.direction, PICK_DISTANCE)) || PICK_DISTANCE;
		// March to the terrain, in steps that grow with distance, then narrow the crossing down.
		const p = new THREE.Vector3();
		const below = (t: number) => {
			ray.at(t, p);
			return p.y < this.host.heightAt(p.x, p.z);
		};
		let previous = 0;
		for (let t = 0.25; t < best; t += Math.max(0.25, t * 0.01)) {
			if (below(t)) {
				let lo = previous, hi = t;
				for (let i = 0; i < 12; i++) {
					const mid = (lo + hi) / 2;
					if (below(mid)) hi = mid;
					else lo = mid;
				}
				best = hi;
				break;
			}
			previous = t;
		}
		return best < PICK_DISTANCE ? ray.at(best, new THREE.Vector3()) : null;
	}

	/**
	 * One of the map's own models (from its ADT) as a spawn to edit: its placement matrix taken
	 * back apart into a position, rotation and scale in world coordinates.
	 */
	private modelInfo(p: Placement, wdt: number): SpawnInfo | null {
		const map = this.host.mapOfWdt(wdt);
		if (!map || (p.kind !== 'm2' && p.kind !== 'wmo')) return null;
		const position = new THREE.Vector3();
		const turn = new THREE.Quaternion();
		const scale = new THREE.Vector3();
		new THREE.Matrix4().fromArray(p.matrix).decompose(position, turn, scale);
		const r = CONTINENT_TO_WORLD.clone().multiply(turn);
		const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(r);
		const building = p.kind === 'wmo';
		return {
			type: p.kind,
			guid: p.uid,
			entry: p.fdid,
			name: `${building ? 'Building' : 'Model'} ${p.fdid}`,
			kind: building ? 'Building' : 'Prop',
			place: {
				map: map.mapId,
				x: MAP_ORIGIN - position.z,
				y: MAP_ORIGIN - position.x,
				z: position.y,
				o: wrapAngle(Math.atan2(forward.y, forward.x)),
				rotation: [r.x, r.y, r.z, r.w],
				scale: scale.x,
				display: p.fdid,
				doodadSet: p.doodadSet || undefined,
				nameSet: p.nameSet,
			},
		};
	}
}

/** A new copy of one of the game's map models (a prop or a building), at the origin, upright. */
function modelSpawn(type: 'm2' | 'wmo', fdid: number, name: string, map: number, guid: number): SpawnInfo {
	return {
		type, guid, entry: fdid, name,
		kind: type === 'wmo' ? 'Building' : 'Prop',
		place: { map, x: 0, y: 0, z: 0, o: 0, scale: 1, display: fdid },
	};
}

/** A spawn turned further about the world's up axis (its facing, and its full rotation if it has one). */
export function turned(s: SpawnInfo, radians: number): SpawnInfo {
	if (!radians) return s;
	const place = { ...s.place, o: wrapAngle(s.place.o + radians) };
	if (s.place.rotation) {
		const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), radians).multiply(new THREE.Quaternion(...s.place.rotation));
		place.rotation = [q.x, q.y, q.z, q.w];
	}
	return { ...s, place };
}

/** Radians into 0..2pi, as VMaNGOS keeps orientations. */
export function wrapAngle(a: number): number {
	const full = Math.PI * 2;
	return ((a % full) + full) % full;
}
