/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PRNode } from './pullRequestNode';
import { StackPullRequestCache, StackSnapshot } from '../stackPullRequestCache';
import { LabelOnlyNode, TreeNode, TreeNodeParent } from './treeNode';
import { disposeAll } from '../../common/lifecycle';
import Logger from '../../common/logger';
import { fromPRUri } from '../../common/uri';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { GitHubRepository } from '../../github/githubRepository';
import { NotificationsManager } from '../../notifications/notificationsManager';
import { PrsTreeModel } from '../prsTreeModel';
import { StackPullRequestGraphNode, StackPullRequestResolver } from '../stackPullRequestResolver';

const STACK_PULL_REQUEST_NODE = 'StackPullRequestNode';

export interface StackPullRequestEntry {
	workspaceOwner: string;
	workspaceRepositoryName: string;
	workspaceRemoteName?: string;
	owner: string;
	repositoryName: string;
	pullRequestNumber: number;
}

function disposeTree(nodes: readonly TreeNode[]): void {
	for (const node of nodes) {
		if (node.children) {
			disposeTree(node.children);
		}
		node.dispose();
	}
}

class StackChangesNode extends TreeNode implements vscode.TreeItem {
	readonly collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
	readonly contextValue = 'stack-pull-request-changes';
	readonly iconPath = new vscode.ThemeIcon('files');

	constructor(parent: TreeNodeParent, private readonly fileChanges: TreeNode[], fileCount: number) {
		super(parent);
		this.label = vscode.l10n.t('Changes');
		this.description = fileCount.toString();
		this.id = `${parent instanceof StackPullRequestNode ? parent.pullRequestModel.html_url : ''}/changes`;
		for (const child of fileChanges) {
			child.parent = this;
		}
	}

	getTreeItem(): vscode.TreeItem {
		return this;
	}

	override async getChildren(): Promise<TreeNode[]> {
		this._children = this.fileChanges;
		return this.fileChanges;
	}

	override dispose(): void {
		disposeTree(this.fileChanges);
		super.dispose();
	}
}

export class StackPullRequestEntryNode extends TreeNode implements vscode.TreeItem {
	readonly collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
	readonly contextValue = 'stack-pull-request-entry';
	private _loadPromise: Promise<TreeNode[]> | undefined;
	private _pullRequestCount: number | undefined;
	private _isStack = false;
	private _snapshot: StackSnapshot | undefined;
	private readonly _cache: Promise<StackPullRequestCache>;
	private _refreshError: string | undefined;

	constructor(
		parent: TreeNodeParent,
		readonly entry: StackPullRequestEntry,
		private readonly _folderRepositoryManager: FolderRepositoryManager,
		private readonly _githubRepository: GitHubRepository,
		private readonly _resolver: StackPullRequestResolver,
		private readonly _notificationsManager: NotificationsManager,
		private readonly _prsTreeModel: PrsTreeModel,
		repositoryReference: vscode.Disposable,
		storageUri: vscode.Uri,
	) {
		super(parent);
		this._cache = StackPullRequestCache.forEntry(storageUri, _githubRepository, entry.pullRequestNumber);
		this._register(new vscode.Disposable(() => {
			// An obsolete load must finish releasing its PR nodes before releasing the repository.
			if (this._loadPromise) {
				void this._loadPromise.then(() => repositoryReference.dispose(), () => repositoryReference.dispose());
			} else {
				repositoryReference.dispose();
			}
		}));
		this.id = `stack-pr-entry:${entry.owner.toLowerCase()}/${entry.repositoryName.toLowerCase()}#${entry.pullRequestNumber}`;
		this.label = vscode.l10n.t('Pull Request {0}/{1} #{2}', entry.owner, entry.repositoryName, entry.pullRequestNumber);
	}

	getTreeItem(): vscode.TreeItem {
		return {
			id: this.id,
			label: this.label,
			description: this._pullRequestCount === undefined
				? undefined
				: this._pullRequestCount === 1
					? vscode.l10n.t('1 pull request')
					: vscode.l10n.t('{0} pull requests', this._pullRequestCount),
			tooltip: `${this._snapshot ? vscode.l10n.t('Cached at {0}. Refresh to get updates.', new Date(this._snapshot.updatedAt).toLocaleString()) : ''}${this._refreshError ? `\n${this._refreshError}` : ''}\n` + (this._isStack
				? vscode.l10n.t('Stack containing {0}/{1}#{2}', this.entry.owner, this.entry.repositoryName, this.entry.pullRequestNumber)
				: vscode.l10n.t('Pull request {0}/{1}#{2}', this.entry.owner, this.entry.repositoryName, this.entry.pullRequestNumber)),
			collapsibleState: this.collapsibleState,
			contextValue: this.contextValue,
			iconPath: new vscode.ThemeIcon(this._isStack ? 'layers' : 'git-pull-request'),
		};
	}

