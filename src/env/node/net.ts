/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Agent, globalAgent } from 'https';
import { URL } from 'url';
import { httpsOverHttp } from 'tunnel';
import { l10n, window, workspace } from 'vscode';

export const agent = getAgent();

export function isProxyAgent(agentToTest?: Agent): boolean {
	return !!agentToTest && agentToTest !== globalAgent;
}

/**
 * Return an https agent for the given proxy URL, or return the
 * global https agent if the URL was empty or invalid.
 *
 * @param {string} [url] the proxy URL, (default: vscode http.proxy or `process.env.HTTPS_PROXY`)
 * @returns {https.Agent}
 */
export function getAgent(url?: string): Agent {
	url = url ||
		workspace.getConfiguration('http').get<string>('proxy') ||
		process.env.HTTPS_PROXY ||
		process.env.https_proxy ||
		process.env.HTTP_PROXY ||
		process.env.http_proxy ||
		process.env.ALL_PROXY ||
		process.env.all_proxy;
	if (!url) {
		return globalAgent;
	}
	try {
		const { hostname, port, username, password } = new URL(url);
		const auth = username && password && `${username}:${password}`;
		return httpsOverHttp({ proxy: { host: hostname, port: Number(port) || 80, proxyAuth: auth || undefined } });
	} catch (e) {
		window.showErrorMessage(l10n.t('HTTPS_PROXY environment variable ignored: {0}', (e as Error).message));
		return globalAgent;
	}
}
