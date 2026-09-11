/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { v4 as uuid } from 'uuid';
import * as vscode from 'vscode';
import Logger from '../common/logger';
import { PRUriParams } from '../common/uri';
import { FolderRepositoryManager } from '../github/folderRepositoryManager';
import { GitHubRepository } from '../github/githubRepository';
import { IAccount } from '../github/interface';
import { PullRequestModel, PullRequestSnapshot } from '../github/pullRequestModel';

interface CachedContent { digest: string; size: number }
export interface StackSnapshot {
	id: string;
	updatedAt: string;
	isStack: boolean;
	currentUser: IAccount;
	pullRequests: PullRequestSnapshot[];
	contents: Record<string, CachedContent>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
async function digest(bytes: Uint8Array): Promise<string> {
	const hash = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
	return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
function contentKey(ref: string, path: string): string { return JSON.stringify([ref, path]); }
function missing(e: unknown): boolean { return e instanceof vscode.FileSystemError && e.code === 'FileNotFound'; }

// Bound downloads across all entries, not separately for each concurrently loaded stack.
let activeDownloads = 0;
const downloadWaiters: (() => void)[] = [];
async function download<T>(work: () => Promise<T>): Promise<T> {
	if (activeDownloads >= 6) { await new Promise<void>(resolve => downloadWaiters.push(resolve)); }
	else { activeDownloads++; }
	try { return await work(); }
	finally {
		const next = downloadWaiters.shift();
		if (next) { next(); } else { activeDownloads--; }
	}
}

/** A complete manifest is the commit point; content files are immutable. */
export class StackPullRequestCache {
	private writes: Promise<unknown> = Promise.resolve();
	constructor(private readonly directory: vscode.Uri) { }

	static async forEntry(storage: vscode.Uri, repository: GitHubRepository, number: number): Promise<StackPullRequestCache> {
		const key = [repository.remote.gitProtocol.normalizeUri()?.authority, repository.remote.owner.toLowerCase(), repository.remote.repositoryName.toLowerCase(), number];
		return new StackPullRequestCache(vscode.Uri.joinPath(storage, 'stack-cache', await digest(encoder.encode(JSON.stringify(key)))));
	}

	private get manifest(): vscode.Uri { return vscode.Uri.joinPath(this.directory, 'snapshot.json'); }
	private snapshotDirectory(id: string): vscode.Uri {
		if (!/^[a-f0-9-]{36}$/.test(id)) { throw new Error('Invalid snapshot ID.'); }
		return vscode.Uri.joinPath(this.directory, 'snapshots', id);
	}
	private contentUri(snapshotId: string, content: CachedContent): vscode.Uri {
		if (!/^[a-f0-9]{64}$/.test(content.digest)) { throw new Error('Invalid cached file digest.'); }
		return vscode.Uri.joinPath(this.snapshotDirectory(snapshotId), 'contents', content.digest);
	}

	async read(validateContents = true): Promise<StackSnapshot | undefined> {
		let bytes: Uint8Array;
		try { bytes = await vscode.workspace.fs.readFile(this.manifest); }
		catch (e) { if (missing(e)) { return; } throw e; }
		const snapshot: StackSnapshot = JSON.parse(decoder.decode(bytes));
		if (!snapshot.id || !snapshot.updatedAt || !Array.isArray(snapshot.pullRequests) || !snapshot.contents || !snapshot.currentUser) {
			throw new Error('Incomplete Stack cache. Refresh this entry to download it again.');
		}
		if (validateContents) {
			await Promise.all(Object.values(snapshot.contents).map(content => download(async () => {
				const stat = await vscode.workspace.fs.stat(this.contentUri(snapshot.id, content));
				if (stat.size !== content.size) { throw new Error('Incomplete cached file. Refresh this entry to download it again.'); }
			})));
		}
		return snapshot;
	}

	async readContent(snapshot: StackSnapshot, params: PRUriParams): Promise<Uint8Array> {
		const pr = snapshot.pullRequests.find(pr => pr.item.number === params.prNumber);
		const file = pr?.files.find(file => file.filename === params.fileName);
		if (!file) { throw new Error('This file is not in the cached PR snapshot. Refresh and reopen it from Stack Pull Requests.'); }
		if ((params.isBase && file.status === 'added') || (!params.isBase && file.status === 'removed')) { return new Uint8Array(); }
		const path = params.isBase ? (file.previous_filename || file.filename) : file.filename;
		const content = snapshot.contents[contentKey(params.isBase ? params.baseCommit : params.headCommit, path)];
		if (!content) { throw new Error('This file revision is no longer cached. Reopen it from Stack Pull Requests.'); }
		const bytes = await vscode.workspace.fs.readFile(this.contentUri(snapshot.id, content));
		if (bytes.byteLength !== content.size) { throw new Error('Cached file is incomplete. Refresh this entry.'); }
		return bytes;
	}

	async prepare(models: PullRequestModel[], isStack: boolean, folder: FolderRepositoryManager, repository: GitHubRepository): Promise<StackSnapshot> {
		let previous: StackSnapshot | undefined;
		try { previous = await this.read(false); } catch { /* repair a corrupt cache on explicit refresh */ }
		const requests = models.map(model => model.toSnapshot());
		const needed = new Map<string, { ref: string; path: string }>();
		for (const pr of requests) {
			for (const file of pr.files) {
				if (file.status !== 'added') {
					const path = file.previous_filename || file.filename;
					needed.set(contentKey(pr.mergeBase, path), { ref: pr.mergeBase, path });
				}
				if (file.status !== 'removed') {
					const ref = pr.item.head!.sha;
					needed.set(contentKey(ref, file.filename), { ref, path: file.filename });
				}
			}
		}
		const id = uuid();
		const currentUser = await repository.getAuthenticatedUser();
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.snapshotDirectory(id), 'contents'));
		const contents: Record<string, CachedContent> = {};
		const results = await Promise.allSettled(Array.from(needed, ([key, file]) => download(async () => {
			const cached = previous?.contents[key];
			if (cached) {
				try {
					const bytes = await vscode.workspace.fs.readFile(this.contentUri(previous!.id, cached));
					if (bytes.byteLength === cached.size && await digest(bytes) === cached.digest) { await this.atomicWrite(this.contentUri(id, cached), bytes); contents[key] = cached; return; }
				} catch { /* repair missing content */ }
			}
			let bytes: Uint8Array;
			try { bytes = await folder.repository.buffer(file.ref, vscode.Uri.joinPath(folder.repository.rootUri, file.path).fsPath); }
			catch { bytes = await repository.getFile(file.path, file.ref, true); }
			const content = { digest: await digest(bytes), size: bytes.byteLength };
			await this.atomicWrite(this.contentUri(id, content), bytes);
			contents[key] = content;
		})));
		const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
		if (failed) { await this.discard(id); throw failed.reason; }
		return { id, updatedAt: new Date().toISOString(), isStack, currentUser, pullRequests: requests, contents };
	}

