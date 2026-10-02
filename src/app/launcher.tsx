import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { WorldKind } from '../viewer/viewer';
import { desktop } from './desktop';
import { ask } from './dialog';
import { pickFile } from './projects';
import { forgetStoredProject, newProject, parseProject, readSession, storedProjects, useProject, type ProjectFile } from './project';
import './app.css';

/** A project to open again: a file (desktop app) or one saved in the browser. */
interface Recent {
	name: string;
	when: string;
	world?: WorldKind;
	open: () => Promise<boolean>;
	forget?: () => Promise<void>;
}

const WORLDS: [WorldKind, string, string][] = [
	['sandbox', 'Sandbox', 'A large field of grass to build on from scratch. Quick to open.'],
	['azeroth', 'Azeroth', 'The game\'s own world, Eastern Kingdoms and Kalimdor, with every NPC and object.'],
];

function when(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The launcher: carry on with the last project, start a new one (in the sandbox or Azeroth),
 * open a project file, or pick a recent one. Resolves once a project is ready to load.
 */
function Launcher({ done }: { done: () => void }) {
	const session = readSession();
	const [name, setName] = useState('My sandbox');
	const [world, setWorld] = useState<WorldKind>('sandbox');
	const [recent, setRecent] = useState<Recent[] | null>(null);
	const [busy, setBusy] = useState(false);

	const opened = async (file: ProjectFile, where: { path?: string; stored?: string }) => {
		await useProject(file, where);
		done();
		return true;
	};
	const failed = async (e: unknown) => {
		await ask({ title: 'Can\'t open that', message: (e as Error).message, buttons: ['OK'] });
		return false;
	};

	const loadRecent = async () => {
		if (desktop) {
			const files = await desktop.recentProjects();
			setRecent(files.map((f) => ({
				name: f.name,
				when: when(f.modified),
				open: async () => {
					try {
						const result = await desktop!.readProject(f.path);
						return result ? opened(parseProject(result.text), { path: result.path }) : failed(new Error('That file is gone.'));
					} catch (e) {
						return failed(e);
					}
				},
			})));
		} else {
			const files = await storedProjects();
			setRecent(files.map((f) => ({
				name: f.name,
				when: when(f.saved),
				world: f.world,
				open: () => opened(f, { stored: f.name }),
				forget: async () => {
					const answer = await ask({ title: 'Delete project', message: `Delete ${f.name} from this browser? This can't be undone.`, buttons: ['Delete', 'Cancel'] });
					if (answer.button !== 0) return;
					await forgetStoredProject(f.name);
					await loadRecent();
				},
			})));
		}
	};
	useEffect(() => {
		void loadRecent();
	}, []);

	const run = async (step: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await step();
		} finally {
			setBusy(false);
		}
	};
	const create = () => run(async () => {
		await newProject(name.trim() || 'Untitled', world);
		done();
	});
	const openFile = () => run(async () => {
		try {
			if (desktop) {
				const result = await desktop.openProject();
				if (result) await opened(parseProject(result.text), { path: result.path });
			} else {
				const text = await pickFile('.ironforge,.json');
				if (text !== null) await opened(parseProject(text), {});
			}
		} catch (e) {
			await failed(e);
		}
	});

	return (
		<div class="launcher wow">
			<div class="wow-dialog launcher-card">
				<header class="launcher-head">
					<img src="icon.svg" alt="" width={72} height={72} />
					<div>
						<h1 class="wow-title">Ironforge</h1>
						<p class="wow-muted">A world editor for World of Warcraft Classic</p>
					</div>
				</header>
				{session && (
					<button class="wow-button launcher-continue" disabled={busy} onClick={() => done()}>
						Continue {session.name}{session.dirty ? ' (unsaved changes)' : ''}
					</button>
				)}
				<div class="launcher-columns">
					<section>
						<h2 class="wow-label">New project</h2>
						<label class="launcher-field">
							<span class="wow-muted">Name</span>
							<input class="wow-input" value={name} spellcheck={false} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
						</label>
						<div class="launcher-worlds" role="radiogroup" aria-label="World">
							{WORLDS.map(([kind, title, text]) => (
								<button role="radio" aria-checked={world === kind} class={`launcher-world ${world === kind ? 'on' : ''}`} onClick={() => {
									setWorld(kind);
									if (name === 'My sandbox' || name === 'My Azeroth') setName(kind === 'sandbox' ? 'My sandbox' : 'My Azeroth');
								}}>
									<span class="wow-label">{title}</span>
									<span class="wow-muted">{text}</span>
								</button>
							))}
						</div>
						<button class="wow-button" disabled={busy} onClick={() => void create()}>Create</button>
					</section>
					<section>
						<h2 class="wow-label">Open</h2>
						<button class="wow-button" disabled={busy} onClick={() => void openFile()}>Open project file…</button>
						<h3 class="wow-label launcher-recent-title">{desktop ? 'Recent projects' : 'Saved in this browser'}</h3>
						<ul class="launcher-recent">
							{recent && !recent.length && <li class="wow-muted">None yet.</li>}
							{recent?.map((r) => (
								<li class="wow-row" onClick={() => !busy && void run(r.open)}>
									<span class="launcher-recent-name">{r.name}</span>
									<span class="wow-muted">{[r.world === 'azeroth' ? 'Azeroth' : r.world === 'sandbox' ? 'Sandbox' : '', r.when].filter(Boolean).join(' · ')}</span>
									{r.forget && (
										<button class="wow-close launcher-forget" title="Delete from this browser" aria-label="Delete" onClick={(e) => {
											e.stopPropagation();
											void r.forget!();
										}}>×</button>
									)}
								</li>
							))}
						</ul>
					</section>
				</div>
			</div>
		</div>
	);
}

/** Shows the launcher until a project is ready to load (its world and working copy set). */
export function showLauncher(): Promise<void> {
	return new Promise((resolve) => {
		const root = document.createElement('div');
		document.body.append(root);
		render(<Launcher done={() => {
			render(null, root);
			root.remove();
			resolve();
		}} />, root);
	});
}
