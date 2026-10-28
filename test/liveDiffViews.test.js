const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function harness(t) {
    const events = () => {
        const listeners = new Set();
        return { event: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
            fire: () => [...listeners].forEach(listener => listener()) };
    };
    const tabsChanged = events(), groupsChanged = events();
    const group = { tabs: [], activeTab: undefined };
    const scheduled = [], calls = [], watchers = [];
    const tabGroups = { all: [group], activeTabGroup: group, onDidChangeTabs: tabsChanged.event,
        onDidChangeTabGroups: groupsChanged.event, close: async tab => {
            calls.push(['close', tab]); group.tabs = group.tabs.filter(item => item !== tab); tabsChanged.fire(); return true;
        } };
    const vscode = {
        Disposable: { from: (...items) => ({ dispose: () => items.forEach(item => item.dispose()) }) },
        RelativePattern: class { constructor(root) { this.root = root; } },
        window: { tabGroups, state: { focused: true } },
        workspace: { createFileSystemWatcher: pattern => {
            const create = events(), change = events(), remove = events();
            const watcher = { root: pattern.root, onDidCreate: create.event, onDidChange: change.event, onDidDelete: remove.event,
                create: create.fire, change: change.fire, remove: remove.fire, disposed: false,
                dispose() { this.disposed = true; } };
            watchers.push(watcher); return watcher;
        } },
        commands: { executeCommand: async (command, title, resources) => {
            calls.push([command, title, resources]);
            if (command === 'vscode.changes') {
                if (group.activeTab?.isPreview) { group.tabs = group.tabs.filter(tab => tab !== group.activeTab); }
                const tab = { label: `${title} (${resources.length} files)`, isPreview: true, isDirty: false };
                group.tabs.push(tab); group.activeTab = tab; tabsChanged.fire();
            } else if (command === 'workbench.action.keepEditor') {
                group.activeTab.isPreview = false; tabsChanged.fire();
            }
        } },
    };
    const original = Module._load;
    Module._load = function(request, ...args) { return request === 'vscode' ? vscode : original.call(this, request, ...args); };
    const modulePath = require.resolve('../out/liveDiffViews');
    delete require.cache[modulePath];
    let LiveDiffViews;
    try { ({ LiveDiffViews } = require(modulePath)); } finally { Module._load = original; }
    const live = new LiveDiffViews(root => { scheduled.push(root); live.invalidate(root); });
    t.after(() => live.dispose());
    const uri = name => ({ toString: () => name });
    const snapshot = names => ({ title: 'Review', resources: names.map(name => [uri('file:' + name), uri('git:base:' + name), uri('file:' + name)]) });
    const options = { scope: 'both', includeTests: false };
    const open = names => live.open('/repo', options, snapshot(names));
    const refresh = names => live.refresh('/repo', async () => snapshot(names));
    return { live, group, vscode, scheduled, calls, watchers, snapshot, open, refresh, tabsChanged, groupsChanged };
}

test('content-only changes do not reopen the diff; additions and removals rebuild its membership', async t => {
    const h = harness(t);
    await h.open(['app.ts']); const original = h.group.activeTab;
    h.watchers[0].change(); await h.refresh(['app.ts']);
    assert.equal(h.group.activeTab, original);
    h.watchers[0].create(); await h.refresh(['app.ts', 'new.ts']);
    assert.notEqual(h.group.activeTab, original);
    assert.equal(h.group.tabs.length, 1);
    h.watchers.at(-1).remove(); await h.refresh(['new.ts']);
    assert.deepEqual(h.calls.filter(call => call[0] === 'vscode.changes').map(call => call[2].length), [1, 2, 1]);
});

