import { commands, Disposable, RelativePattern, Tab, Uri, window, workspace } from 'vscode';
import { ReviewOptions } from './review';

export interface DiffSnapshot {
    title: string;
    resources: [Uri, Uri | undefined, Uri | undefined][];
}
interface LiveView {
    tab: Tab;
    root: string;
    options: ReviewOptions;
    signature: string;
    revision: number;
}

/** Stable APIs only: existing text models update live; membership changes replace the snapshot. */
export class LiveDiffViews implements Disposable {
    private readonly views = new Map<Tab, LiveView>();
    private readonly watchers = new Map<string, Disposable>();
    private readonly disposables: Disposable[];
    private opening = 0;
    private generation = 0;
    private disposed = false;

    constructor(private readonly schedule: (root: string) => void) {
        const onTabsChanged = () => {
            const open = new Set(window.tabGroups.all.flatMap(group => group.tabs));
            for (const tab of this.views.keys()) { if (!open.has(tab)) { this.views.delete(tab); } }
            this.syncWatchers();
            const view = this.views.get(window.tabGroups.activeTabGroup.activeTab!);
            if (view) { this.schedule(view.root); }
        };
        this.disposables = [window.tabGroups.onDidChangeTabs(onTabsChanged), window.tabGroups.onDidChangeTabGroups(onTabsChanged)];
    }

    beginOpen(): number { this.opening = ++this.generation; return this.opening; }
    endOpen(request: number) { if (this.opening === request) { this.opening = 0; } }

    invalidate(root: string) {
        for (const view of this.views.values()) { if (view.root === root) { view.revision++; } }
    }

    private signature(snapshot: DiffSnapshot): string {
        return JSON.stringify([snapshot.title, snapshot.resources.map(resources => resources.map(uri => uri?.toString()))]);
    }

    private syncWatchers() {
        const roots = new Set([...this.views.values()].map(view => view.root));
        for (const [root, watcher] of this.watchers) {
            if (!roots.has(root)) { watcher.dispose(); this.watchers.delete(root); }
        }
        for (const root of roots) {
            if (this.watchers.has(root)) { continue; }
            const watcher = workspace.createFileSystemWatcher(new RelativePattern(root, '**'));
            const changed = () => this.schedule(root);
            this.watchers.set(root, Disposable.from(watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed)));
        }
    }

    async open(root: string, options: ReviewOptions, snapshot: DiffSnapshot): Promise<Tab | undefined> {
        if (this.disposed) { return undefined; }
        await commands.executeCommand('vscode.changes', snapshot.title, snapshot.resources);
        const tab = window.tabGroups.activeTabGroup.activeTab;
        // Do not claim a different editor if the user switched tabs during the command.
        if (this.disposed || !tab || !tab.label.startsWith(snapshot.title)) { return undefined; }
        this.views.set(tab, { tab, root, options: { ...options }, signature: this.signature(snapshot), revision: 0 });
        this.syncWatchers();
        this.schedule(root); // Cover changes between the initial Git read and watcher registration.
        return tab;
    }

    async refresh(root: string, snapshot: (options: ReviewOptions) => Promise<DiffSnapshot>): Promise<void> {
        if (this.disposed || this.opening || !window.state.focused) { return; }
        const view = this.views.get(window.tabGroups.activeTabGroup.activeTab!);
        if (!view || view.root !== root || view.tab.isDirty) { return; }
        const revision = view.revision;
        const generation = this.generation;
        const next = await snapshot(view.options);
        if (this.disposed || this.opening || generation !== this.generation || revision !== view.revision
            || !window.state.focused || window.tabGroups.activeTabGroup.activeTab !== view.tab
            || this.views.get(view.tab) !== view || view.tab.isDirty || this.signature(next) === view.signature) { return; }
        const pinned = !view.tab.isPreview;
        const replacement = await this.open(root, view.options, next);
        if (!replacement) { return; }
        if (pinned && window.tabGroups.activeTabGroup.activeTab === replacement) {
            await commands.executeCommand('workbench.action.keepEditor');
        }
        if (replacement !== view.tab && !view.tab.isDirty && window.tabGroups.all.some(group => group.tabs.includes(view.tab))) {
            await window.tabGroups.close(view.tab, true);
        }
        if (replacement !== view.tab && !view.tab.isDirty) { this.views.delete(view.tab); }
    }

    dispose() {
        this.disposed = true;
        Disposable.from(...this.disposables, ...this.watchers.values()).dispose();
        this.watchers.clear();
        this.views.clear();
    }
}
