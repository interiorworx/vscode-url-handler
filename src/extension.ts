import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type PendingCheckout = {
  repositoryPath: string;
  branchName: string;
};

const PENDING_KEY = 'vscodeUrlHandler.pendingCheckout';

// Output channel for debugging
const outputChannel = vscode.window.createOutputChannel('URL Handler');

function isDebugEnabled(): boolean {
  try {
    const config = vscode.workspace.getConfiguration('vscodeUrlHandler');
    return Boolean(config.get<boolean>('debug'));
  } catch {
    return false;
  }
}

function log(message: string) {
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[${timestamp}] ${message}`);
}

function debug(message: string) {
  if (isDebugEnabled()) {
    log(`[debug] ${message}`);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  // Check if there is a pending checkout for this window
  await maybeHandlePendingCheckout(context);

  // Register URI handler
  const uriHandler = vscode.window.registerUriHandler({
    handleUri: async (uri) => {
      await handleIncomingUri(uri, context);
    },
  });
  context.subscriptions.push(uriHandler);

  // Command to simulate
  const simulateCmd = vscode.commands.registerCommand(
    'vscode-url-handler.simulate',
    async () => {
      outputChannel.show(true);
      const repoUrl = await vscode.window.showInputBox({
        title: 'Repository URL',
        prompt: 'Enter the remote URL of the repo (e.g., https://github.com/org/repo)',
        ignoreFocusOut: true,
      });
      if (!repoUrl) {
        return;
      }
      const branch = await vscode.window.showInputBox({
        title: 'Branch name',
        prompt: 'Enter the branch name to checkout',
        ignoreFocusOut: true,
      });
      if (!branch) {
        return;
      }
      const handlerUri = vscode.Uri.parse(
        `vscode://${context.extension.id}/open?repo=${encodeURIComponent(
          repoUrl
        )}&branch=${encodeURIComponent(branch)}`
      );
      await handleIncomingUri(handlerUri, context);
    }
  );
  context.subscriptions.push(simulateCmd);

  // Show Logs command
  const showLogsCmd = vscode.commands.registerCommand('vscode-url-handler.showLogs', () => {
    outputChannel.show(true);
  });
  context.subscriptions.push(showLogsCmd);

  // Debug Search command
  const debugSearchCmd = vscode.commands.registerCommand('vscode-url-handler.debugSearch', async () => {
    outputChannel.show(true);
    const repoUrl = await vscode.window.showInputBox({
      title: 'Debug Search: Repository URL',
      prompt: 'Remote URL to match (exact repo).',
      ignoreFocusOut: true,
    });
    if (!repoUrl) return;

    const config = vscode.workspace.getConfiguration('vscodeUrlHandler');
    const baseFolderSetting = config.get<string>('baseFolder') || '';
    const baseFolder = baseFolderSetting ? expandHomeIfNeeded(baseFolderSetting) : path.join(os.homedir(), 'Documents', 'Dev');
    const maxDepth = Math.max(1, config.get<number>('maxDepth') || 4);

    log(`DebugSearch begin: baseFolder=${baseFolder} maxDepth=${maxDepth}`);
    const found = await findRepositoryByRemoteUrl(baseFolder, repoUrl, maxDepth);
    if (found) {
      log(`DebugSearch result: FOUND at ${found}`);
      vscode.window.showInformationMessage(`DebugSearch: Found at ${found}`);
    } else {
      log(`DebugSearch result: NOT FOUND`);
      vscode.window.showWarningMessage('DebugSearch: Not found. Check logs for details.');
    }
  });
  context.subscriptions.push(debugSearchCmd);
}

export function deactivate() {}

async function maybeHandlePendingCheckout(context: vscode.ExtensionContext) {
  const pending = context.globalState.get<PendingCheckout | undefined>(PENDING_KEY);
  if (!pending) {
    return;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceFolder) {
    return;
  }
  // Only proceed if the current window opened the intended repository
  if (normalizeFsPath(workspaceFolder) !== normalizeFsPath(pending.repositoryPath)) {
    return;
  }

  // Prompt and attempt checkout
  await performCheckoutFlow(pending.repositoryPath, pending.branchName);

  await context.globalState.update(PENDING_KEY, undefined);
}

async function handleIncomingUri(uri: vscode.Uri, context: vscode.ExtensionContext) {
  try {
    const params = new URLSearchParams(uri.query);
    const repoUrl = params.get('repo')?.trim();
    const branch = params.get('branch')?.trim();

    if (!repoUrl || !branch) {
      vscode.window.showErrorMessage('Missing required query params: repo and branch.');
      return;
    }

    const config = vscode.workspace.getConfiguration('vscodeUrlHandler');
    const baseFolderSetting = config.get<string>('baseFolder') || '';
    const baseFolder = baseFolderSetting
      ? expandHomeIfNeeded(baseFolderSetting)
      : path.join(os.homedir(), 'Documents', 'Dev');
    const maxDepth = Math.max(1, config.get<number>('maxDepth') || 4);

    outputChannel.show(true);
    log(`Handle URI: repo='${repoUrl}' branch='${branch}'`);
    debug(`Resolved baseFolder='${baseFolder}', maxDepth=${maxDepth}`);
    debug(`Normalized target='${normalizeRemoteUrl(repoUrl)}'`);

    const repoPath = await withProgress('Searching for repository...', async () => {
      const found = await findRepositoryByRemoteUrl(baseFolder, repoUrl, maxDepth);
      return found;
    });

    if (!repoPath) {
      log(`Search result: NOT FOUND under ${baseFolder}`);
      vscode.window.showErrorMessage(
        `Repository not found under ${baseFolder}. Ensure it's cloned and the base folder is correct.`
      );
      return;
    }

    log(`Search result: FOUND at ${repoPath}`);
    const currentWs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (currentWs && normalizeFsPath(currentWs) === normalizeFsPath(repoPath)) {
      // Already in the desired repo: prompt and perform checkout immediately
      await performCheckoutFlow(repoPath, branch);
      return;
    }

    // Otherwise, persist pending action to run after window reload
    await context.globalState.update(PENDING_KEY, { repositoryPath: repoPath, branchName: branch } satisfies PendingCheckout);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repoPath), false);
  } catch (error: any) {
    log(`Error handling URI: ${error?.stack || error?.message || String(error)}`);
    vscode.window.showErrorMessage(`Failed to handle URI: ${error?.message || String(error)}`);
  }
}

