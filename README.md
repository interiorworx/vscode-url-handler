## VS Code URL Repo Opener

Open a local repository based on a remote URL and optionally checkout a branch, via a `vscode://` link.

### Settings

- **vscodeUrlHandler.baseFolder**: Base folder to search for repositories. If empty, defaults to `${userHome}/Documents/Dev`.
- **vscodeUrlHandler.maxDepth**: Max directory depth to search under the base folder.

### Usage via URI

This extension registers a URI handler. Use a URI of the form:

`vscode://interiorworx.vscode-url-handler/open?repo=<REPO_URL>&branch=<BRANCH_NAME>`

Examples:

- `vscode://interiorworx.vscode-url-handler/open?repo=https%3A%2F%2Fgithub.com%2Forg%2Frepo&branch=feature%2Fxyz`
- `vscode://interiorworx.vscode-url-handler/open?repo=git%40github.com%3Aorg%2Frepo.git&branch=main`

The extension searches for a local clone under the configured base folder whose remote matches the provided URL. If found, it opens the folder and prompts to fetch and checkout the specified branch.

### Simulate from Command Palette

Run the command: "URL Handler: Simulate Open" to input a repo URL and branch manually.