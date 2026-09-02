/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PrsTreeModel } from './prsTreeModel';
import { StackPullRequestGraphNode, StackPullRequestResolver } from './stackPullRequestResolver';
import { Disposable, disposeAll } from '../common/lifecycle';
import Logger from '../common/logger';
import { RepositoriesManager } from '../github/repositoriesManager';
import { NotificationsManager } from '../notifications/notificationsManager';
import { InMemFileChangeNode, RemoteFileChangeNode } from './treeNodes/fileChangeNode';
import { StackPullRequestNode } from './treeNodes/stackPullRequestNode';
import { BaseTreeNode, LabelOnlyNode, TreeNode } from './treeNodes/treeNode';

export class StackPullRequestsTreeDataProvider extends Disposable implements vscode.TreeDataProvider<TreeNode>, BaseTreeNode {
	private static readonly ID = 'StackPullRequestsTree';
	private static readonly OPEN_FILE_DIFF_COMMAND = 'stackPr.openFileDiff';
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly _view: vscode.TreeView<TreeNode>;
	private _children: TreeNode[] = [];
	private _loadPromise: Promise<TreeNode[]> | undefined;
	private _generation = 0;
	private readonly _folderListeners = new Map<string, vscode.Disposable>();

	constructor(
		private readonly _reposManager: RepositoriesManager,
		private readonly _prsTreeModel: PrsTreeModel,
		private readonly _notificationsManager: NotificationsManager,
		private readonly _resolver = new StackPullRequestResolver(),
	) {
		super();
		this._view = this._register(vscode.window.createTreeView('stackPr:github', {
			treeDataProvider: this,
			showCollapseAll: true,
		}));
		this._register(this._onDidChangeTreeData);
		this._register(vscode.commands.registerCommand('stackPr.refresh', () => this.refresh()));
		this._register(vscode.commands.registerCommand(
			StackPullRequestsTreeDataProvider.OPEN_FILE_DIFF_COMMAND,
			(prNumber: number, fileName: string, command: vscode.Command) => this.openFileDiff(prNumber, fileName, command),
		));
		this._register(this._reposManager.onDidChangeFolderRepositories(() => {
			this.registerFolderListeners();
			this.refresh();
		}));
		this.registerFolderListeners();
	}

	get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	get children(): readonly TreeNode[] {
		return this._children;
	}

	private registerFolderListeners(): void {
		const activeRoots = new Set(this._reposManager.folderManagers.map(manager => manager.repository.rootUri.toString()));
		for (const [root, listener] of this._folderListeners) {
			if (!activeRoots.has(root)) {
				listener.dispose();
				this._folderListeners.delete(root);
			}
		}

		for (const manager of this._reposManager.folderManagers) {
			const root = manager.repository.rootUri.toString();
			if (!this._folderListeners.has(root)) {
				this._folderListeners.set(root, manager.onDidChangeActivePullRequest(() => this.refresh()));
			}
		}
	}

	refresh(treeNode?: TreeNode): void {
		if (treeNode) {
			this._onDidChangeTreeData.fire(treeNode);
			return;
		}
		this._generation++;
		this._loadPromise = undefined;
		disposeAll(this._children);
		this._children = [];
		this._onDidChangeTreeData.fire();
	}

	async reveal(element: TreeNode, options?: { select?: boolean; focus?: boolean; expand?: boolean | number }): Promise<void> {
		await this._view.reveal(element, options);
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (element) {
			return element.getChildren();
		}
		if (!this._loadPromise) {
			this._loadPromise = this.loadRoot();
		}
		return this._loadPromise;
	}

