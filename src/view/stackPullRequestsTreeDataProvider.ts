/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PrsTreeModel } from './prsTreeModel';
import { StackPullRequestResolver } from './stackPullRequestResolver';
import { Disposable, disposeAll } from '../common/lifecycle';
import Logger from '../common/logger';
import { RepositoriesManager } from '../github/repositoriesManager';
import { NotificationsManager } from '../notifications/notificationsManager';
import { InMemFileChangeNode, RemoteFileChangeNode } from './treeNodes/fileChangeNode';
import { StackPullRequestEntry, StackPullRequestEntryNode } from './treeNodes/stackPullRequestNode';
import { BaseTreeNode, LabelOnlyNode, TreeNode } from './treeNodes/treeNode';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GitHubRepository } from '../github/githubRepository';

interface AvailableRepository {
	folderManager: FolderRepositoryManager;
	githubRepository: GitHubRepository;
	workspaceOwner: string;
	workspaceRepositoryName: string;
	workspaceRemoteName: string;
}

interface RepositorySelection {
	repository: AvailableRepository;
	pullRequestNumber?: number;
}

interface RepositoryQuickPickItem extends vscode.QuickPickItem {
	repository: AvailableRepository;
	pullRequestNumber?: number;
}

export class StackPullRequestsTreeDataProvider extends Disposable implements vscode.TreeDataProvider<TreeNode>, BaseTreeNode {
	private static readonly ID = 'StackPullRequestsTree';
	private static readonly STORAGE_KEY = 'stackPullRequests.entries';
	private static readonly OPEN_FILE_DIFF_COMMAND = 'stackPr.openFileDiff';
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly _view: vscode.TreeView<TreeNode>;
	private _children: TreeNode[] = [];
	private _loadPromise: Promise<TreeNode[]> | undefined;
	private _generation = 0;
	private _storageSnapshot = '';

	constructor(
		private readonly _context: vscode.ExtensionContext,
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
		this._register(vscode.commands.registerCommand('stackPr.add', () => this.addEntry()));
		this._register(vscode.commands.registerCommand('stackPr.refreshEntry', (node: StackPullRequestEntryNode) => this.refreshEntry(node)));
		this._register(vscode.commands.registerCommand('stackPr.removeEntry', (node: StackPullRequestEntryNode) => this.removeEntry(node)));
		this._register(vscode.commands.registerCommand(
			StackPullRequestsTreeDataProvider.OPEN_FILE_DIFF_COMMAND,
			(prNumber: number, fileName: string, command: vscode.Command) => this.openFileDiff(prNumber, fileName, command),
		));
		this._register(this._reposManager.onDidChangeFolderRepositories(() => {
			this.refresh();
		}));
		this._register(this._reposManager.onDidChangeAnyGitHubRepository(() => this.refresh()));
		this._register(vscode.window.onDidChangeWindowState(e => {
			if (e.focused) {
				this.refreshIfStorageChanged();
			}
		}));
		this._storageSnapshot = this.serializeEntries(this.getStoredEntries());
	}

	get view(): vscode.TreeView<TreeNode> {
		return this._view;
	}

	get children(): readonly TreeNode[] {
		return this._children;
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
		const entries = this.getStoredEntries();
		this._storageSnapshot = this.serializeEntries(entries);
		if (entries.length === 0) {
			return this.setChildren(generation, [new LabelOnlyNode(this, vscode.l10n.t('No pull requests or stacks added. Use + to add one.'))]);
		}

		try {
			const repositories = await Promise.all(entries.map(entry => this.findRepository(entry)));
			const entryNodes = entries.flatMap((entry, index) => {
				const repository = repositories[index];
				if (!repository) {
					return [];
				}
				return [new StackPullRequestEntryNode(
					this,
					entry,
					repository.folderManager,
					repository.githubRepository,
					this._resolver,
					this._notificationsManager,
					this._prsTreeModel,
				)];
			});
			if (entryNodes.length === 0) {
				return this.setChildren(generation, [new LabelOnlyNode(this, vscode.l10n.t('No saved pull requests match a repository in this window.'))]);
			}
			if (generation !== this._generation) {
				disposeAll(entryNodes);
				return this._children;
			}

			Logger.appendLine(
				`Preloading ${entryNodes.length} saved pull request entries`,
				StackPullRequestsTreeDataProvider.ID,
			);
			await Promise.all(entryNodes.map(node => node.preload()));
			Logger.appendLine(
				`Finished preloading ${entryNodes.length} saved pull request entries`,
				StackPullRequestsTreeDataProvider.ID,
			);
			return this.setChildren(generation, entryNodes);
		} catch (e) {
			return this.setChildren(generation, [new LabelOnlyNode(this, vscode.l10n.t('Failed to load saved pull requests: {0}', e instanceof Error ? e.message : String(e)))]);
		}
	}

