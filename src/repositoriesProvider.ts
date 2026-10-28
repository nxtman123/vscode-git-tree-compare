import * as path from 'path';
import { commands, Disposable, EventEmitter, Memento, OutputChannel, ThemeColor, ThemeIcon,
    TreeDataProvider, TreeItem, TreeItemCollapsibleState, TreeView, Uri, window, workspace } from 'vscode';
import { DiffSnapshot, LiveDiffViews } from './liveDiffViews';
import { API, Repository } from './typings/git';
import { getWorkspaceFolders } from './gitHelper';
import { NAMESPACE } from './constants';
import { GitTreeCompareProvider } from './treeProvider';
import { EXPLICIT_BASE_PREFIX, MAIN_BRANCH_NAMES, isTestFile, RepositoryReview, ReviewOptions, ReviewScope, ReviewSummary } from './review';

const scopeLabels: Record<ReviewScope, string> = { both: 'All Changes', committed: 'Committed Only', uncommitted: 'Uncommitted Only' };

interface RepositoryRow { root: string; requestedBase?: string; summary?: ReviewSummary; error?: string; }

export class RepositoriesProvider implements TreeDataProvider<RepositoryRow>, Disposable {
    private readonly changed = new EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    private readonly disposables: Disposable[] = [this.changed];
    private readonly subscriptions = new Map<string, Disposable>();
    private readonly rows = new Map<string, RepositoryRow>();
    private readonly pending = new Set<string>();
    private readonly busy = new Set<string>();
    private timer: NodeJS.Timeout | undefined;
    private disposed = false;
    private selection = 0;
    private selected?: { root: string; tree: boolean };
    private treeView: TreeView<RepositoryRow>;
    private readonly liveViews: LiveDiffViews;

