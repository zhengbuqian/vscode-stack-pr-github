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
import { StackPullRequestEntry, StackPullRequestEntryKind, StackPullRequestEntryNode } from './treeNodes/stackPullRequestNode';
import { BaseTreeNode, LabelOnlyNode, TreeNode } from './treeNodes/treeNode';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GitHubRepository } from '../github/githubRepository';

interface ParsedPullRequestInput {
	owner?: string;
	repositoryName?: string;
	pullRequestNumber: number;
}

interface AvailableRepository {
	folderManager: FolderRepositoryManager;
	githubRepository: GitHubRepository;
	workspaceOwner: string;
	workspaceRepositoryName: string;
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
		const selected = await vscode.window.showQuickPick([
			{
				label: vscode.l10n.t('Pull Request'),
				description: vscode.l10n.t('Add only one pull request'),
				entryKind: 'pullRequest' as const,
			},
			{
				label: vscode.l10n.t('Stack'),
				description: vscode.l10n.t('Discover and add the entire open stack'),
				entryKind: 'stack' as const,
			},
		], {
			placeHolder: vscode.l10n.t('What would you like to add?'),
		});
		if (!selected) {
			return;
		}

		const input = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Enter a pull request URL, owner/repository#number, or pull request number'),
			placeHolder: 'https://github.com/owner/repository/pull/123',
			ignoreFocusOut: true,
			validateInput: value => this.parsePullRequestInput(value)
				? undefined
				: vscode.l10n.t('Enter a valid pull request URL or number.'),
		});
		if (!input) {
			return;
		}

		const parsed = this.parsePullRequestInput(input)!;
		const repository = await this.resolveInputRepository(parsed);
		if (!repository) {
			return;
		}

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Window,
			title: selected.entryKind === 'stack'
				? vscode.l10n.t('Adding pull request stack...')
				: vscode.l10n.t('Adding pull request...'),
		}, async () => this.validateAndStoreEntry(selected.entryKind, parsed.pullRequestNumber, repository));
	}

	private async validateAndStoreEntry(
		kind: StackPullRequestEntryKind,
		pullRequestNumber: number,
		repository: AvailableRepository,
	): Promise<void> {
		try {
			const pullRequest = await repository.githubRepository.getPullRequest(
				pullRequestNumber,
				StackPullRequestsTreeDataProvider.ID,
			);
			if (!pullRequest?.isResolved()) {
				throw new Error(vscode.l10n.t('Pull request not found.'));
			}

			if (kind === 'stack') {
				const stack = await this._resolver.resolve(pullRequest);
				if (!stack || stack.size < 2) {
					throw new Error(vscode.l10n.t('The pull request is not part of an open stack.'));
				}
			}

			const entry: StackPullRequestEntry = {
				kind,
				workspaceOwner: repository.workspaceOwner,
				workspaceRepositoryName: repository.workspaceRepositoryName,
				owner: repository.githubRepository.remote.owner,
				repositoryName: repository.githubRepository.remote.repositoryName,
				pullRequestNumber: pullRequest.number,
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

	private parsePullRequestInput(value: string): ParsedPullRequestInput | undefined {
		const input = value.trim();
		let match = /^https?:\/\/[^/]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(input);
		if (match) {
			return { owner: match[1], repositoryName: match[2], pullRequestNumber: Number(match[3]) };
		}
		match = /^([^/\s]+)\/([^/#\s]+)#(\d+)$/.exec(input);
		if (match) {
			return { owner: match[1], repositoryName: match[2], pullRequestNumber: Number(match[3]) };
		}
		match = /^#?(\d+)$/.exec(input);
		if (match) {
			return { pullRequestNumber: Number(match[1]) };
		}
		return undefined;
	}

	private async resolveInputRepository(parsed: ParsedPullRequestInput): Promise<AvailableRepository | undefined> {
		const repositories = this.getAvailableRepositories();
		if (parsed.owner && parsed.repositoryName) {
			const existingRepository = repositories.find(candidate =>
				candidate.githubRepository.remote.owner.toLowerCase() === parsed.owner!.toLowerCase()
				&& candidate.githubRepository.remote.repositoryName.toLowerCase() === parsed.repositoryName!.toLowerCase(),
			);
			if (existingRepository) {
				return existingRepository;
			}

			const workspaceRepository = await this.pickWorkspaceRepository();
			if (!workspaceRepository) {
				return undefined;
			}
			const githubRepository = await workspaceRepository.folderManager.createGitHubRepositoryFromOwnerName(
				parsed.owner,
				parsed.repositoryName,
			);
			if (!githubRepository) {
				vscode.window.showErrorMessage(vscode.l10n.t('Unable to access {0}/{1}.', parsed.owner, parsed.repositoryName));
				return undefined;
			}
			return { ...workspaceRepository, githubRepository };
		}

		if (repositories.length === 0) {
			vscode.window.showErrorMessage(vscode.l10n.t('No GitHub repository is available in this window.'));
			return undefined;
		}
		if (repositories.length === 1) {
			return repositories[0];
		}

		return (await vscode.window.showQuickPick(repositories.map(repository => ({
			label: `${repository.githubRepository.remote.owner}/${repository.githubRepository.remote.repositoryName}`,
			description: repository.folderManager.repository.rootUri.fsPath,
			repository,
		})), {
			placeHolder: vscode.l10n.t('Choose the repository containing the pull request'),
		}))?.repository;
	}

	private getAvailableRepositories(): AvailableRepository[] {
		const repositories = new Map<string, AvailableRepository>();
		for (const folderManager of this._reposManager.folderManagers) {
			const workspaceRepository = folderManager.gitHubRepositories[0];
			if (!workspaceRepository) {
				continue;
			}
			for (const githubRepository of folderManager.gitHubRepositories) {
				const key = `${githubRepository.remote.owner}/${githubRepository.remote.repositoryName}`.toLowerCase();
				if (!repositories.has(key)) {
					repositories.set(key, {
						folderManager,
						githubRepository,
						workspaceOwner: workspaceRepository.remote.owner,
						workspaceRepositoryName: workspaceRepository.remote.repositoryName,
					});
				}
			}
		}
		return Array.from(repositories.values());
	}

	private getWorkspaceRepositories(): AvailableRepository[] {
		return this._reposManager.folderManagers.flatMap(folderManager => {
			const githubRepository = folderManager.gitHubRepositories[0];
			if (!githubRepository) {
				return [];
			}
			return [{
				folderManager,
				githubRepository,
				workspaceOwner: githubRepository.remote.owner,
				workspaceRepositoryName: githubRepository.remote.repositoryName,
			}];
		});
	}

	private async pickWorkspaceRepository(): Promise<AvailableRepository | undefined> {
		const repositories = this.getWorkspaceRepositories();
		if (repositories.length === 0) {
			vscode.window.showErrorMessage(vscode.l10n.t('No GitHub repository is available in this window.'));
			return undefined;
		}
		if (repositories.length === 1) {
			return repositories[0];
		}
		return (await vscode.window.showQuickPick(repositories.map(repository => ({
			label: `${repository.workspaceOwner}/${repository.workspaceRepositoryName}`,
			description: repository.folderManager.repository.rootUri.fsPath,
			repository,
		})), {
			placeHolder: vscode.l10n.t('Choose the workspace repository for this pull request'),
		}))?.repository;
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
			return (candidate.kind === 'pullRequest' || candidate.kind === 'stack')
				&& typeof candidate.workspaceOwner === 'string'
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
		return `${entry.kind}:${entry.owner}/${entry.repositoryName}#${entry.pullRequestNumber}`.toLowerCase();
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