	async discard(snapshotId: string): Promise<void> {
		try { await vscode.workspace.fs.delete(this.snapshotDirectory(snapshotId), { recursive: true, useTrash: false }); }
		catch (e) { if (!missing(e)) { Logger.warn(String(e), 'StackPullRequestCache'); } }
	}

	private async atomicWrite(uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
		const temporary = uri.with({ path: `${uri.path}.${uuid()}.tmp` });
		try {
			await vscode.workspace.fs.writeFile(temporary, bytes);
			await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
		} finally {
			try { await vscode.workspace.fs.delete(temporary); } catch (e) { if (!missing(e)) { Logger.warn(String(e), 'StackPullRequestCache'); } }
		}
	}

	private serialize<T>(work: () => Promise<T>): Promise<T> {
		const result = this.writes.then(work, work);
		this.writes = result.catch(() => undefined);
		return result;
	}

	publish(snapshot: StackSnapshot): Promise<void> {
		return this.serialize(async () => {
			let previous: StackSnapshot | undefined;
			try { previous = await this.read(false); } catch { /* replace invalid metadata */ }
			try {
				await this.atomicWrite(this.manifest, encoder.encode(JSON.stringify(snapshot)));
			} catch (e) {
				await this.discard(snapshot.id);
				throw e;
			}
			if (previous && previous.id !== snapshot.id) { await this.discard(previous.id); }
		});
	}

	updatePullRequest(snapshotId: string, model: PullRequestModel): Promise<void> {
		return this.serialize(async () => {
			const current = await this.read(false);
			if (!current || current.id !== snapshotId) { return; }
			const index = current.pullRequests.findIndex(pr => pr.item.number === model.number);
			if (index === -1) { return; }
			const next = model.toSnapshot();
			// Explicit refresh owns revision changes and downloads their complete contents.
			const old = current.pullRequests[index];
			next.item.head = old.item.head;
			next.item.base = old.item.base;
			next.mergeBase = old.mergeBase;
			next.files = old.files;
			current.pullRequests[index] = next;
			await this.atomicWrite(this.manifest, encoder.encode(JSON.stringify(current)));
		});
	}

	remove(): Promise<void> {
		return this.serialize(async () => {
			try { await vscode.workspace.fs.delete(this.directory, { recursive: true, useTrash: false }); }
			catch (e) { if (!missing(e)) { throw e; } }
		});
	}
}
