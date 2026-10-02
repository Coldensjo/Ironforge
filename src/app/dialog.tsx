import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import './app.css';

interface Question {
	title: string;
	message?: string;
	/** Button labels, the first the default (Enter); Esc picks the last. */
	buttons: string[];
	/** Asks for a line of text too, starting with this. */
	input?: string;
}

/** The answer: which button (by index), and the text if one was asked for. */
export interface Answer {
	button: number;
	value: string;
}

function Dialog({ q, done }: { q: Question; done: (a: Answer) => void }) {
	const [value, setValue] = useState(q.input ?? '');
	const field = useRef<HTMLInputElement>(null);
	const first = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (field.current) {
			field.current.focus();
			field.current.select();
		} else {
			first.current?.focus();
		}
	}, []);
	const answer = (button: number) => done({ button, value: value.trim() });
	return (
		<div class="app-dialog-backdrop wow" role="dialog" aria-modal="true" aria-label={q.title}>
			<form
				class="wow-dialog app-dialog"
				onSubmit={(e) => {
					e.preventDefault();
					answer(0);
				}}
				onKeyDown={(e) => {
					if (e.key === 'Escape') answer(q.buttons.length - 1);
				}}
			>
				<h2 class="wow-title">{q.title}</h2>
				{q.message && <p>{q.message}</p>}
				{q.input !== undefined && (
					<input ref={field} class="wow-input app-dialog-input" value={value} spellcheck={false} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
				)}
				<div class="app-dialog-buttons">
					{q.buttons.map((label, i) => (
						<button ref={i === 0 ? first : undefined} type={i === 0 ? 'submit' : 'button'} class="wow-button" onClick={i === 0 ? undefined : () => answer(i)}>{label}</button>
					))}
				</div>
			</form>
		</div>
	);
}

/** Asks something in the game's dialog frame; resolves with the answer. Keys stay in it meanwhile. */
export function ask(q: Question): Promise<Answer> {
	return new Promise((resolve) => {
		const root = document.createElement('div');
		document.body.append(root);
		render(<Dialog q={q} done={(a) => {
			render(null, root);
			root.remove();
			resolve(a);
		}} />, root);
	});
}
