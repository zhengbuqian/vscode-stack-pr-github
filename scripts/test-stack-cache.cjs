/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Run with node scripts/test-stack-cache.cjs. Uses the real cache implementation and disk IO. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');

class Uri {
	constructor(value) { this.path = value; this.fsPath = value; }
	static joinPath(base, ...parts) { return new Uri(path.join(base.path, ...parts)); }
	with(change) { return new Uri(change.path); }
}
class FileSystemError extends Error { constructor(code) { super(code); this.code = code; } }
let failManifest = false;
const disk = Object.fromEntries(Object.entries({
	readFile: uri => fs.readFile(uri.path),
	writeFile: (uri, bytes) => fs.writeFile(uri.path, bytes),
	createDirectory: uri => fs.mkdir(uri.path, { recursive: true }),
	stat: uri => fs.stat(uri.path),
	delete: (uri, options) => fs.rm(uri.path, { recursive: options?.recursive ?? false }),
	rename: (from, to) => {
		if (failManifest && path.basename(to.path) === 'snapshot.json') { throw new Error('Injected manifest write failure'); }
		return fs.rename(from.path, to.path);
	},
}).map(([name, fn]) => [name, async (...args) => {
	try { return await fn(...args); }
	catch (e) { if (e.code === 'ENOENT') { throw new FileSystemError('FileNotFound'); } throw e; }
}]));