async function performCheckoutFlow(repoPath: string, branchName: string): Promise<void> {
  const answer = await vscode.window.showInformationMessage(
    `Checkout branch "${branchName}"?`,
    'Yes',
    'No'
  );
  if (answer !== 'Yes') {
    return;
  }
  log(`Begin checkout branch: ${branchName} in ${repoPath}`);
  await promptForCleanWorkingTree(repoPath);
  await withProgress(`Checking out ${branchName}`, async () => {
    await fetchAndCheckoutBranch(repoPath, branchName);
  });
  log(`Checkout complete: ${branchName}`);
}

async function withProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
  return vscode.window.withProgress<T>({ location: vscode.ProgressLocation.Notification, title }, task);
}

function expandHomeIfNeeded(inputPath: string): string {
  if (!inputPath) return inputPath;
  if (inputPath.startsWith('~')) {
    return path.join(os.homedir(), inputPath.slice(1));
  }
  return inputPath;
}

function normalizeFsPath(p: string): string {
  return path.resolve(p);
}

function normalizeRemoteUrl(url: string): string {
  // Convert different Git URL forms to a comparable canonical string
  // Examples:
  //  - https://github.com/org/repo.git -> github.com/org/repo
  //  - git@github.com:org/repo.git -> github.com/org/repo
  //  - ssh://git@github.com/org/repo -> github.com/org/repo
  let cleaned = url.trim();
  cleaned = cleaned.replace(/^ssh:\/\//i, '');
  cleaned = cleaned.replace(/^git\+ssh:\/\//i, '');
  cleaned = cleaned.replace(/^https?:\/\//i, '');
  cleaned = cleaned.replace(/^git@/i, '');
  cleaned = cleaned.replace(/:/, '/');
  cleaned = cleaned.replace(/\.git$/i, '');
  // drop auth part if any
  cleaned = cleaned.replace(/^[^@]+@/, '');
  return cleaned.toLowerCase();
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function listDirNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function isGitRepo(dirPath: string): Promise<boolean> {
  return directoryExists(path.join(dirPath, '.git'));
}

async function getRemotes(dirPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dirPath, 'remote', '-v'], {
      maxBuffer: 1024 * 1024,
    });
    const remotes = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        // format: origin	<url> (fetch)
        if (parts.length >= 2) return parts[1];
        return '';
      })
      .filter(Boolean);
    return remotes;
  } catch {
    return [];
  }
}