    constructor(private readonly api: API, private readonly files: GitTreeCompareProvider,
                private readonly state: Memento, private readonly output: OutputChannel) {
        this.liveViews = new LiveDiffViews(root => this.schedule(root));
        this.disposables.push(this.liveViews);
        this.treeView = window.createTreeView(NAMESPACE + 'Repositories', { treeDataProvider: this });
        this.disposables.push(this.treeView,
            files.onDidChangeTreeData(() => {
                // A base chosen in the original explorer is shared with the dashboard.
                for (const row of this.rows.values()) {
                    if (row.requestedBase !== undefined && row.requestedBase !== this.base(row.root)) { this.schedule(row.root); }
                }
            }),
            api.onDidOpenRepository(() => this.sync()), api.onDidCloseRepository(() => this.sync()),
            workspace.onDidChangeWorkspaceFolders(() => this.sync()),
            window.onDidChangeWindowState(event => { if (event.focused) { this.refresh(); } }),
            workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration(NAMESPACE + '.reviewBase') || event.affectsConfiguration(NAMESPACE + '.mainBranches')) {
                    this.refresh();
                    if (this.selected) { void this.open(this.selected.root, this.selected.tree); }
                }
                if (event.affectsConfiguration(NAMESPACE + '.reviewScope') || event.affectsConfiguration(NAMESPACE + '.includeTests')) {
                    this.updateControls();
                    if (this.selected) { void this.open(this.selected.root, this.selected.tree); }
                }
            }),
            commands.registerCommand(NAMESPACE + '.review.open', (row: RepositoryRow) => this.open(row.root, false)),
            commands.registerCommand(NAMESPACE + '.review.explore', (row: RepositoryRow) => this.open(row.root, true)),
            commands.registerCommand(NAMESPACE + '.review.refresh', () => this.refresh()),
            commands.registerCommand(NAMESPACE + '.review.chooseScope', async () => {
                const descriptions = { both: 'Merge base → working tree (net result)', committed: 'Merge base → HEAD', uncommitted: 'HEAD → working tree (staged + unstaged)' };
                const choice = await window.showQuickPick((['both', 'committed', 'uncommitted'] as ReviewScope[]).map(scope => ({
                    label: scopeLabels[scope], description: descriptions[scope], scope,
                    detail: scope === this.options.scope ? 'Current scope' : undefined,
                })), { title: 'Repository Review: Change Scope', placeHolder: 'Choose which changes to review' });
                if (choice) { await workspace.getConfiguration(NAMESPACE).update('reviewScope', choice.scope, true); }
            }),
            commands.registerCommand(NAMESPACE + '.review.toggleTests', () =>
                workspace.getConfiguration(NAMESPACE).update('includeTests', !this.options.includeTests, true)),
        );
        for (const scope of ['both', 'committed', 'uncommitted'] as ReviewScope[]) {
            this.disposables.push(commands.registerCommand(NAMESPACE + '.review.' + scope, () =>
                workspace.getConfiguration(NAMESPACE).update('reviewScope', scope, true)));
        }
        this.updateControls();
        this.sync();
    }

    private get options(): ReviewOptions {
        const config = workspace.getConfiguration(NAMESPACE);
        return { scope: config.get<ReviewScope>('reviewScope', 'both'), includeTests: config.get<boolean>('includeTests', false) };
    }

    private updateControls() {
        const options = this.options;
        this.treeView.title = `Repositories · ${scopeLabels[options.scope]} · ${options.includeTests ? 'With Tests' : 'No Tests'}`;
        void commands.executeCommand('setContext', NAMESPACE + '.reviewScope', options.scope);
        void commands.executeCommand('setContext', NAMESPACE + '.includeTests', options.includeTests);
    }

    private base(root: string): string {
        return this.state.get<string>(EXPLICIT_BASE_PREFIX + root)
            || workspace.getConfiguration(NAMESPACE).get<string>('reviewBase', 'auto');
    }

    private sync() {
        const repositories = this.api.repositories.filter(repo => getWorkspaceFolders(repo.rootUri.fsPath).length > 0);
        const roots = new Set(repositories.map(repo => repo.rootUri.fsPath));
        for (const [root, subscription] of this.subscriptions) {
            if (!roots.has(root)) { subscription.dispose(); this.subscriptions.delete(root); this.rows.delete(root); this.pending.delete(root); }
        }
        for (const repo of repositories) { this.add(repo); }
        this.changed.fire();
    }

    private add(repo: Repository) {
        const root = repo.rootUri.fsPath;
        if (this.subscriptions.has(root)) { return; }
        this.rows.set(root, { root });
        this.subscriptions.set(root, repo.state.onDidChange(() => this.schedule(root)));
        this.schedule(root);
    }

    refresh() { for (const root of this.rows.keys()) { this.schedule(root); } }

    private schedule(root: string) {
        if (this.disposed || !this.rows.has(root)) { return; }
        this.liveViews.invalidate(root);
        this.pending.add(root);
        if (!this.timer) { this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, 600); }
    }

    /** At most three repositories run Git concurrently, including while status events arrive. */
    private drain() {
        if (this.disposed) { return; }
        for (const root of this.pending) {
            if (this.busy.size >= 3) { break; }
            if (this.busy.has(root)) { continue; }
            this.pending.delete(root);
            this.busy.add(root);
            void this.update(root).finally(() => { this.busy.delete(root); this.drain(); });
        }
    }

    private async update(root: string) {
        try {
            const requestedBase = this.base(root);
            const summary = await new RepositoryReview(this.api.git.path, root).summary(requestedBase, workspace.getConfiguration(NAMESPACE).get<string[]>('mainBranches', MAIN_BRANCH_NAMES));
            if (this.rows.has(root) && !this.disposed) {
                this.rows.set(root, { root, summary, requestedBase });
                await this.liveViews.refresh(root, options => this.snapshot(root, summary, options));
            }
        } catch (error) {
            if (this.rows.has(root) && !this.disposed) { this.rows.set(root, { root, error: error.message }); }
        }
        if (!this.disposed) { this.changed.fire(); }
    }

    getChildren(): RepositoryRow[] {
        return [...this.rows.values()].sort((a, b) =>
            path.basename(a.root).localeCompare(path.basename(b.root)) || a.root.localeCompare(b.root));
    }

    getTreeItem(row: RepositoryRow): TreeItem {
        const item = new TreeItem(path.basename(row.root), TreeItemCollapsibleState.None);
        item.id = row.root;
        item.contextValue = 'reviewRepository';
        item.command = { command: NAMESPACE + '.review.open', title: 'Open Repository Diff', arguments: [row] };
        const s = row.summary;
        const status = s ? s.commits > 0 ? s.dirty ? 'both' : 'committed' : s.dirty ? 'uncommitted' : 'clean' : undefined;
        item.description = s ? `${status} · ${s.branch}` : row.error ? 'unavailable' : 'checking…';
        item.iconPath = new ThemeIcon(row.error ? 'warning' : status === 'both' ? 'layers' : status === 'committed' ? 'git-commit'
            : status === 'uncommitted' ? 'edit' : 'repo', status && status !== 'clean' ? new ThemeColor('gitDecoration.modifiedResourceForeground') : undefined);
        item.tooltip = s ? `${row.root}\n${s.branch} → ${s.base} (merge base ${s.mergeBase.slice(0, 8)})\n${s.commits} branch commits · ${s.committedFiles} committed files\n${s.dirty ? 'Has uncommitted changes (including untracked files)' : 'Working tree clean'}\nClick: multifile diff · Tree button: file explorer`
            : `${row.root}\n${row.error || 'Reading Git status…'}`;
        return item;
    }

    private async open(root: string, tree: boolean) {
        const request = ++this.selection;
        const liveRequest = this.liveViews.beginOpen();
        this.selected = { root, tree };
        try {
            const options = this.options;
            const review = new RepositoryReview(this.api.git.path, root);
            const requestedBase = this.base(root);
            const summary = await review.summary(requestedBase, workspace.getConfiguration(NAMESPACE).get<string[]>('mainBranches', MAIN_BRANCH_NAMES));
            if (request !== this.selection || this.disposed) { return; }
            this.rows.set(root, { root, summary, requestedBase });
            this.changed.fire();
            if (tree) {
                await commands.executeCommand('setContext', NAMESPACE + '.exploringRepository', true);
                await this.files.showReviewTree(root, summary.base, options);
                if (request === this.selection) { await commands.executeCommand(NAMESPACE + '.focus'); }
                return;
            }
            const snapshot = await this.snapshot(root, summary, options);
            if (request !== this.selection || this.disposed) { return; }
            await this.liveViews.open(root, options, snapshot);
        } catch (error) {
            this.output.appendLine(`Repository review (${root}): ${error.message}`);
            if (request === this.selection) { await window.showErrorMessage(`Cannot review ${path.basename(root)}: ${error.message}`); }
        } finally {
            this.liveViews.endOpen(liveRequest);
        }
    }

    private async snapshot(root: string, summary: ReviewSummary, options: ReviewOptions): Promise<DiffSnapshot> {
        const allFiles = await new RepositoryReview(this.api.git.path, root).files(summary, options.scope);
        const files = allFiles.filter(file => options.includeTests || !isTestFile(file.path));
        const leftRef = options.scope === 'uncommitted' ? summary.head : summary.mergeBase;
        const resources: DiffSnapshot['resources'] = [];
        for (const file of files) {
            const local = Uri.file(path.join(root, file.path));
            // Submodules are directories, which cannot be rendered as text documents.
            if (file.status !== 'D') {
                try { if ((await workspace.fs.stat(local)).type & 2) { continue; } }
                catch { /* A committed file can have been deleted in the current worktree. */ }
            }
            const left = file.status === 'A' ? undefined : this.api.toGitUri(Uri.file(path.join(root, file.originalPath)), leftRef);
            const right = file.status === 'D' ? undefined : options.scope === 'committed' ? this.api.toGitUri(local, summary.head) : local;
            resources.push([local, left, right]);
        }
        return { title: `${path.basename(root)} · ${scopeLabels[options.scope]} vs ${options.scope === 'uncommitted' ? 'HEAD' : summary.base}${options.includeTests ? '' : ' · no tests'}`, resources };
    }

    dispose() {
        this.disposed = true;
        if (this.timer) { clearTimeout(this.timer); }
        Disposable.from(...this.disposables, ...this.subscriptions.values()).dispose();
    }
}
