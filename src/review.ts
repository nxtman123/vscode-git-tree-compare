import { execFile } from 'child_process';

export const MAIN_BRANCH_NAMES = ['develop', 'development', 'main', 'master', 'trunk'];
export const EXPLICIT_BASE_PREFIX = 'explicitReviewBase_';

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
                if (error) { reject(Object.assign(new Error(stderr.trim() || error.message), { exitCode: error.code })); }
                else { resolve(stdout); }
            });
        });
    }

    private async exists(ref: string): Promise<boolean> {
        try { await this.git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]); return true; }
        catch { return false; }
    }

    /** Choose by ancestry, never by branch dates or a feature/hotfix naming convention. */
    async resolveBase(requested = 'auto', head?: string, branch?: string,
                      mainBranches: readonly string[] = MAIN_BRANCH_NAMES): Promise<string> {
        if (requested && requested !== 'auto') {
            for (const ref of [requested, `origin/${requested}`]) {
                if (await this.exists(ref)) { return ref; }
            }
            throw new Error(`Comparison base "${requested}" does not exist locally. Fetch it or select Automatic in Change Base.`);
        }
        head = head || (await this.git(['rev-parse', '--verify', 'HEAD'])).trim();
        branch = branch ?? (await this.git(['branch', '--show-current'])).trim();
        const refs = (await this.git(['for-each-ref', '--format=%(refname)	%(symref)	%(objectname)', 'refs/heads', 'refs/remotes']))
            .trim().split('\n').filter(Boolean).map(line => {
                const [full, symbolic, commit] = line.split('	');
                const local = full.startsWith('refs/heads/');
                const short = full.replace(/^refs\/(heads|remotes)\//, '');
                const name = local ? short : short.slice(short.indexOf('/') + 1);
                return { full, symbolic, commit, local, short, name };
            });
        const defaults = new Set(refs.filter(ref => ref.symbolic && ref.short.endsWith('/HEAD')).map(ref => ref.symbolic));
        const defaultNames = new Set(refs.filter(ref => defaults.has(ref.full)).map(ref => ref.name));
        const candidates = refs.filter(ref => !ref.symbolic && (mainBranches.includes(ref.name) || defaultNames.has(ref.name)));
        let upstream = '';
        try { upstream = (await this.git(['rev-parse', '--symbolic-full-name', '@{upstream}'])).trim(); }
        catch { /* Detached HEAD or a branch without tracking configuration. */ }
        const distances = new Map<string, Promise<{ ahead: number; behind: number } | undefined>>();
        const score = (commit: string) => {
            let result = distances.get(commit);
            if (!result) {
                result = (async () => {
                    let common: string;
                    try { common = (await this.git(['merge-base', head!, commit])).trim(); }
                    catch (error) {
                        // Git exits 1 without an ancestor; command errors must remain visible.
                        if (error.exitCode === 1) { return undefined; }
                        throw error;
                    }
                    const ahead = Number((await this.git(['rev-list', '--count', `${common}..${head}`, '--'])).trim());
                    const behind = Number((await this.git(['rev-list', '--count', `${common}..${commit}`, '--'])).trim());
                    return { ahead, behind };
                })();
                distances.set(commit, result);
            }
            return result;
        };
        const ranked = [];
        for (const ref of candidates) {
            const distance = await score(ref.commit);
            if (distance) {
                const priority = ref.local && ref.short === branch ? 0 : ref.full === upstream ? 1 : defaults.has(ref.full) ? 2 : 3;
                ranked.push({ ...ref, ...distance, priority });
            }
        }
        ranked.sort((a, b) => a.ahead - b.ahead || a.behind - b.behind || a.priority - b.priority
            || Number(b.local) - Number(a.local) || a.short.localeCompare(b.short));
        if (!ranked.length) { throw new Error('No main-like branch with a common ancestor was found. Fetch more history or choose a comparison base in Change Base.'); }
        return ranked[0].short;
    }

    async summary(preferredBase = 'auto', mainBranches: readonly string[] = MAIN_BRANCH_NAMES): Promise<ReviewSummary> {
        const head = (await this.git(['rev-parse', '--verify', 'HEAD'])).trim();
        const branchName = (await this.git(['branch', '--show-current'])).trim();
        const branch = branchName || head.slice(0, 8);
        const base = await this.resolveBase(preferredBase, head, branchName, mainBranches);
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
