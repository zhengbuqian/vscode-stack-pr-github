# Stack Pull Requests for VS Code

> [!WARNING]
> This is an **unofficial fork** of [GitHub Pull Requests for Visual Studio Code](https://github.com/microsoft/vscode-pull-request-github). It is not published, maintained, reviewed, or endorsed by GitHub or Microsoft.
>
> This build intentionally keeps the upstream extension ID, `GitHub.vscode-pull-request-github`. Installing its VSIX **replaces the official GitHub Pull Requests extension** in the current VS Code profile. The two builds cannot be installed side by side.

This fork preserves the upstream pull request and issue functionality and adds a dedicated **Stack Pull Requests** experience for reviewing every pull request in a stack from one VS Code view.

## What This Fork Adds

### A dedicated Stack Pull Requests view

A separate layers icon is added to the Activity Bar. Its view is independent of the existing GitHub Pull Requests and active-review views, so opening a stack does not change the single pull request currently checked out for review.

Multiple pull requests and stacks can be added as separate top-level entries. Pull requests belonging to a stack are displayed as sibling entries rather than nested branches.

### Add a pull request or a stack by number

Use the **+** button in the Stack Pull Requests view and enter either:

- A pull request number, such as `67` or `#67`.
- A GitHub stack number, even when that number is not itself a pull request number.

The extension only operates on repositories represented by Git remotes in the currently opened workspace:

- If only one supported remote is available, it is selected automatically.
- If several remotes are available, choose one from the picker.
- When there is one unambiguous `origin`, enter a number directly in the remote picker to use `origin` as a shortcut.

Arbitrary `owner/repository/number` input is intentionally not supported. Open a local checkout containing the appropriate remote first.

### Stack discovery

When given a pull request number, the extension follows the open pull request relationships formed by matching base and head branches and builds the complete stack around that pull request.

When given a GitHub stack number, the extension resolves the pull request members exposed by GitHub for that stack. This supports the case where a stack and pull requests occupy different number spaces.

Related repositories and fork remotes are supported as long as the corresponding repository can be reached through a local workspace remote.

### Latest remote diffs with full file context

Stack entries use the current pull request state from GitHub, not the contents of a possibly stale local branch. Each pull request has its own **Changes** group, whose count is the number of changed files.

Selecting a changed file opens the normal VS Code diff editor. This provides the complete file context while retaining the upstream pull request review experience, including existing line and multi-line commenting workflows.

### Eager loading and explicit refresh

When the Stack Pull Requests view is initially loaded, the extension preloads every pull request and its changed files. Expanding an already loaded pull request therefore does not start a second file-list request.

Use the refresh button to reload all saved entries, or the inline refresh action to reload one pull request or stack. Merely switching away from the Activity Bar view and back does not trigger another refresh.

### Persistent entries across windows

Added pull requests and stacks are stored globally for this extension installation. The same saved list is available in other VS Code windows, while each window displays only entries that match one of its local Git remotes. Changes made in another window are detected when a window regains focus.

## Why This Fork Keeps the Official Extension ID

The upstream extension uses several [VS Code proposed APIs](https://code.visualstudio.com/api/advanced-topics/using-proposed-api) for its integrated diff and commenting experience. Proposed APIs are experimental and are enabled for specific extension identities. A build with a new publisher or extension ID does not inherit the permissions granted to the official GitHub Pull Requests extension in normal VS Code installations.

Keeping `GitHub.vscode-pull-request-github` allows this patch build to retain the upstream review behavior without requiring every user to run VS Code Insiders with a custom `--enable-proposed-api` argument.

This is a technical compatibility choice only. It does **not** mean that this fork is an official GitHub release or that the use of the upstream ID is endorsed by GitHub or Microsoft.

The consequences are important:

- Installing this VSIX replaces the Marketplace build of GitHub Pull Requests.
- Existing settings and authentication continue to use the upstream extension identity.
- A later Marketplace update may replace this fork with an official release.
- Reinstalling the official extension replaces this fork and removes the Stack Pull Requests view.
- Only install a VSIX obtained from a source and release that you trust.

## Installation

Download the `.vsix` file from this repository's [Releases](https://github.com/zhengbuqian/vscode-stack-pr-github/releases) page.

Install it from VS Code:

1. Open the Extensions view.
2. Open the `...` menu.
3. Select **Install from VSIX...**.
4. Choose the downloaded file and reload VS Code when prompted.

Or install it from the command line:

```bash
code --install-extension ./github-pull-request-stack-build.vsix --force
```

After reloading, look for the layers icon named **Stack Pull Requests** in the Activity Bar.

Because this fork uses the same extension ID as the Marketplace build, consider disabling automatic updates for this extension. If an official update replaces it, reinstall the latest VSIX from this repository.

## Usage

1. Open a local checkout of the repository whose stack you want to review.
2. Make sure the checkout has a GitHub remote for that repository.
3. Open **Stack Pull Requests** from the Activity Bar.
4. Select **Add Pull Request or Stack** using the **+** button.
5. Choose a remote when prompted and enter a pull request or stack number.
6. Expand the saved entry, a pull request, and its **Changes** group.
7. Select a file to open its latest GitHub diff and use the normal review commenting controls.

Use the inline refresh and remove actions on a top-level entry to update it or remove it from the saved list.

## Troubleshooting

### A saved entry is not visible

The entry is global, but it is shown only when the current VS Code window contains a local Git remote matching the repository through which the entry was added. Open the appropriate checkout and refresh the view.

### A pull request or stack cannot be found

Confirm that the selected local remote points to the correct GitHub repository and that the number is a pull request or stack number in that repository. Stack discovery considers open pull requests.

### The Stack Pull Requests icon disappeared

Check the installed extension version. A Marketplace update may have replaced this fork with the official build. Reinstall the VSIX and reload VS Code.

### Inspecting logs

Open the VS Code Output panel and select **GitHub Pull Request**. Stack loading, remote matching, persistence, preloading, refresh, and file-opening operations write diagnostic entries there.

## Building From Source

Prerequisites are the same as the upstream project, including a supported Node.js version and npm.

```bash
git clone git@github.com:zhengbuqian/vscode-stack-pr-github.git
cd vscode-stack-pr-github
npm ci
npm run bundle
npm run package
```

The packaged VSIX is written to the repository root.

## Upstream and License

This project is derived from [microsoft/vscode-pull-request-github](https://github.com/microsoft/vscode-pull-request-github), created and maintained by GitHub and Microsoft contributors. The original project and this fork are distributed under the [MIT License](LICENSE).

The upstream copyright notice and license are retained. Changes specific to the Stack Pull Requests view are maintained in [zhengbuqian/vscode-stack-pr-github](https://github.com/zhengbuqian/vscode-stack-pr-github).

GitHub, the GitHub logo, and related marks belong to GitHub. Visual Studio Code and related marks belong to Microsoft. Their appearance in the inherited extension metadata does not imply affiliation with or endorsement of this fork.
