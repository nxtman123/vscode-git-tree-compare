const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, renameSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { RepositoryReview, isTestFile, parseNameStatus } = require('../out/review');

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'repository-review-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const write = (name, value) => writeFileSync(join(root, name), value);
    git('init', '-b', 'develop');
    git('config', 'user.name', 'Review Test'); git('config', 'user.email', 'review@example.invalid');
    write('app.txt', 'base\n'); write('removed.txt', 'original\n');
    git('add', '.'); git('commit', '-m', 'base');
    git('switch', '-c', 'feature');
    return { root, git, write, review: new RepositoryReview('git', root) };
}

test('merge-base comparison includes branch commits, staged, unstaged, and untracked files', async t => {
    const { root, git, write, review } = fixture(t);
    const clean = await review.summary('develop');
    assert.equal(clean.commits, 0); assert.equal(clean.dirty, false);
    write('app.txt', 'committed\n'); git('commit', '-am', 'branch edit');
    git('switch', 'develop'); write('upstream.txt', 'upstream only\n'); git('add', '.'); git('commit', '-m', 'advance develop'); git('switch', 'feature');
    write('staged.txt', 'staged\n'); git('add', 'staged.txt');
    write('app.txt', 'working\n'); write('untracked.txt', 'new\n');
    mkdirSync(join(root, 'tests')); write('tests/app.test.ts', 'test\n');
    git('rm', 'removed.txt');
    const summary = await review.summary('develop');
    assert.equal(summary.commits, 1); assert.equal(summary.committedFiles, 1); assert.equal(summary.dirty, true);
    assert.equal(summary.mergeBase, clean.head);
    const all = await review.files(summary, 'both');
    assert.deepEqual(all.map(f => f.path), ['app.txt', 'removed.txt', 'staged.txt', 'untracked.txt', 'tests/app.test.ts']);
    assert.equal(all.find(f => f.path === 'removed.txt').status, 'D');
    assert.deepEqual((await review.files(summary, 'committed')).map(f => f.path), ['app.txt']);
    assert.deepEqual((await review.files(summary, 'uncommitted')).map(f => f.path), all.map(f => f.path));
    assert.equal(all.some(f => f.path === 'upstream.txt'), false);
});

test('uncommitted scope omits files changed only by branch commits', async t => {
    const { git, write, review } = fixture(t);
    write('app.txt', 'committed\n'); git('commit', '-am', 'edit');
    let summary = await review.summary('develop');
    assert.equal(summary.dirty, false); assert.equal(summary.commits, 1);
    assert.deepEqual(await review.files(summary, 'uncommitted'), []);
    write('untracked.txt', 'new\n'); summary = await review.summary('develop');
    assert.deepEqual((await review.files(summary, 'uncommitted')).map(f => f.path), ['untracked.txt']);
});

test('dirty status retains staged changes canceled by the working tree', async t => {
    const { git, write, review } = fixture(t);
    write('app.txt', 'staged\n'); git('add', 'app.txt'); write('app.txt', 'base\n');
    const summary = await review.summary('develop');
    assert.equal(summary.dirty, true); assert.equal(summary.commits, 0);
    assert.deepEqual(await review.files(summary, 'uncommitted'), []);
});

test('renames and unusual filenames retain original and destination paths', async t => {
    const { root, git, review } = fixture(t);
    renameSync(join(root, 'app.txt'), join(root, 'renamed\tfile\n.txt')); git('add', '-A');
    const files = await review.files(await review.summary('develop'), 'both');
    assert.deepEqual(files, [{ status: 'R', originalPath: 'app.txt', path: 'renamed\tfile\n.txt' }]);
    assert.deepEqual(parseNameStatus('A\0a b\0D\0c\0'), [{ status: 'A', originalPath: 'a b', path: 'a b' }, { status: 'D', originalPath: 'c', path: 'c' }]);
});

test('tracked file removed from index and restored untracked keeps its original side', async t => {
    const { git, write, review } = fixture(t);
    git('rm', 'app.txt'); write('app.txt', 'restored\n');
    const files = await review.files(await review.summary('develop'), 'both');
    assert.equal(files[0].status, 'M'); assert.equal(files.length, 1);
});

test('missing develop falls back to remote default and supports detached HEAD', async t => {
    const { git, review } = fixture(t);
    git('branch', '-m', 'develop', 'main'); git('update-ref', 'refs/remotes/origin/main', 'main');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'); git('checkout', '--detach');
    const summary = await review.summary();
    assert.equal(summary.base, 'origin/main'); assert.equal(summary.branch, summary.head.slice(0, 8));
});

