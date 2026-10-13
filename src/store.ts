import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { deriveStatus, type Analysis, type Status } from './analysis.ts';
import { DEFAULT_MODEL_SETTINGS, ModelSettings } from './model-choice.ts';

// data/ is gitignored: analyses quote private code and must never reach the public repo.
// IO_DB points a server at another database, e.g. a copy for testing.
export const DEFAULT_DB = process.env.IO_DB ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'io.db');
const ID = /^[\w.-]+__[\w.-]+__\d+$/;

export const analysisId = (owner: string, repo: string, number: number) => `${owner}__${repo}__${number}`;

function checkId(id: string): string {
    if (!ID.test(id)) throw new Error(`Not an analysis id: ${id}`);
    return id;
}

export interface AnalysisSummary {
    id: string;
    createdAt: string;
    pr: Analysis['pr'];
    issueKey: string | null;
    counts: Record<'delivered' | 'partial' | 'missing' | 'unverifiable', number>;
    unclaimed: number;
    status: Status;
    stale: boolean;
    prState: string | null;
    dismissReason: string | null;
}

interface Row {
    id: string;
    json: string;
    created_at: string;
    head_oid: string | null;
    pr_state: string | null;
    dismiss_reason: string | null;
}

export function openStore(file = DEFAULT_DB) {
    mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE IF NOT EXISTS analyses (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        pr_state TEXT,
        head_oid TEXT,
        state_checked_at INTEGER,
        dismissed_at TEXT,
        dismiss_reason TEXT
    )`);
    db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL)');
    // Every run of a PR, numbered from 1. analyses.json mirrors the latest run, which the inbox,
    // dismissing and merge tracking work from.
    db.exec(`CREATE TABLE IF NOT EXISTS runs (
        analysis_id TEXT NOT NULL,
        n INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (analysis_id, n)
    )`);
    db.exec(`INSERT INTO runs (analysis_id, n, created_at, json)
             SELECT id, 1, created_at, json FROM analyses WHERE id NOT IN (SELECT analysis_id FROM runs)`);

    // Merged PRs used to leave the inbox on their own; now only the user dismisses, so bring those back.
    db.exec(`UPDATE analyses SET dismissed_at = NULL, dismiss_reason = NULL WHERE dismiss_reason = 'merged'`);

    const latestRun = (id: string): number =>
        ((db.prepare('SELECT MAX(n) AS n FROM runs WHERE analysis_id = ?').get(id) as { n: number | null }).n ?? 0);
    const serialise = (a: Analysis) => JSON.stringify({ ...a, status: deriveStatus(a) });

    const summarise = (row: Row): AnalysisSummary => {
        const a: Analysis = JSON.parse(row.json);
        return {
            id: a.id,
            createdAt: a.createdAt,
            pr: a.pr,
            issueKey: a.issue?.key ?? null,
            counts: {
                delivered: a.claims.filter(c => c.verdict === 'delivered').length,
                partial: a.claims.filter(c => c.verdict === 'partial').length,
                missing: a.claims.filter(c => c.verdict === 'missing').length,
                unverifiable: a.claims.filter(c => c.verdict === 'unverifiable').length,
            },
            unclaimed: a.unclaimed.filter(u => !u.expected).length,
            status: deriveStatus(a),
            stale: row.head_oid !== null && row.head_oid !== a.pr.headRefOid,
            prState: row.pr_state,
            dismissReason: row.dismiss_reason,
        };
    };

    return {
        // A new analysis of the same PR becomes its latest run and brings it back into the inbox.
        save(a: Analysis): void {
            const id = checkId(a.id);
            db.prepare('INSERT INTO runs (analysis_id, n, created_at, json) VALUES (?, ?, ?, ?)').run(id, latestRun(id) + 1, a.createdAt, serialise(a));
            db.prepare(
                `INSERT INTO analyses (id, json, created_at) VALUES (?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET json = excluded.json, created_at = excluded.created_at,
                     head_oid = NULL, pr_state = NULL, state_checked_at = NULL, dismissed_at = NULL, dismiss_reason = NULL`,
            ).run(id, serialise(a), a.createdAt);
        },

        get(id: string, run?: number): Analysis {
            if (run === undefined) {
                const row = db.prepare('SELECT json FROM analyses WHERE id = ?').get(checkId(id)) as { json: string } | undefined;
                if (!row) throw new Error(`No analysis for ${id}.`);
                return JSON.parse(row.json);
            }
            const row = db.prepare('SELECT json FROM runs WHERE analysis_id = ? AND n = ?').get(checkId(id), run) as { json: string } | undefined;
            if (!row) throw new Error(`No run ${run} of ${id}.`);
            return JSON.parse(row.json);
        },

        runs(id: string): { n: number; createdAt: string; model: string; runInfo: Analysis['runInfo'] }[] {
            const rows = db.prepare('SELECT n, created_at, json FROM runs WHERE analysis_id = ? ORDER BY n').all(checkId(id)) as unknown as { n: number; created_at: string; json: string }[];
            return rows.map(r => {
                const a: Analysis = JSON.parse(r.json);
                return { n: r.n, createdAt: r.created_at, model: a.model, runInfo: a.runInfo };
            });
        },

        list({ dismissed = false } = {}): AnalysisSummary[] {
            const where = dismissed ? 'dismissed_at IS NOT NULL' : 'dismissed_at IS NULL';
            const rows = db.prepare(`SELECT id, json, created_at, head_oid, pr_state, dismiss_reason FROM analyses WHERE ${where} ORDER BY created_at DESC`).all();
            return (rows as unknown as Row[]).map(summarise);
        },

        // Changes one run; when that run is the latest, the inbox's copy follows.
        update(id: string, change: (a: Analysis) => void, run?: number): Analysis {
            const latest = latestRun(checkId(id));
            const n = run ?? latest;
            const a = this.get(id, n);
            change(a);
            db.prepare('UPDATE runs SET json = ? WHERE analysis_id = ? AND n = ?').run(serialise(a), id, n);
            if (n === latest) db.prepare('UPDATE analyses SET json = ? WHERE id = ?').run(serialise(a), id);
            return this.get(id, n);
        },

        dismiss(id: string, reason: 'manual'): void {
            db.prepare('UPDATE analyses SET dismissed_at = ?, dismiss_reason = ? WHERE id = ?').run(new Date().toISOString(), reason, checkId(id));
        },

        restore(id: string): void {
            db.prepare('UPDATE analyses SET dismissed_at = NULL, dismiss_reason = NULL WHERE id = ?').run(checkId(id));
        },

        recordPrState(id: string, state: string, headOid: string): void {
            db.prepare('UPDATE analyses SET pr_state = ?, head_oid = ?, state_checked_at = ? WHERE id = ?').run(state, headOid, Date.now(), checkId(id));
        },

        // Unknown or invalid stored values fall back to auto rather than failing an analysis.
        modelSettings(): ModelSettings {
            const row = db.prepare("SELECT json FROM settings WHERE key = 'models'").get() as { json: string } | undefined;
            const parsed = row ? ModelSettings.safeParse({ ...DEFAULT_MODEL_SETTINGS, ...JSON.parse(row.json) }) : null;
            return parsed?.success ? parsed.data : DEFAULT_MODEL_SETTINGS;
        },

        saveModelSettings(settings: ModelSettings): void {
            db.prepare("INSERT INTO settings (key, json) VALUES ('models', ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json").run(
                JSON.stringify(ModelSettings.parse(settings)),
            );
        },

        dueForStateCheck(maxAgeMs: number): string[] {
            const rows = db
                // A merged or closed PR cannot change any more, so it is never checked again.
                .prepare(`SELECT id FROM analyses WHERE dismissed_at IS NULL AND (pr_state IS NULL OR pr_state = 'OPEN')
                          AND (state_checked_at IS NULL OR state_checked_at < ?)`)
                .all(Date.now() - maxAgeMs);
            return (rows as unknown as { id: string }[]).map(r => r.id);
        },
    };
}

export type Store = ReturnType<typeof openStore>;

let shared: Store | null = null;
export function defaultStore(): Store {
    shared ??= openStore();
    return shared;
}