	preload(): Promise<TreeNode[]> {
		if (!this._loadPromise) {
			this._loadPromise = this.loadChildren();
		}
		return this._loadPromise;
	}

	override getChildren(): Promise<TreeNode[]> {
		return this.preload();
	}

	private _refreshPromise: Promise<TreeNode[]> | undefined;

	reload(): Promise<TreeNode[]> {
		this._refreshPromise ??= this.refreshSnapshot().finally(() => { this._refreshPromise = undefined; });
		return this._refreshPromise;
	}

	private async refreshSnapshot(): Promise<TreeNode[]> {
		await this._loadPromise;
		const refresh = this.loadChildren(true);
		this._loadPromise = refresh;
		try { return await refresh; }
		catch (e) {
			this._loadPromise = Promise.resolve(this._children ?? []);
			throw e;
		}
	}

	containsDocument(uri: vscode.Uri): boolean {
		const params = fromPRUri(uri);
		return !!params && params.remoteName === this._githubRepository.remote.remoteName
			&& uri.path.startsWith(`${this._folderRepositoryManager.repository.rootUri.path}/`)
			&& !!this._snapshot?.pullRequests.some(pr => pr.item.number === params.prNumber);
	}

	async readCachedContent(uri: vscode.Uri): Promise<Uint8Array> {
		return (await this._cache).readContent(this._snapshot!, fromPRUri(uri)!);
	}

	async removeCache(): Promise<void> { await this._loadPromise; this.disposeChildren(); await (await this._cache).remove(); }

	private async loadChildren(refresh = false): Promise<TreeNode[]> {
		const oldIsStack = this._isStack;
		const oldLabel = this.label;
		try {
			const cache = await this._cache;
			let snapshot = refresh ? undefined : await cache.read();
			if (!snapshot) {
				const graph = await this.loadRemotePullRequests();
				const models = graph.map(node => this._githubRepository.createDetachedPullRequestModel(node.pullRequest.item));
				try {
					const results = await Promise.allSettled(models.flatMap(model => [
						model.getFileChangesInfo(), model.initializeReviewThreadCache(true),
						model.initializePullRequestFileViewState(), model.validateDraftMode(true),
					]));
					const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
					if (failed) { throw failed.reason; }
					snapshot = await cache.prepare(models, this._isStack, this._folderRepositoryManager, this._githubRepository);
					if (this.isDisposed) { await cache.discard(snapshot.id); return []; }
					await cache.publish(snapshot);
				} finally { disposeAll(models); }
			}
			if (this.isDisposed) { return []; }
			this.disposeChildren();
			this._snapshot = snapshot;
			this._refreshError = undefined;
			this._isStack = snapshot.isStack;
			this.label = this._isStack
				? vscode.l10n.t('Stack {0}/{1} #{2}', this.entry.owner, this.entry.repositoryName, this.entry.pullRequestNumber)
				: vscode.l10n.t('Pull Request {0}/{1} #{2}', this.entry.owner, this.entry.repositoryName, this.entry.pullRequestNumber);
			const nodes = await Promise.all(snapshot.pullRequests.map(async saved => {
				const model = this._githubRepository.createDetachedPullRequestModel(saved.item);
				await model.restoreSnapshot(saved);
				model.snapshotCurrentUser = snapshot.currentUser;
				return new StackPullRequestNode(this, { pullRequest: model, children: [] }, this._folderRepositoryManager,
					this._notificationsManager, this._prsTreeModel, cache, snapshot);
			}));
			await Promise.all(nodes.map(node => node.preload()));
			if (this.isDisposed) { disposeAll(nodes); return []; }
			this._pullRequestCount = nodes.length;
			this._children = nodes;
			Logger.appendLine(`Restored ${nodes.length} PRs from disk for ${this.id}; snapshot ${snapshot.updatedAt}`, STACK_PULL_REQUEST_NODE);
			return nodes;
		} catch (e) {
			this._isStack = oldIsStack;
			this.label = oldLabel;
			this._refreshError = e instanceof Error ? e.message : String(e);
			Logger.error(`Failed to load ${this.id}: ${this._refreshError}`, STACK_PULL_REQUEST_NODE);
			if (refresh) { throw e; }
			this._children = [new LabelOnlyNode(this, vscode.l10n.t('Failed to load: {0}', this._refreshError))];
			return this._children;
		}
	}

