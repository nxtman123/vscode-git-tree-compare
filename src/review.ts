import { execFile } from 'child_process';

export type ReviewScope = 'both' | 'committed' | 'uncommitted';
export interface ReviewOptions { scope: ReviewScope; includeTests: boolean; }
export interface ReviewSummary {
    branch: string;
    base: string;
    mergeBase: string;
    head: string;
    committedFiles: number;
    commits: number;
    dirty: boolean;
}
export interface ReviewFile { status: string; originalPath: string; path: string; }

/** A shared classifier for the native diff and the existing file explorer. */
export function isTestFile(path: string): boolean {
    return /(^|\/)(__tests__|__snapshots__|tests?|specs?|e2e|cypress|playwright)(\/|$)/i.test(path)
        || /(^|\/)(test_[^/]+|[^/]+[._-](?:test|tests|spec))\.[^/]+$/i.test(path)
        || /(^|\/)(?:[^/]+(?:Tests?|Spec)|Test[A-Z][^/]*)\.[^/]+$/.test(path)
        || /\.snap$/i.test(path);
}

/** Git's -z format keeps spaces, tabs and newlines in filenames unambiguous. */
export function parseNameStatus(output: string): ReviewFile[] {
    const fields = output.split('\0');
    const files: ReviewFile[] = [];
    for (let i = 0; fields[i];) {
        const status = fields[i++][0];
        const originalPath = fields[i++];
        const path = status === 'R' || status === 'C' ? fields[i++] : originalPath;
        if (path === undefined) { throw new Error('Incomplete Git diff output'); }
        files.push({ status, originalPath, path });
    }
    return files;
}

export class RepositoryReview {
    constructor(private readonly gitPath: string, readonly root: string) {}

    private git(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile(this.gitPath, ['-C', this.root, ...args], {
                encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000,
                env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
            }, (error, stdout, stderr) => {
                if (error) { reject(new Error(stderr.trim() || error.message)); }
                else { resolve(stdout); }
            });
        });
    }

    private async exists(ref: string): Promise<boolean> {
        try { await this.git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]); return true; }
        catch { return false; }
    }

    async summary(preferredBase: string): Promise<ReviewSummary> {
        const head = (await this.git(['rev-parse', '--verify', 'HEAD'])).trim();
        const branch = (await this.git(['branch', '--show-current'])).trim() || head.slice(0, 8);
        let base = '';
        // Repositories without develop use their remote default, then common local defaults.
        const candidates = [preferredBase, `origin/${preferredBase}`];
        try { candidates.push((await this.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()); }
        catch { /* No origin or no remote HEAD configured. */ }
        candidates.push('main', 'master', 'HEAD');
        for (const candidate of candidates) {
            if (candidate && await this.exists(candidate)) { base = candidate; break; }
        }
        const mergeBase = (await this.git(['merge-base', head, base])).trim();
        const [committed, commits, status] = await Promise.all([
            this.git(['diff', '--name-status', '-z', '-M', '--ignore-submodules=all', mergeBase, head, '--']),
            this.git(['rev-list', '--count', `${mergeBase}..${head}`, '--']),
            this.git(['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
        ]);
        return { branch, base, mergeBase, head, committedFiles: parseNameStatus(committed).length,
            commits: Number(commits.trim()), dirty: status.length > 0 };
    }

    async files(summary: ReviewSummary, scope: ReviewScope): Promise<ReviewFile[]> {
        const left = scope === 'uncommitted' ? summary.head : summary.mergeBase;
        const right = scope === 'committed' ? [summary.head] : [];
        const files = parseNameStatus(await this.git(['diff', '--name-status', '-z', '-M', '--ignore-submodules=all', left, ...right, '--']));
        if (scope !== 'committed') {
            const untracked = (await this.git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
            for (const path of untracked) {
                const deleted = files.find(file => file.path === path && file.status === 'D');
                // A tracked file removed from the index but restored on disk still has a base side.
                if (deleted) { deleted.status = 'M'; }
                else if (!files.some(file => file.path === path)) { files.push({ status: 'A', originalPath: path, path }); }
            }
        }
        return files.sort((a, b) => Number(isTestFile(a.path)) - Number(isTestFile(b.path)) || a.path.localeCompare(b.path));
    }
}