	getParent(element: TreeNode): TreeNode | undefined {
		return element.getParent();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem | Promise<vscode.TreeItem> {
		return element.getTreeItem();
	}

	async resolveTreeItem(item: vscode.TreeItem, element: TreeNode): Promise<vscode.TreeItem> {
		if (!(element instanceof InMemFileChangeNode) && !(element instanceof RemoteFileChangeNode)) {
			return item;
		}

		await element.resolve();
		const diffCommand = element.command;
		if (!diffCommand) {
			Logger.error(`No diff command for PR #${element.pullRequest.number} file ${element.changeModel.fileName}`, StackPullRequestsTreeDataProvider.ID);
			return element.getTreeItem();
		}

		element.command = {
			command: StackPullRequestsTreeDataProvider.OPEN_FILE_DIFF_COMMAND,
			title: diffCommand.title,
			arguments: [element.pullRequest.number, element.changeModel.fileName, diffCommand],
		};
		Logger.appendLine(
			`Prepared ${diffCommand.command} for PR #${element.pullRequest.number} file ${element.changeModel.fileName}`,
			StackPullRequestsTreeDataProvider.ID,
		);
		return element.getTreeItem();
	}

	private async openFileDiff(prNumber: number, fileName: string, command: vscode.Command): Promise<unknown> {
		Logger.appendLine(`Opening PR #${prNumber} file ${fileName} with ${command.command}`, StackPullRequestsTreeDataProvider.ID);
		try {
			return await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			Logger.error(`Opening PR #${prNumber} file ${fileName} failed: ${message}`, StackPullRequestsTreeDataProvider.ID);
			vscode.window.showErrorMessage(vscode.l10n.t('Failed to open {0}: {1}', fileName, message));
		}
	}

	private async loadRoot(): Promise<TreeNode[]> {
		const generation = this._generation;
		const folderManager = this._reposManager.folderManagers.find(manager => !!manager.activePullRequest);
		if (!folderManager?.activePullRequest) {
			return this.setChildren(generation, [new LabelOnlyNode(this, vscode.l10n.t('No active pull request.'))]);
		}

		try {
			const stack = await this._resolver.resolve(folderManager.activePullRequest);
			if (!stack || stack.size < 2) {
				return this.setChildren(generation, [new LabelOnlyNode(this, vscode.l10n.t('The active pull request is not part of a stack.'))]);
			}

			const pullRequests = this.flattenStack(stack.root);
			Logger.appendLine(
				`Displaying active PR #${folderManager.activePullRequest.number} stack as siblings: ${pullRequests.map(node => `#${node.pullRequest.number}`).join(', ')}`,
				StackPullRequestsTreeDataProvider.ID,
			);
			const pullRequestNodes = pullRequests.map(node => new StackPullRequestNode(
				this,
				node,
				folderManager,
				this._notificationsManager,
				this._prsTreeModel,
			));
			if (generation !== this._generation) {
				disposeAll(pullRequestNodes);
				return this._children;
			}

			Logger.appendLine(
				`Preloading files for ${pullRequestNodes.length} stack pull requests`,
				StackPullRequestsTreeDataProvider.ID,
			);
			await Promise.all(pullRequestNodes.map(node => node.preload()));
			Logger.appendLine(
				`Finished preloading files for ${pullRequestNodes.length} stack pull requests`,
				StackPullRequestsTreeDataProvider.ID,
			);
			return this.setChildren(generation, pullRequestNodes);
		} catch (e) {
			return this.setChildren(generation, [new LabelOnlyNode(this, vscode.l10n.t('Failed to load stacked pull requests: {0}', e instanceof Error ? e.message : String(e)))]);
		}
	}

	private flattenStack(node: StackPullRequestGraphNode): StackPullRequestGraphNode[] {
		return [node, ...node.children.flatMap(child => this.flattenStack(child))];
	}

	private setChildren(generation: number, children: TreeNode[]): TreeNode[] {
		if (generation !== this._generation) {
			disposeAll(children);
			return this._children;
		}
		this._children = children;
		return children;
	}

	override dispose(): void {
		disposeAll(Array.from(this._folderListeners.values()));
		this._folderListeners.clear();
		disposeAll(this._children);
		super.dispose();
	}
}