	private async loadRemotePullRequests(): Promise<StackPullRequestGraphNode[]> {
		const pullRequest = await this._githubRepository.getPullRequest(
			this.entry.pullRequestNumber,
			STACK_PULL_REQUEST_NODE,
		);
		let pullRequests: StackPullRequestGraphNode[];
		if (pullRequest?.isResolved()) {
			const stack = await this._resolver.resolve(pullRequest, true);
			if (stack && stack.size >= 2) {
				this._isStack = true;
				this.label = vscode.l10n.t('Stack {0}/{1} #{2}', this.entry.owner, this.entry.repositoryName, this.entry.pullRequestNumber);
				pullRequests = this.flattenStack(stack.root);
			} else {
				this._isStack = false;
				this.label = vscode.l10n.t('Pull Request {0}/{1} #{2}', this.entry.owner, this.entry.repositoryName, this.entry.pullRequestNumber);
				pullRequests = [{ pullRequest, children: [] }];
			}
		} else {
			const stackPullRequestNumbers = await this._githubRepository.getPullRequestNumbersForStack(this.entry.pullRequestNumber);
			if (!stackPullRequestNumbers?.length) {
				throw new Error(vscode.l10n.t('Pull request or stack not found.'));
			}
			const stackPullRequests = await Promise.all(stackPullRequestNumbers.map(number =>
				this._githubRepository.getPullRequest(number, STACK_PULL_REQUEST_NODE),
			));
			if (stackPullRequests.some(member => !member?.isResolved())) {
				throw new Error(vscode.l10n.t('One or more pull requests in stack #{0} could not be loaded.', this.entry.pullRequestNumber));
			}
			this._isStack = true;
			this.label = vscode.l10n.t('Stack {0}/{1} #{2}', this.entry.owner, this.entry.repositoryName, this.entry.pullRequestNumber);
			pullRequests = stackPullRequests.map(member => ({ pullRequest: member!, children: [] }));
		}

		return pullRequests;
	}

	private flattenStack(node: StackPullRequestGraphNode): StackPullRequestGraphNode[] {
		return [node, ...node.children.flatMap(child => this.flattenStack(child))];
	}

	private disposeChildren(): void {
		if (this._children) {
			disposeAll(this._children);
			this._children = undefined;
		}
	}

	override dispose(): void {
		this.disposeChildren();
		super.dispose();
	}
}

export class StackPullRequestNode extends PRNode {
	private _loadPromise: Promise<TreeNode[]> | undefined;

	constructor(
		parent: TreeNodeParent,
		private readonly graphNode: StackPullRequestGraphNode,
		folderRepositoryManager: FolderRepositoryManager,
		notificationsManager: NotificationsManager,
		prsTreeModel: PrsTreeModel,
		cache: StackPullRequestCache,
		snapshot: StackSnapshot,
	) {
		super(
			parent,
			folderRepositoryManager,
			graphNode.pullRequest,
			false,
			notificationsManager,
			prsTreeModel,
			{ forceRemote: true, appendPullRequestNumber: true, cachedContent: params => cache.readContent(snapshot, params) },
		);
		this._register(graphNode.pullRequest);
		const persist = () => {
			void cache.updatePullRequest(snapshot.id, this.pullRequestModel).catch(e => {
				Logger.error(`Could not save updated Stack PR: ${e}`, STACK_PULL_REQUEST_NODE);
				vscode.window.showWarningMessage(vscode.l10n.t('The GitHub change succeeded, but the disk cache could not be updated. Refresh this stack before reloading.'));
			});
		};
		this._register(this.pullRequestModel.onDidChangeReviewThreads(persist));
		this._register(this.pullRequestModel.onDidChangeFileViewedState(persist));
		this._register(this.pullRequestModel.onDidChangePendingReviewState(persist));
		this._register(this.pullRequestModel.onDidChange(persist));
	}

	preload(): Promise<TreeNode[]> {
		if (!this._loadPromise) {
			this._loadPromise = this.loadChildren();
		}
		return this._loadPromise;
	}

	override getChildren(): Promise<TreeNode[]> {
		return this.preload();
	}

	private async loadChildren(): Promise<TreeNode[]> {
		try {
			const displayedChanges = await super.getChildren();
			const fileCount = (await this.getFileChanges()).length;
			Logger.appendLine(
				`PR #${this.pullRequestModel.number}: cached ${fileCount} changed files rendered as ${displayedChanges.length} tree roots`,
				STACK_PULL_REQUEST_NODE,
			);
			const children: TreeNode[] = [];
			if (displayedChanges.length > 0) {
				children.push(new StackChangesNode(this, displayedChanges, fileCount));
			}
			this._children = children;
			return children;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			Logger.error(`Failed to preload changes for PR #${this.pullRequestModel.number}: ${message}`, STACK_PULL_REQUEST_NODE);
			const children = [new LabelOnlyNode(this, vscode.l10n.t('Failed to load changes: {0}', message))];
			this._children = children;
			return children;
		}
	}

	override dispose(): void {
		if (this._children) {
			for (const child of this._children) {
				child.dispose();
			}
			this._children = undefined;
		}
		super.dispose();
	}
}