async function findRepositoryByRemoteUrl(
  baseFolder: string,
  targetRemoteUrl: string,
  maxDepth: number
): Promise<string | undefined> {
  const baseExists = await directoryExists(baseFolder);
  if (!baseExists) return undefined;

  const target = normalizeRemoteUrl(targetRemoteUrl);
  debug(`Search start. base='${baseFolder}', maxDepth=${maxDepth}, target='${target}'`);

  const IGNORE_DIRS = new Set<string>([
    'node_modules',
    '.git',
    '.next',
    'dist',
    'build',
    'out',
    '.yarn',
    '.pnpm-store',
    '.cache',
  ]);

  type QueueItem = { dir: string; depth: number };
  const queue: QueueItem[] = [{ dir: baseFolder, depth: 0 }];

  while (queue.length) {
    const current = queue.shift()!;
    const currentDir = current.dir;

    if (await isGitRepo(currentDir)) {
      debug(`Git repo detected: ${currentDir}`);
      const remotes = await getRemotes(currentDir);
      debug(`Remotes: ${JSON.stringify(remotes)}`);
      for (const r of remotes) {
        const nr = normalizeRemoteUrl(r);
        debug(`Compare remote '${nr}' with target '${target}'`);
        if (nr === target) {
          log(`Match: ${currentDir}`);
          return currentDir;
        }
      }
      // Do not traverse inside repos deeply (common mono-repos can have nested repos but we skip for speed)
      debug(`No match in repo, skipping nested traversal: ${currentDir}`);
      continue;
    }

    if (current.depth >= maxDepth) {
      debug(`Depth limit reached at ${currentDir}, depth=${current.depth}`);
      continue;
    }

    const childNames = await listDirNames(currentDir);
    for (const name of childNames) {
      if (IGNORE_DIRS.has(name)) continue;
      const child = path.join(currentDir, name);
      debug(`Queue: ${child} (depth ${current.depth + 1})`);
      queue.push({ dir: child, depth: current.depth + 1 });
    }
  }

  debug('Search finished: not found');
  return undefined;
}

async function fetchAndCheckoutBranch(repoPath: string, branch: string): Promise<void> {
  const opts = { cwd: repoPath, maxBuffer: 1024 * 1024 } as const;

  // fetch all
  log(`git fetch --all --prune in ${repoPath}`);
  await execFileAsync('git', ['fetch', '--all', '--prune'], opts);

  // 1) Try to checkout existing local branch
  log(`git checkout ${branch}`);
  try {
    await execFileAsync('git', ['checkout', branch], opts);
    return;
  } catch {
    // fall through
  }

  // 2) If remote branch exists, create local tracking branch
  let remoteExists = false;
  try {
    await execFileAsync(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
      opts
    );
    remoteExists = true;
  } catch {
    remoteExists = false;
  }

  if (remoteExists) {
    log(`git checkout -b ${branch} --track origin/${branch}`);
    await execFileAsync('git', ['checkout', '-b', branch, '--track', `origin/${branch}`], opts);
    return;
  }

  // 3) Neither local nor remote exists: create a new local branch
  log(`git checkout -b ${branch}`);
  await execFileAsync('git', ['checkout', '-b', branch], opts);
}

async function execOk(cmd: string, args: string[], options: { cwd: string; maxBuffer?: number }) {
  try {
    await execFileAsync(cmd, args, options);
    return true;
  } catch {
    return false;
  }
}

async function isWorkingTreeDirty(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function promptForCleanWorkingTree(repoPath: string): Promise<void> {
  while (await isWorkingTreeDirty(repoPath)) {
    const choice = await vscode.window.showWarningMessage(
      'Working tree has uncommitted changes. Stash or commit before checkout, or click Next to proceed anyway.',
      'Stash',
      'Commit',
      'Next',
      'Cancel'
    );
    if (!choice || choice === 'Cancel') {
      throw new Error('Checkout cancelled by user due to dirty working tree.');
    }
    if (choice === 'Stash') {
      log('git stash push --include-untracked');
      await execFileAsync('git', ['stash', 'push', '--include-untracked'], { cwd: repoPath });
      continue;
    }
    if (choice === 'Commit') {
      // Offer quick commit with default message
      const message = await vscode.window.showInputBox({
        title: 'Commit message',
        prompt: 'Enter a commit message',
        value: 'WIP before branch checkout',
        ignoreFocusOut: true,
      });
      if (!message) {
        continue; // re-prompt
      }
      log('git add -A && git commit');
      await execFileAsync('git', ['add', '-A'], { cwd: repoPath });
      await execFileAsync('git', ['commit', '-m', message], { cwd: repoPath });
      continue;
    }
    if (choice === 'Next') {
      // Confirm still dirty
      if (await isWorkingTreeDirty(repoPath)) {
        const confirm = await vscode.window.showWarningMessage(
          'There are still uncommitted changes. Proceed with checkout?',
          'Proceed',
          'Cancel'
        );
        if (confirm === 'Proceed') {
          return;
        }
      }
      // Loop back if cancelled or cleaned
    }
  }
}