test('test classifier covers conventional names without hiding normal source files', () => {
    for (const file of ['tests/a.ts', '__tests__/a.ts', 'a.test.ts', 'a.spec.js', 'a_test.go', 'test_thing.py', 'ThingTests.cs', 'TestThing.java', '__snapshots__/a.snap', 'e2e/a.ts']) { assert.equal(isTestFile(file), true, file); }
    for (const file of ['src/contest.ts', 'src/latest.ts', 'src/testing.ts', 'src/specification.ts', 'src/app.ts']) { assert.equal(isTestFile(file), false, file); }
});

test('automatic base follows features from develop and hotfixes from master across checkouts', async t => {
    const { git, write, review } = fixture(t);
    git('branch', 'master', 'develop');
    git('switch', 'develop'); write('app.txt', 'develop work\n'); git('commit', '-am', 'develop moves');
    git('switch', '-c', 'ordinary-feature'); write('app.txt', 'feature work\n'); git('commit', '-am', 'feature');
    let summary = await review.summary();
    assert.equal(summary.base, 'develop'); assert.equal(summary.commits, 1);
    git('switch', '-c', 'urgent-fix', 'master'); write('app.txt', 'fix\n'); git('commit', '-am', 'fix');
    summary = await review.summary();
    assert.equal(summary.base, 'master'); assert.equal(summary.commits, 1);
    git('switch', 'ordinary-feature'); assert.equal((await review.summary()).base, 'develop');
});

test('main and master checkouts are not misreported against stale remote develop', async t => {
    const { git, write, review } = fixture(t);
    git('update-ref', 'refs/remotes/origin/develop', 'develop'); git('branch', '-D', 'develop');
    git('branch', '-m', 'main'); write('app.txt', 'main work\n'); git('commit', '-am', 'main advances');
    git('update-ref', 'refs/remotes/origin/main', 'main'); git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    let summary = await review.summary();
    assert.equal(summary.base, 'main'); assert.equal(summary.commits, 0); assert.equal(summary.committedFiles, 0);
    git('branch', '-m', 'master'); summary = await review.summary();
    assert.equal(summary.base, 'master'); assert.equal(summary.commits, 0);
});

test('a newer remote base beats a stale local branch when its ancestor is closer', async t => {
    const { git, write, review } = fixture(t);
    write('app.txt', 'remote develop progress\n'); git('commit', '-am', 'advance');
    git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
    write('app.txt', 'feature\n'); git('commit', '-am', 'feature');
    const summary = await review.summary();
    assert.equal(summary.base, 'origin/develop'); assert.equal(summary.commits, 1);
});

test('fully tied ancestors use the remote default deterministically', async t => {
    const { git, write, review } = fixture(t);
    git('branch', 'master', 'develop'); git('update-ref', 'refs/remotes/origin/master', 'master');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
    write('app.txt', 'feature\n'); git('commit', '-am', 'feature');
    assert.equal((await review.summary()).base, 'origin/master');
});

test('explicit refs override detection, but missing explicit refs fail visibly', async t => {
    const { git, write, review } = fixture(t);
    git('branch', 'master'); write('app.txt', 'feature\n'); git('commit', '-am', 'feature');
    git('branch', '-f', 'develop', 'HEAD');
    assert.equal((await review.summary()).commits, 0);
    const pinned = await review.summary('master');
    assert.equal(pinned.base, 'master'); assert.equal(pinned.commits, 1);
    await assert.rejects(review.summary('missing-base'), /does not exist locally/);
});

test('unrelated main-like branches are skipped and unsupported branches are not silently HEAD', async t => {
    const { git, write, review } = fixture(t);
    git('checkout', '--orphan', 'main'); git('rm', '-rf', '.'); write('other.txt', 'unrelated\n'); git('add', '.'); git('commit', '-m', 'other root');
    git('switch', 'feature'); assert.equal((await review.summary()).base, 'develop');
    git('branch', '-D', 'develop');
    await assert.rejects(review.summary(), /No main-like branch with a common ancestor/);
});

test('custom branch names and remote default branches participate without accepting arbitrary feature names', async t => {
    const { git, write, review } = fixture(t);
    write('app.txt', 'integration progress\n'); git('commit', '-am', 'integration'); git('branch', 'integration');
    git('branch', 'topic/main'); write('app.txt', 'feature change\n'); git('commit', '-am', 'feature');
    assert.equal((await review.summary()).base, 'develop');
    assert.equal((await review.summary('auto', ['develop', 'integration'])).base, 'integration');
    git('update-ref', 'refs/remotes/upstream/stable', 'integration'); git('symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/stable');
    assert.equal((await review.summary()).base, 'upstream/stable');
});
