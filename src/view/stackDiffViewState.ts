/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable } from '../common/lifecycle';
import { Schemes } from '../common/uri';

interface ReadingPosition {
	selections: readonly vscode.Selection[];
	top: vscode.Position;
}

/** Retain reading positions when VS Code disposes a replaced preview diff. */
export class StackDiffViewState extends Disposable {
	private readonly positions = new Map<string, ReadingPosition>();
	private opening = 0;

	constructor() {
		super();
		this._register(vscode.window.onDidChangeTextEditorVisibleRanges(e => this.remember(e.textEditor)));
		this._register(vscode.window.onDidChangeTextEditorSelection(e => this.remember(e.textEditor)));
	}

	private remember(editor: vscode.TextEditor): void {
		if (editor.document.uri.scheme !== Schemes.Pr || !editor.visibleRanges.length) {
			return;
		}
		// The complete URI includes repository, PR, path, side and revision.
		const key = editor.document.uri.toString();
		this.positions.delete(key);
		this.positions.set(key, { selections: [...editor.selections], top: editor.visibleRanges[0].start });
		if (this.positions.size > 1000) {
			this.positions.delete(this.positions.keys().next().value!);
		}
	}

	async open(command: vscode.Command): Promise<unknown> {
		const request = ++this.opening;
		for (const editor of vscode.window.visibleTextEditors) {
			this.remember(editor);
		}
		const [original, modified] = command.arguments ?? [];
		if (command.command !== 'vscode.diff' || !(original instanceof vscode.Uri) || !(modified instanceof vscode.Uri)) {
			return vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
		}
		const matches = (tab: vscode.Tab) => tab.input instanceof vscode.TabInputTextDiff
			&& tab.input.original.toString() === original.toString()
			&& tab.input.modified.toString() === modified.toString();
		const group = vscode.window.tabGroups.activeTabGroup;
		const alreadyOpen = group.tabs.some(matches);
		const saved = new Map([original, modified].map(uri => [uri.toString(), this.positions.get(uri.toString())]));
		const result = await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
		// Existing tabs retain the native view state, including folds and pixel offsets.
		// A newer click must not be interrupted by a late completion of this open.
		if (alreadyOpen || request !== this.opening || this.isDisposed
			|| vscode.window.tabGroups.activeTabGroup !== group || !group.activeTab || !matches(group.activeTab)) {
			return result;
		}
		const editors = vscode.window.visibleTextEditors.filter(editor => saved.has(editor.document.uri.toString())
			&& (editor.viewColumn === undefined || editor.viewColumn === group.viewColumn));
		for (const editor of editors) {
			const position = saved.get(editor.document.uri.toString());
			if (position) {
				editor.selections = [...position.selections];
			}
		}
		// Scroll only one side: diff editors synchronize their two viewports. A deleted
		// file has an empty modified side, so restore from the original in that case.
		const primary = editors.find(editor => editor.document.uri.toString() === modified.toString() && (editor.document.lineCount > 1 || editor.document.lineAt(0).text.length > 0))
			?? editors.find(editor => editor.document.uri.toString() === original.toString());
		const position = primary && saved.get(primary.document.uri.toString());
		if (primary && position) {
			primary.revealRange(new vscode.Range(position.top, position.top), vscode.TextEditorRevealType.AtTop);
		}
		return result;
	}
}
