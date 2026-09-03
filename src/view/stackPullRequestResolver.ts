/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import Logger from '../common/logger';
import { GithubItemStateEnum } from '../github/interface';
import { PullRequestModel } from '../github/pullRequestModel';

export interface StackPullRequestGraphNode {
	pullRequest: PullRequestModel;
	children: StackPullRequestGraphNode[];
}

export interface ResolvedStackPullRequests {
	root: StackPullRequestGraphNode;
	size: number;
}

export class StackPullRequestResolver {
	private static readonly ID = 'StackPullRequestResolver';

	async resolve(activePullRequest: PullRequestModel): Promise<ResolvedStackPullRequests | undefined> {
		Logger.appendLine(`Resolving stack from active PR #${activePullRequest.number}`, StackPullRequestResolver.ID);
		const refreshedPullRequest = await activePullRequest.githubRepository.getPullRequest(
			activePullRequest.number,
			StackPullRequestResolver.ID,
		);
		if (!refreshedPullRequest?.isResolved() || refreshedPullRequest.state !== GithubItemStateEnum.Open) {
			return undefined;
		}

		const root = await this.findRoot(refreshedPullRequest);
		const visited = new Set<string>();
		const graph = await this.buildGraph(root, visited);
		Logger.appendLine(`Resolved stack root #${root.number} with ${visited.size} PRs`, StackPullRequestResolver.ID);
		return { root: graph, size: visited.size };
	}

	private pullRequestKey(pullRequest: PullRequestModel): string {
		return `${pullRequest.remote.owner}/${pullRequest.remote.repositoryName}#${pullRequest.number}`.toLowerCase();
	}

	private refsEqual(
		a: { owner?: string; name?: string; ref?: string } | null | undefined,
		b: { owner?: string; name?: string; ref?: string } | null | undefined,
	): boolean {
		if (!a?.owner || !b?.owner || !a?.name || !b?.name || !a?.ref || !b?.ref) {
			return false;
		}
		return a.owner.toLowerCase() === b.owner.toLowerCase()
			&& a.name.toLowerCase() === b.name.toLowerCase()
			&& a.ref === b.ref;
	}

	private async findRoot(activePullRequest: PullRequestModel): Promise<PullRequestModel> {
		let current = activePullRequest;
		const visited = new Set<string>([this.pullRequestKey(current)]);

		while (current.isResolved()) {
			if (!current.base?.ref || !current.base?.owner) {
				break;
			}
			const parent = await current.githubRepository.getPullRequestForBranch(current.base.ref, current.base.owner);
			if (!parent?.isResolved()
				|| parent.state !== GithubItemStateEnum.Open
				|| !this.refsEqual(parent.head, current.base)) {
				break;
			}

			const key = this.pullRequestKey(parent);
			if (visited.has(key)) {
				Logger.warn(`Detected a cycle while resolving parent of pull request #${current.number}`, StackPullRequestResolver.ID);
				break;
			}
			visited.add(key);
			Logger.appendLine(`Found parent edge #${parent.number} -> #${current.number}`, StackPullRequestResolver.ID);
			current = parent;
		}

		return current;
	}

	private async buildGraph(
		pullRequest: PullRequestModel,
		visited: Set<string>,
	): Promise<StackPullRequestGraphNode> {
		const key = this.pullRequestKey(pullRequest);
		visited.add(key);

		if (!pullRequest.isResolved() || !pullRequest.head?.ref) {
			return { pullRequest, children: [] };
		}

		let candidates: PullRequestModel[] = [];
		try {
			candidates = await pullRequest.githubRepository.getOpenPullRequestsForBase(pullRequest.head.ref);
		} catch (e) {
			Logger.warn(
				`Failed to fetch open pull requests for base branch ${pullRequest.head.ref}: ${e}`,
				StackPullRequestResolver.ID,
			);
		}
		const children: StackPullRequestGraphNode[] = [];
		for (const candidate of candidates.sort((a, b) => a.number - b.number)) {
			if (!candidate.isResolved()
				|| candidate.state !== GithubItemStateEnum.Open
				|| !this.refsEqual(candidate.base, pullRequest.head)) {
				continue;
			}

			const childKey = this.pullRequestKey(candidate);
			if (visited.has(childKey)) {
				Logger.warn(`Ignoring duplicate or cyclic stack edge to pull request #${candidate.number}`, StackPullRequestResolver.ID);
				continue;
			}
			Logger.appendLine(`Found child edge #${pullRequest.number} -> #${candidate.number}`, StackPullRequestResolver.ID);
			children.push(await this.buildGraph(candidate, visited));
		}

		return { pullRequest, children };
	}
}
