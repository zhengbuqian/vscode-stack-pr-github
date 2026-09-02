/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PRNode } from './pullRequestNode';
import { LabelOnlyNode, TreeNode, TreeNodeParent } from './treeNode';
import { disposeAll } from '../../common/lifecycle';
import Logger from '../../common/logger';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { GitHubRepository } from '../../github/githubRepository';
import { NotificationsManager } from '../../notifications/notificationsManager';
import { PrsTreeModel } from '../prsTreeModel';
import { StackPullRequestGraphNode, StackPullRequestResolver } from '../stackPullRequestResolver';

const STACK_PULL_REQUEST_NODE = 'StackPullRequestNode';

export type StackPullRequestEntryKind = 'pullRequest' | 'stack';

export interface StackPullRequestEntry {
	kind: StackPullRequestEntryKind;
	workspaceOwner: string;
	workspaceRepositoryName: string;
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
	readonly iconPath: vscode.ThemeIcon;
	private _loadPromise: Promise<TreeNode[]> | undefined;
	private _pullRequestCount: number | undefined;

	constructor(
		parent: TreeNodeParent,
		readonly entry: StackPullRequestEntry,
		private readonly _folderRepositoryManager: FolderRepositoryManager,
		private readonly _githubRepository: GitHubRepository,
		private readonly _resolver: StackPullRequestResolver,
		private readonly _notificationsManager: NotificationsManager,
		private readonly _prsTreeModel: PrsTreeModel,
	) {
		super(parent);
		this.id = `stack-pr-entry:${entry.kind}:${entry.owner.toLowerCase()}/${entry.repositoryName.toLowerCase()}#${entry.pullRequestNumber}`;
		this.label = entry.kind === 'stack'
			? vscode.l10n.t('Stack {0}/{1} #{2}', entry.owner, entry.repositoryName, entry.pullRequestNumber)
			: vscode.l10n.t('Pull Request {0}/{1} #{2}', entry.owner, entry.repositoryName, entry.pullRequestNumber);
		this.iconPath = new vscode.ThemeIcon(entry.kind === 'stack' ? 'layers' : 'git-pull-request');
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
			tooltip: this.entry.kind === 'stack'
				? vscode.l10n.t('Stack containing {0}/{1}#{2}', this.entry.owner, this.entry.repositoryName, this.entry.pullRequestNumber)
				: vscode.l10n.t('Pull request {0}/{1}#{2}', this.entry.owner, this.entry.repositoryName, this.entry.pullRequestNumber),
			collapsibleState: this.collapsibleState,
			contextValue: this.contextValue,
			iconPath: this.iconPath,
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

	async reload(): Promise<TreeNode[]> {
		this.disposeChildren();
		this._loadPromise = undefined;
		this._pullRequestCount = undefined;
		return this.preload();
	}

	private async loadChildren(): Promise<TreeNode[]> {
		try {
			const pullRequest = await this._githubRepository.getPullRequest(
				this.entry.pullRequestNumber,
				STACK_PULL_REQUEST_NODE,
			);
			if (!pullRequest?.isResolved()) {
				throw new Error(vscode.l10n.t('Pull request not found.'));
			}

			let pullRequests: StackPullRequestGraphNode[];
			if (this.entry.kind === 'stack') {
				const stack = await this._resolver.resolve(pullRequest);
				if (!stack || stack.size < 2) {
					throw new Error(vscode.l10n.t('The pull request is not part of an open stack.'));
				}
				pullRequests = this.flattenStack(stack.root);
			} else {
				pullRequests = [{ pullRequest, children: [] }];
			}

			const pullRequestNodes = pullRequests.map(node => new StackPullRequestNode(
				this,
				node,
				this._folderRepositoryManager,
				this._notificationsManager,
				this._prsTreeModel,
			));
			await Promise.all(pullRequestNodes.map(node => node.preload()));
			this._pullRequestCount = pullRequestNodes.length;
			this._children = pullRequestNodes;
			Logger.appendLine(
				`Preloaded ${pullRequestNodes.length} pull requests for ${this.id}`,
				STACK_PULL_REQUEST_NODE,
			);
			return pullRequestNodes;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			Logger.error(`Failed to load ${this.id}: ${message}`, STACK_PULL_REQUEST_NODE);
			const children = [new LabelOnlyNode(this, vscode.l10n.t('Failed to load: {0}', message))];
			this._children = children;
			return children;
		}
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
	) {
		super(
			parent,
			folderRepositoryManager,
			graphNode.pullRequest,
			false,
			notificationsManager,
			prsTreeModel,
			{ forceRemote: true },
		);
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