async function main() {
	const source = await fs.readFile(path.join(__dirname, '../src/view/stackPullRequestCache.ts'), 'utf8');
	const exports = {};
	vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
		exports, TextEncoder, TextDecoder, Uint8Array, crypto: crypto.webcrypto,
		require: name => {
			if (name === 'vscode') { return { Uri, FileSystemError, workspace: { fs: disk } }; }
			if (name === 'uuid') { return { v4: crypto.randomUUID }; }
			if (name === '../common/logger') { return { default: { warn() {} } }; }
			throw new Error(`Unexpected runtime dependency: ${name}`);
		},
	});
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stack-cache-test-'));
	const cache = new exports.StackPullRequestCache(new Uri(directory));
	const model = (head = 'h1', files = [{ filename: 'a', status: 'modified' }]) => ({ number: 1, toSnapshot: () => ({
		item: { number: 1, head: { sha: head }, base: { sha: 'b' }, title: head }, mergeBase: 'b', files,
		reviewThreads: [], viewed: { a: 'VIEWED' }, hasPendingReview: false,
	}) });
	let downloads = 0;
	let unavailable = false;
	const folder = { repository: { rootUri: new Uri('/workspace'), buffer: async () => { throw new Error('No local object'); } } };
	const repository = {
		getAuthenticatedUser: async () => ({ login: 'reviewer' }),
		getFile: async (file, ref, strict) => {
			assert.equal(strict, true); downloads++;
			if (unavailable) { throw new Error('Offline'); }
			return Buffer.from(`${ref}:${file}\0\xff`, 'latin1');
		},
	};
	const params = (head, isBase = false, fileName = 'a') => ({ prNumber: 1, fileName, isBase, baseCommit: 'b', headCommit: head });
	try {
		assert.equal(await cache.read(), undefined);
		const first = await cache.prepare([model()], false, folder, repository);
		assert.equal(await cache.read(), undefined, 'Unpublished snapshot must be invisible');
		await cache.publish(first);
		assert.equal(downloads, 2);
		unavailable = true;
		const restored = await new exports.StackPullRequestCache(new Uri(directory)).read();
		assert.equal(restored.id, first.id);
		assert.equal(Buffer.from(await cache.readContent(restored, params('h1'))).toString('hex'), Buffer.from('h1:a\0\xff', 'latin1').toString('hex'));
		console.log('PASS restart restores metadata and binary content without downloads');

		// A restored tab can arrive before repository discovery. The second cache lookup
		// must win over the ordinary PR provider's GitHub fallback once discovery finishes.
		let ready = false;
		let lookups = 0;
		const providerExports = {};
		const rootUri = { toString: () => '/workspace' };
		const manager = { repository: { rootUri }, findRepo: () => ({ remote: { owner: 'o', repositoryName: 'r', remoteName: 'origin' } }),
			resolvePullRequest: () => { throw new Error('Unexpected GitHub request during restoration'); } };
		const providerSource = await fs.readFile(path.join(__dirname, '../src/view/inMemPRContentProvider.ts'), 'utf8');
		vm.runInNewContext(ts.transpileModule(providerSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
			exports: providerExports, TextEncoder,
			require: name => {
				if (name === 'vscode') { return { Disposable: class { constructor(dispose) { this.dispose = dispose; } } }; }
				if (name === './repositoryFileSystemProvider') { return { RepositoryFileSystemProvider: class {
					constructor(gitAPI) { this.gitAPI = gitAPI; }
					async waitForAuth() { ready = true; }
				} }; }
				if (name === '../common/uri') { return { fromPRUri: uri => uri.params }; }
				return {};
			},
		});
		const registration = providerExports.registerStackContentProvider(async uri => {
			lookups++;
			return ready ? cache.readContent(restored, uri.params) : undefined;
		});
		const provider = new providerExports.InMemPRFileSystemProvider({ getManagerForFile: () => ready ? manager : undefined }, { state: 'initialized', repositories: [{}] }, {});
		const uri = { params: { ...params('h1'), remoteName: 'origin' } };
		assert.equal(Buffer.from(await provider.readFile(uri)).toString('hex'), Buffer.from('h1:a\0\xff', 'latin1').toString('hex'));
		assert.equal(lookups, 2);
		registration.dispose();
		const oldProvider = provider.registerTextDocumentContentProvider(1, async () => 'old', { rootUri, remoteName: 'origin' });
		provider.registerTextDocumentContentProvider(1, async () => 'new', { rootUri, remoteName: 'origin' });
		provider.registerTextDocumentContentProvider(1, async () => 'fork', { rootUri, remoteName: 'fork' });
		oldProvider.dispose();
		assert.equal(Buffer.from(await provider.readFile(uri)).toString(), 'new');
		assert.equal(Buffer.from(await provider.readFile({ params: { ...uri.params, remoteName: 'fork' } })).toString(), 'fork');
		console.log('PASS early restored tabs avoid GitHub; equal PR numbers stay isolated by remote');

		const reused = await cache.prepare([model()], false, folder, repository);
		assert.equal(downloads, 2, 'Unchanged commits must not download again');
		await cache.discard(reused.id);
		await assert.rejects(cache.prepare([model('h2')], false, folder, repository), /Offline/);
		assert.equal((await cache.read()).id, first.id);
		assert.deepEqual(await fs.readdir(path.join(directory, 'snapshots')), [first.id]);
		console.log('PASS unchanged files reused; failed download preserves snapshot and removes staging');

		unavailable = false;
		const second = await cache.prepare([model('h2')], false, folder, repository);
		failManifest = true;
		await assert.rejects(cache.publish(second), /Injected/);
		failManifest = false;
		assert.equal((await cache.read()).id, first.id);
		assert.deepEqual(await fs.readdir(path.join(directory, 'snapshots')), [first.id]);
		console.log('PASS failed publication preserves old files and removes staging');

		const third = await cache.prepare([model('h3', [{ filename: 'new', status: 'added' }])], false, folder, repository);
		await cache.publish(third);
		assert.deepEqual(await fs.readdir(path.join(directory, 'snapshots')), [third.id]);
		assert.equal((await cache.readContent(third, params('h3', true, 'new'))).length, 0);
		await assert.rejects(cache.readContent(third, params('h1')), /not in the cached/);
		console.log('PASS replacement removes old revisions and serves added-file empty base');

		const changed = model('unexpected-new-head');
		const snapshot = changed.toSnapshot(); snapshot.hasPendingReview = true; snapshot.reviewThreads = [{ id: 'pending' }];
		changed.toSnapshot = () => structuredClone(snapshot);
		await cache.updatePullRequest(third.id, changed);
		const updated = await cache.read();
		assert.equal(updated.pullRequests[0].hasPendingReview, true);
		assert.equal(updated.pullRequests[0].reviewThreads[0].id, 'pending');
		assert.equal(updated.pullRequests[0].item.head.sha, 'h3');
		await cache.updatePullRequest(first.id, model());
		assert.equal((await cache.read()).pullRequests[0].hasPendingReview, true);
		console.log('PASS user changes persist; stale models cannot overwrite newer snapshots');

		const blob = Object.values(third.contents)[0];
		await fs.writeFile(path.join(directory, 'snapshots', third.id, 'contents', blob.digest), 'broken');
		await assert.rejects(cache.read(), /Incomplete cached/);
		await cache.remove();
		assert.equal(await cache.read(), undefined);
		console.log('PASS incomplete cache detected; entry removal deletes disk cache');
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
