/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PrsTreeModel } from './prsTreeModel';
import { StackPullRequestResolver } from './stackPullRequestResolver';
import { GitChangeType } from '../common/file';
import { Disposable, disposeAll } from '../common/lifecycle';
import Logger from '../common/logger';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { RepositoriesManager } from '../github/repositoriesManager';
import { NotificationsManager } from '../notifications/notificationsManager';
import { InMemFileChangeNode, RemoteFileChangeNode } from './treeNodes/fileChangeNode';
import { StackPullRequestEntry, StackPullRequestEntryNode } from './treeNodes/stackPullRequestNode';
import { BaseTreeNode, LabelOnlyNode, TreeNode } from './treeNodes/treeNode';
import { TreeUtils } from './treeNodes/treeUtils';
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
	private static readonly STORAGE_FILE_NAME = 'stack-pull-requests.json';
	private static readonly OPEN_FILE_DIFF_COMMAND = 'stackPr.openFileDiff';
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly _view: vscode.TreeView<TreeNode>;
	private _children: TreeNode[] = [];
	private _loadPromise: Promise<TreeNode[]> | undefined;
	private _generation = 0;
	private _storageSnapshot: string | undefined;

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
			manageCheckboxStateManually: true,
		}));
		this._register(this._onDidChangeTreeData);
		this._register(this._view.onDidChangeCheckboxState(e => TreeUtils.processCheckboxUpdates(e, this._view.selection)));
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
				void this.refreshIfStorageChanged();
			}
		}));
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
		const diffCommand = element instanceof InMemFileChangeNode && element.status === GitChangeType.ADD
			? await element.getOpenDiffCommand()
			: element.command;
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
		const entries = await this.getStoredEntries();
		this._storageSnapshot = this.serializeEntries(entries);
		Logger.appendLine(
			`Restoring ${entries.length} globally saved entries: ${this.describeEntries(entries)}`,
			StackPullRequestsTreeDataProvider.ID,
		);
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
			Logger.appendLine(
				`Matched ${entryNodes.length} of ${entries.length} saved entries to local remotes`,
				StackPullRequestsTreeDataProvider.ID,
			);
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
				workspaceRemoteName: repository.workspaceRemoteName,
				owner: repository.githubRepository.remote.owner,
				repositoryName: repository.githubRepository.remote.repositoryName,
				pullRequestNumber,
			};
			const entries = await this.getStoredEntries();
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
		await this.storeEntries((await this.getStoredEntries()).filter(entry => this.entryKey(entry) !== key));
		this.refresh();
	}

	private parsePullRequestNumber(value: string): number | undefined {
		const input = value.trim();
		const match = /(?:pull\/|stacks\/|^#?)(\d+)/i.exec(input);
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
		const availableRemotes: string[] = [];
		for (const folderManager of this._reposManager.folderManagers) {
			let remotes;
			try {
				remotes = await folderManager.getAllGitHubRemotes();
			} catch (e) {
				Logger.warn(
					`Failed to inspect local remotes in ${folderManager.repository.rootUri.fsPath} while restoring ${this.describeEntry(entry)}: ${e}`,
					StackPullRequestsTreeDataProvider.ID,
				);
				continue;
			}
			availableRemotes.push(...remotes.map(remote =>
				`${remote.remoteName}=${remote.owner}/${remote.repositoryName}@${folderManager.repository.rootUri.fsPath}`,
			));
			const remote = remotes.find(candidate =>
				candidate.owner.toLowerCase() === entry.workspaceOwner.toLowerCase()
				&& candidate.repositoryName.toLowerCase() === entry.workspaceRepositoryName.toLowerCase()
				&& (!entry.workspaceRemoteName || candidate.remoteName === entry.workspaceRemoteName),
			) ?? remotes.find(candidate =>
				candidate.owner.toLowerCase() === entry.workspaceOwner.toLowerCase()
				&& candidate.repositoryName.toLowerCase() === entry.workspaceRepositoryName.toLowerCase(),
			);
			if (!remote) {
				continue;
			}

			const workspaceRepository = folderManager.findExistingGitHubRepository({
				owner: remote.owner,
				repositoryName: remote.repositoryName,
				remoteName: remote.remoteName,
			}) ?? await folderManager.createGitHubRepositoryFromOwnerName(remote.owner, remote.repositoryName);
			if (!workspaceRepository) {
				Logger.warn(
					`Matched local remote ${remote.remoteName} but could not create its GitHub repository while restoring ${this.describeEntry(entry)}`,
					StackPullRequestsTreeDataProvider.ID,
				);
				return undefined;
			}

			const isWorkspaceRepository = entry.owner.toLowerCase() === remote.owner.toLowerCase()
				&& entry.repositoryName.toLowerCase() === remote.repositoryName.toLowerCase();
			const githubRepository = isWorkspaceRepository
				? workspaceRepository
				: folderManager.findExistingGitHubRepository({
					owner: entry.owner,
					repositoryName: entry.repositoryName,
				}) ?? await folderManager.createGitHubRepositoryFromOwnerName(entry.owner, entry.repositoryName);
			if (!githubRepository) {
				Logger.warn(
					`Could not create target GitHub repository ${entry.owner}/${entry.repositoryName} while restoring ${this.describeEntry(entry)}`,
					StackPullRequestsTreeDataProvider.ID,
				);
				return undefined;
			}

			Logger.appendLine(
				`Restored ${this.describeEntry(entry)} through local remote ${remote.remoteName} in ${folderManager.repository.rootUri.fsPath}`,
				StackPullRequestsTreeDataProvider.ID,
			);
			return {
				folderManager,
				githubRepository,
				workspaceOwner: remote.owner,
				workspaceRepositoryName: remote.repositoryName,
				workspaceRemoteName: remote.remoteName,
			};
		}

		Logger.warn(
			`No local remote matched saved entry ${this.describeEntry(entry)}. Available remotes: ${availableRemotes.join(', ') || 'none'}`,
			StackPullRequestsTreeDataProvider.ID,
		);
		return undefined;
	}

	private parseStoredEntries(entries: unknown, source: string): StackPullRequestEntry[] {
		if (!Array.isArray(entries)) {
			if (entries !== undefined) {
				Logger.warn(`Ignored invalid Stack Pull Requests storage from ${source}: expected an array`, StackPullRequestsTreeDataProvider.ID);
			}
			return [];
		}
		const validEntries = entries.filter((entry): entry is StackPullRequestEntry => {
			if (!entry || typeof entry !== 'object') {
				return false;
			}
			const candidate = entry as Partial<StackPullRequestEntry>;
			return typeof candidate.workspaceOwner === 'string'
				&& typeof candidate.workspaceRepositoryName === 'string'
				&& (candidate.workspaceRemoteName === undefined || typeof candidate.workspaceRemoteName === 'string')
				&& typeof candidate.owner === 'string'
				&& typeof candidate.repositoryName === 'string'
				&& typeof candidate.pullRequestNumber === 'number'
				&& Number.isInteger(candidate.pullRequestNumber)
				&& candidate.pullRequestNumber > 0;
		});
		if (validEntries.length !== entries.length) {
			Logger.warn(
				`Ignored ${entries.length - validEntries.length} invalid saved entries from ${source}`,
				StackPullRequestsTreeDataProvider.ID,
			);
		}
		return validEntries;
	}

	private get storageUri(): vscode.Uri {
		return vscode.Uri.joinPath(this._context.globalStorageUri, StackPullRequestsTreeDataProvider.STORAGE_FILE_NAME);
	}

	private async getStoredEntries(): Promise<StackPullRequestEntry[]> {
		try {
			const contents = await vscode.workspace.fs.readFile(this.storageUri);
			const entries = this.parseStoredEntries(JSON.parse(new TextDecoder().decode(contents)), this.storageUri.toString());
			Logger.appendLine(
				`Read ${entries.length} entries from ${this.storageUri.toString()}: ${this.describeEntries(entries)}`,
				StackPullRequestsTreeDataProvider.ID,
			);
			return entries;
		} catch (e) {
			if (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') {
				const legacyEntries = this.parseStoredEntries(
					this._context.globalState.get<unknown>(StackPullRequestsTreeDataProvider.STORAGE_KEY),
					'legacy globalState',
				);
				if (legacyEntries.length > 0) {
					Logger.appendLine(
						`Migrating ${legacyEntries.length} entries from legacy globalState: ${this.describeEntries(legacyEntries)}`,
						StackPullRequestsTreeDataProvider.ID,
					);
					await this.writeEntriesFile(legacyEntries);
				}
				return legacyEntries;
			}
			Logger.error(`Failed to read saved Stack Pull Requests from ${this.storageUri.toString()}: ${e}`, StackPullRequestsTreeDataProvider.ID);
			return [];
		}
	}

	private async writeEntriesFile(entries: StackPullRequestEntry[]): Promise<void> {
		await vscode.workspace.fs.createDirectory(this._context.globalStorageUri);
		const tempUri = vscode.Uri.joinPath(
			this._context.globalStorageUri,
			`${StackPullRequestsTreeDataProvider.STORAGE_FILE_NAME}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
		);
		try {
			await vscode.workspace.fs.writeFile(tempUri, new TextEncoder().encode(this.serializeEntries(entries)));
			await vscode.workspace.fs.rename(tempUri, this.storageUri, { overwrite: true });
		} finally {
			try {
				await vscode.workspace.fs.delete(tempUri);
			} catch {
				// The temporary file was already renamed or never created.
			}
		}
	}

	private async storeEntries(entries: StackPullRequestEntry[]): Promise<void> {
		await this.writeEntriesFile(entries);
		this._storageSnapshot = this.serializeEntries(entries);
		Logger.appendLine(
			`Persisted ${entries.length} entries to ${this.storageUri.toString()}: ${this.describeEntries(entries)}`,
			StackPullRequestsTreeDataProvider.ID,
		);
	}

	private async refreshIfStorageChanged(): Promise<void> {
		const entries = await this.getStoredEntries();
		const snapshot = this.serializeEntries(entries);
		if (this._storageSnapshot === undefined) {
			this._storageSnapshot = snapshot;
			return;
		}
		if (snapshot !== this._storageSnapshot) {
			Logger.appendLine(
				`Global Stack Pull Requests storage changed while the window was unfocused; refreshing ${entries.length} entries`,
				StackPullRequestsTreeDataProvider.ID,
			);
			this.refresh();
		}
	}

	private serializeEntries(entries: StackPullRequestEntry[]): string {
		return JSON.stringify(entries);
	}

	private entryKey(entry: StackPullRequestEntry): string {
		return `${entry.owner}/${entry.repositoryName}#${entry.pullRequestNumber}`.toLowerCase();
	}

	private describeEntry(entry: StackPullRequestEntry): string {
		const workspaceRemote = entry.workspaceRemoteName
			? `${entry.workspaceRemoteName}=${entry.workspaceOwner}/${entry.workspaceRepositoryName}`
			: `${entry.workspaceOwner}/${entry.workspaceRepositoryName}`;
		return `${entry.owner}/${entry.repositoryName}#${entry.pullRequestNumber} via ${workspaceRemote}`;
	}

	private describeEntries(entries: readonly StackPullRequestEntry[]): string {
		return entries.length > 0 ? entries.map(entry => this.describeEntry(entry)).join(', ') : 'none';
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
