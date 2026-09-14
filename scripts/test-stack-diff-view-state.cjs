/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Run with node scripts/test-stack-diff-view-state.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

class Uri {
	constructor(value) { this.value = value; this.scheme = value.split(':')[0]; }
	toString() { return this.value; }
}
class Range { constructor(start, end) { this.start = start; this.end = end; } }
class TabInputTextDiff { constructor(original, modified) { Object.assign(this, { original, modified }); } }
const group = { tabs: [], viewColumn: 1 };
const listeners = {};
const window = {
	visibleTextEditors: [], tabGroups: { activeTabGroup: group },
	onDidChangeTextEditorVisibleRanges: fn => { listeners.scroll = fn; return { dispose() {} }; },
	onDidChangeTextEditorSelection: fn => { listeners.selection = fn; return { dispose() {} }; },
};
const line = value => ({ line: value, character: 0 });
function editor(uri, empty = false) {
	return { document: { uri, lineCount: empty ? 1 : 1000, lineAt: () => ({ text: '' }) }, viewColumn: 1,
		selections: [new Range(line(0), line(0))], visibleRanges: [new Range(line(0), line(80))], reveals: [],
		revealRange(range, kind) { this.reveals.push({ range, kind }); this.visibleRanges = [range]; },
	};
}
let deleted = false;
let lastOptions;
let openImpl = async (_command, original, modified, _title, options) => {
	lastOptions = options;
	const existing = group.tabs.find(tab => tab.input.modified.toString() === modified.toString());
	group.activeTab = existing ?? { input: new TabInputTextDiff(original, modified), isPreview: true };
	group.tabs = [...group.tabs.filter(tab => !tab.isPreview), group.activeTab];
	window.visibleTextEditors = [editor(original), editor(modified, deleted)];
	// Model initialization can emit events before executeCommand resolves.
	for (const textEditor of window.visibleTextEditors) { listeners.scroll({ textEditor }); }
};
const moduleExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/view/stackDiffViewState.ts'), 'utf8'), {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, {
	exports: moduleExports,
	require: name => {
		if (name === 'vscode') { return { Uri, Range, TabInputTextDiff, window, TextEditorRevealType: { AtTop: 1 }, commands: { executeCommand: (...args) => openImpl(...args) } }; }
		if (name === '../common/uri') { return { Schemes: { Pr: 'pr' } }; }
		if (name === '../common/lifecycle') { return { Disposable: class { _register(value) { return value; } } }; }
		throw new Error(`Unexpected dependency: ${name}`);
	},
});
const state = new moduleExports.StackDiffViewState();
const command = (name, revision = 'head1', repo = 'repo') => ({ command: 'vscode.diff', title: name,
	arguments: [new Uri(`pr:/${repo}/${name}?base&${revision}`), new Uri(`pr:/${repo}/${name}?head&${revision}`), name, {}] });
function readAt(top, cursor = 12, side = 1) {
	const textEditor = window.visibleTextEditors[side];
	textEditor.selections = [new Range(line(cursor), line(cursor))];
	textEditor.visibleRanges = [new Range(line(top), line(top + 80))];
	listeners.scroll({ textEditor });
}
async function main() {
	const a = command('a'), b = command('b');
	await state.open(a);
	readAt(400, 12);
	await state.open(b);
	await state.open(a);
	let right = window.visibleTextEditors[1];
	assert.equal(lastOptions.preview, undefined);
	assert.equal(group.activeTab.isPreview, true);
	assert.equal(right.selections[0].start.line, 12);
	assert.equal(right.reveals[0].range.start.line, 400);
	assert.equal(right.reveals[0].kind, 1);
	console.log('PASS replaced preview restores viewport independently of cursor and initialization events');

	await state.open(command('a', 'head2'));
	assert.equal(window.visibleTextEditors[1].reveals.length, 0);
	await state.open(command('a', 'head1', 'other-repo'));
	assert.equal(window.visibleTextEditors[1].reveals.length, 0);
	console.log('PASS repository and revision isolate reading positions');

	deleted = true;
	const removed = command('deleted');
	await state.open(removed);
	readAt(250, 42, 0);
	await state.open(b);
	await state.open(removed);
	assert.equal(window.visibleTextEditors[0].reveals[0].range.start.line, 250);
	assert.equal(window.visibleTextEditors[1].reveals.length, 0);
	console.log('PASS deleted files restore from original side');

	deleted = false;
	await state.open(a);
	group.activeTab.isPreview = false;
	await state.open(b);
	await state.open(a);
	assert.equal(window.visibleTextEditors[1].reveals.length, 0);
	console.log('PASS existing pinned tabs retain native view state');

	const normalOpen = openImpl;
	let release;
	openImpl = async (...args) => { await normalOpen(...args); await new Promise(resolve => { release = resolve; }); };
	const pending = state.open(removed);
	await new Promise(resolve => setImmediate(resolve));
	openImpl = normalOpen;
	await state.open(command('latest'));
	release();
	await pending;
	assert.equal(window.visibleTextEditors[1].reveals.length, 0);
	assert.match(group.activeTab.input.modified.toString(), /latest/);
	console.log('PASS late open completion does not scroll a newer file');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
