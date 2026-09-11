# Stack PR disk snapshots

Persist complete Stack snapshots and restore them after Reload without automatically refreshing GitHub data. Download missing snapshots on first use; fetch updates on explicit refresh.

Each saved entry has an independent manifest and content generation. Reuse unchanged commit/path revisions, write the complete new generation before atomically replacing the manifest, and then remove the previous generation. Failed downloads or publication preserve the previous snapshot.

Implementation:

1. Add snapshot storage, binary content reads, atomic publication, incremental reuse, and cleanup in `stackPullRequestCache.ts`.
2. Export and restore PR metadata, parsed diffs, review threads, Viewed state, and pending-review state in `PullRequestModel`. Propagate request failures during snapshot creation.
3. Restore Stack nodes and serve diff contents from disk. Keep ordinary PR review loading separate.
4. Persist successful user changes, display cache timestamps, and retain refresh completion notifications.
5. Handle restored tabs that request content before repository initialization; isolate content providers by repository and PR.

Only opened files become VS Code text documents. Authentication and explicitly opened PR overview pages retain their existing on-demand requests.

Validation:

- `node scripts/test-stack-cache.cjs`: real temporary disk IO, binary contents, startup ordering, repository isolation, reuse, failed-download and failed-publication recovery, old-generation cleanup, mutation persistence, and corruption detection.
- TypeScript compilation, ESLint, and production bundle passed.
- Local VS Code: cached 8 entries, 20 PRs, and 1292 commit/path file revisions. Reload preserved every manifest hash, restored all PRs from disk, and retained the active diff and commenting ranges.
- Manual refresh updated all 8 entries, removed previous generations, passed size and SHA-256 verification for all 1292 revisions, and displayed the completion notification.