	private async addEntry(): Promise<void> {
		const selection = await this.pickWorkspaceRepository();
		if (!selection) {
			return;
		}
		const repository = selection.repository;
		let pullRequestNumber = selection.pullRequestNumber;

		if (pullRequestNumber === undefined) {
			const input = await vscode.window.showInputBox({
				prompt: vscode.l10n.t(
					'Enter a pull request or stack number for {0}/{1}',
					repository.githubRepository.remote.owner,
					repository.githubRepository.remote.repositoryName,
				),
				placeHolder: '123',
				ignoreFocusOut: true,
				validateInput: value => this.parsePullRequestNumber(value)
					? undefined
					: vscode.l10n.t('Enter a valid pull request or stack number.'),
			});
			if (!input) {
				return;
			}
			pullRequestNumber = this.parsePullRequestNumber(input)!;
		}

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Window,
			title: vscode.l10n.t('Adding pull request or stack...'),
		}, async () => this.validateAndStoreEntry(pullRequestNumber!, repository));
	}

	private async validateAndStoreEntry(
		pullRequestNumber: number,
		repository: AvailableRepository,
	): Promise<void> {
		try {
			const pullRequest = await repository.githubRepository.getPullRequest(
				pullRequestNumber,
				StackPullRequestsTreeDataProvider.ID,
			);
			if (!pullRequest?.isResolved()) {
				const stackPullRequestNumbers = await repository.githubRepository.getPullRequestNumbersForStack(pullRequestNumber);
				if (!stackPullRequestNumbers?.length) {
					throw new Error(vscode.l10n.t(
						'Pull request or stack #{0} not found in {1}/{2}.',
						pullRequestNumber,
						repository.githubRepository.remote.owner,
						repository.githubRepository.remote.repositoryName,
					));
				}
			}

			const entry: StackPullRequestEntry = {
				workspaceOwner: repository.workspaceOwner,
				workspaceRepositoryName: repository.workspaceRepositoryName,
				owner: repository.githubRepository.remote.owner,
				repositoryName: repository.githubRepository.remote.repositoryName,
				pullRequestNumber,
			};
			const entries = this.getStoredEntries();
			if (entries.some(existing => this.entryKey(existing) === this.entryKey(entry))) {
				vscode.window.showInformationMessage(vscode.l10n.t('That pull request or stack is already in this view.'));
				return;
			}

			entries.push(entry);
			await this.storeEntries(entries);
			this.refresh();
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			Logger.error(`Adding pull request entry failed: ${message}`, StackPullRequestsTreeDataProvider.ID);
			vscode.window.showErrorMessage(vscode.l10n.t('Failed to add pull request: {0}', message));
		}
	}

	private async refreshEntry(node: StackPullRequestEntryNode | undefined): Promise<void> {
		if (!node) {
			return;
		}
		await node.reload();
		this._onDidChangeTreeData.fire(node);
	}

	private async removeEntry(node: StackPullRequestEntryNode | undefined): Promise<void> {
		if (!node) {
			return;
		}
		const key = this.entryKey(node.entry);
		await this.storeEntries(this.getStoredEntries().filter(entry => this.entryKey(entry) !== key));
		this.refresh();
	}

	private parsePullRequestNumber(value: string): number | undefined {
		const input = value.trim();
		const match = /^#?(\d+)$/.exec(input);
		const pullRequestNumber = match ? Number(match[1]) : undefined;
		return pullRequestNumber && Number.isSafeInteger(pullRequestNumber) ? pullRequestNumber : undefined;
	}

	private async getWorkspaceRepositories(): Promise<AvailableRepository[]> {
		const repositories = await Promise.all(this._reposManager.folderManagers.map(async folderManager => {
			const remotes = await folderManager.getAllGitHubRemotes();
			return Promise.all(remotes.map(async remote => {
				const githubRepository = folderManager.findExistingGitHubRepository({
					owner: remote.owner,
					repositoryName: remote.repositoryName,
					remoteName: remote.remoteName,
				}) ?? folderManager.findExistingGitHubRepository({
					owner: remote.owner,
					repositoryName: remote.repositoryName,
				}) ?? await folderManager.createGitHubRepositoryFromOwnerName(remote.owner, remote.repositoryName);
				if (!githubRepository) {
					return undefined;
				}
				return {
					folderManager,
					githubRepository,
					workspaceOwner: remote.owner,
					workspaceRepositoryName: remote.repositoryName,
					workspaceRemoteName: remote.remoteName,
				};
			}));
		}));
		return repositories.flat().filter((repository): repository is AvailableRepository => !!repository);
	}

	private async pickWorkspaceRepository(): Promise<RepositorySelection | undefined> {
		const repositories = await this.getWorkspaceRepositories();
		if (repositories.length === 0) {
			vscode.window.showErrorMessage(vscode.l10n.t('No GitHub repository is available in this window.'));
			return undefined;
		}
		if (repositories.length === 1) {
			return { repository: repositories[0] };
		}

		const remoteItems: RepositoryQuickPickItem[] = repositories.map(repository => ({
			label: `${repository.workspaceOwner}/${repository.workspaceRepositoryName}`,
			description: repository.workspaceRemoteName,
			detail: repository.folderManager.repository.rootUri.fsPath,
			repository,
		}));
		const origins = repositories.filter(repository => repository.workspaceRemoteName.toLowerCase() === 'origin');
		const origin = origins.length === 1 ? origins[0] : undefined;

		return new Promise(resolve => {
			const quickPick = vscode.window.createQuickPick<RepositoryQuickPickItem>();
			const subscriptions: vscode.Disposable[] = [];
			let settled = false;
			const finish = (selection: RepositorySelection | undefined) => {
				if (settled) {
					return;
				}
				settled = true;
				for (const subscription of subscriptions) {
					subscription.dispose();
				}
				quickPick.dispose();
				resolve(selection);
			};
			const updateItems = (value: string) => {
				const pullRequestNumber = this.parsePullRequestNumber(value);
				if (pullRequestNumber !== undefined && origin) {
					quickPick.items = [{
						label: vscode.l10n.t('Add pull request or stack #{0}', pullRequestNumber),
						description: vscode.l10n.t('Use origin: {0}/{1}', origin.workspaceOwner, origin.workspaceRepositoryName),
						detail: vscode.l10n.t('Press Enter to add directly'),
						repository: origin,
						pullRequestNumber,
					}, ...remoteItems];
				} else {
					quickPick.items = remoteItems;
				}
			};

			quickPick.placeholder = origin
				? vscode.l10n.t('Choose a remote, or enter a pull request or stack number to use origin')
				: vscode.l10n.t('Choose the remote containing the pull request or stack');
			quickPick.matchOnDescription = true;
			quickPick.matchOnDetail = true;
			quickPick.items = remoteItems;
			subscriptions.push(quickPick.onDidChangeValue(updateItems));
			subscriptions.push(quickPick.onDidAccept(() => {
				const pullRequestNumber = this.parsePullRequestNumber(quickPick.value);
				if (pullRequestNumber !== undefined) {
					if (origin) {
						finish({ repository: origin, pullRequestNumber });
					} else {
						quickPick.prompt = vscode.l10n.t('No unambiguous origin remote is available. Choose a remote from the list.');
					}
					return;
				}

				const selected = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
				if (selected) {
					finish({ repository: selected.repository });
				}
			}));
			subscriptions.push(quickPick.onDidHide(() => finish(undefined)));
			quickPick.show();
		});
	}

	private async findRepository(entry: StackPullRequestEntry): Promise<AvailableRepository | undefined> {
		const folderManager = this._reposManager.getManagerForRepository(entry.workspaceOwner, entry.workspaceRepositoryName);
		if (!folderManager) {
			return undefined;
		}
		const workspaceRepository = folderManager.findExistingGitHubRepository({
			owner: entry.workspaceOwner,
			repositoryName: entry.workspaceRepositoryName,
		});
		if (!workspaceRepository) {
			return undefined;
		}
		const githubRepository = folderManager.findExistingGitHubRepository({
			owner: entry.owner,
			repositoryName: entry.repositoryName,
		}) ?? await folderManager.createGitHubRepositoryFromOwnerName(entry.owner, entry.repositoryName);
		if (!githubRepository) {
			return undefined;
		}
		return {
			folderManager,
			githubRepository,
			workspaceOwner: workspaceRepository.remote.owner,
			workspaceRepositoryName: workspaceRepository.remote.repositoryName,
			workspaceRemoteName: workspaceRepository.remote.remoteName,
		};
	}

	private getStoredEntries(): StackPullRequestEntry[] {
		const entries = this._context.globalState.get<unknown>(StackPullRequestsTreeDataProvider.STORAGE_KEY, []);
		if (!Array.isArray(entries)) {
			return [];
		}
		return entries.filter((entry): entry is StackPullRequestEntry => {
			if (!entry || typeof entry !== 'object') {
				return false;
			}
			const candidate = entry as Partial<StackPullRequestEntry>;
			return typeof candidate.workspaceOwner === 'string'
				&& typeof candidate.workspaceRepositoryName === 'string'
				&& typeof candidate.owner === 'string'
				&& typeof candidate.repositoryName === 'string'
				&& typeof candidate.pullRequestNumber === 'number'
				&& Number.isInteger(candidate.pullRequestNumber)
				&& candidate.pullRequestNumber > 0;
		});
	}

	private async storeEntries(entries: StackPullRequestEntry[]): Promise<void> {
		await this._context.globalState.update(StackPullRequestsTreeDataProvider.STORAGE_KEY, entries);
		this._storageSnapshot = this.serializeEntries(entries);
	}

	private refreshIfStorageChanged(): void {
		const snapshot = this.serializeEntries(this.getStoredEntries());
		if (snapshot !== this._storageSnapshot) {
			this.refresh();
		}
	}

	private serializeEntries(entries: StackPullRequestEntry[]): string {
		return JSON.stringify(entries);
	}

	private entryKey(entry: StackPullRequestEntry): string {
		return `${entry.owner}/${entry.repositoryName}#${entry.pullRequestNumber}`.toLowerCase();
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
		disposeAll(this._children);
		super.dispose();
	}
}