test('background reviews do not steal focus and are scheduled when selected again', async t => {
    const h = harness(t);
    await h.open(['app.ts']); const review = h.group.activeTab;
    const editor = { label: 'other.ts', isPreview: false }; h.group.tabs.push(editor); h.group.activeTab = editor;
    await h.refresh(['app.ts', 'new.ts']); assert.equal(h.group.activeTab, editor);
    h.group.activeTab = review; h.tabsChanged.fire(); assert.equal(h.scheduled.at(-1), '/repo');
    await h.refresh(['app.ts', 'new.ts']); assert.equal(h.group.activeTab.label, 'Review (2 files)');
    h.vscode.window.state.focused = false;
    await h.refresh([]); assert.equal(h.group.activeTab.label, 'Review (2 files)');
});

test('closed reviews are not resurrected by an in-flight refresh and watchers are disposed', async t => {
    const h = harness(t); await h.open(['app.ts']);
    let resolve;
    const refreshing = h.live.refresh('/repo', () => new Promise(done => { resolve = done; }));
    h.group.tabs = []; h.group.activeTab = undefined; h.tabsChanged.fire();
    resolve(h.snapshot(['new.ts'])); await refreshing;
    assert.equal(h.group.tabs.length, 0); assert.equal(h.watchers[0].disposed, true);
    assert.equal(h.calls.filter(call => call[0] === 'vscode.changes').length, 1);
});

test('pinned reviews are replaced without duplicate tabs or losing their pinned state', async t => {
    const h = harness(t); await h.open(['app.ts']); const old = h.group.activeTab; old.isPreview = false;
    await h.refresh(['app.ts', 'new.ts']);
    assert.equal(h.group.tabs.length, 1); assert.equal(h.group.activeTab.isPreview, false);
    assert.equal(h.calls.some(call => call[0] === 'close' && call[1] === old), true);
});

test('unsaved edits postpone membership changes until the review is no longer dirty', async t => {
    const h = harness(t); await h.open(['app.ts']); const old = h.group.activeTab; old.isDirty = true;
    await h.refresh(['new.ts']); assert.equal(h.group.activeTab, old);
    old.isDirty = false; h.tabsChanged.fire(); await h.refresh(['new.ts']); assert.notEqual(h.group.activeTab, old);
});

test('empty comparisons remain open and can gain or lose their last file', async t => {
    const h = harness(t); await h.open([]); assert.equal(h.group.activeTab.label, 'Review (0 files)');
    await h.refresh(['new.ts']); await h.refresh([]);
    assert.equal(h.group.activeTab.label, 'Review (0 files)'); assert.equal(h.group.tabs.length, 1);
});

test('a file event during a Git read discards the stale result', async t => {
    const h = harness(t); await h.open(['app.ts']); const old = h.group.activeTab;
    let resolve;
    const refreshing = h.live.refresh('/repo', () => new Promise(done => { resolve = done; }));
    h.watchers[0].change(); resolve(h.snapshot(['outdated.ts'])); await refreshing;
    assert.equal(h.group.activeTab, old);
    await h.refresh(['latest.ts']); assert.notEqual(h.group.activeTab, old);
});

test('manual repository navigation cancels automatic replacement and scopes are retained', async t => {
    const h = harness(t); await h.open(['app.ts']); const old = h.group.activeTab;
    let resolve;
    const refreshing = h.live.refresh('/repo', options => {
        assert.deepEqual(options, { scope: 'both', includeTests: false });
        return new Promise(done => { resolve = done; });
    });
    const request = h.live.beginOpen(); resolve(h.snapshot(['outdated.ts'])); await refreshing;
    assert.equal(h.group.activeTab, old); h.live.endOpen(request);
    await h.refresh(['latest.ts']); assert.notEqual(h.group.activeTab, old);
});

test('changing a Git endpoint refreshes the same file list', async t => {
    const h = harness(t); await h.open(['app.ts']); const old = h.group.activeTab;
    const next = h.snapshot(['app.ts']);
    next.resources[0][1] = { toString: () => 'git:new-head:app.ts' };
    await h.live.refresh('/repo', async () => next);
    assert.notEqual(h.group.activeTab, old);
    assert.equal(h.group.tabs.length, 1);
});
