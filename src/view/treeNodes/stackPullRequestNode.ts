/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PRNode } from './pullRequestNode';
import { LabelOnlyNode, TreeNode, TreeNodeParent } from './treeNode';
import Logger from '../../common/logger';
import { FolderRepositoryManager } from '../../github/folderRepositoryManager';
import { NotificationsManager } from '../../notifications/notificationsManager';
import { PrsTreeModel } from '../prsTreeModel';
import { StackPullRequestGraphNode } from '../stackPullRequestResolver';

const STACK_PULL_REQUEST_NODE = 'StackPullRequestNode';

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
