import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { deriveStatus, type Analysis, type Status } from './analysis.ts';

// data/ is gitignored: analyses quote private code and must never reach the public repo.
export const DEFAULT_DB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'io.db');
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
    dismissReason: string | null;
}

interface Row {
    id: string;
    json: string;
    created_at: string;
    head_oid: string | null;
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
            dismissReason: row.dismiss_reason,
        };
    };

    return {
        // A new analysis of the same PR replaces the old one and brings it back into the inbox.
        save(a: Analysis): void {
            db.prepare(
                `INSERT INTO analyses (id, json, created_at) VALUES (?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET json = excluded.json, created_at = excluded.created_at,
                     head_oid = NULL, pr_state = NULL, state_checked_at = NULL, dismissed_at = NULL, dismiss_reason = NULL`,
            ).run(checkId(a.id), JSON.stringify({ ...a, status: deriveStatus(a) }), a.createdAt);
        },

        get(id: string): Analysis {
            const row = db.prepare('SELECT json FROM analyses WHERE id = ?').get(checkId(id)) as { json: string } | undefined;
            if (!row) throw new Error(`No analysis for ${id}.`);
            return JSON.parse(row.json);
        },

        list({ dismissed = false } = {}): AnalysisSummary[] {
            const where = dismissed ? 'dismissed_at IS NOT NULL' : 'dismissed_at IS NULL';
            const rows = db.prepare(`SELECT id, json, created_at, head_oid, dismiss_reason FROM analyses WHERE ${where} ORDER BY created_at DESC`).all();
            return (rows as unknown as Row[]).map(summarise);
        },

        update(id: string, change: (a: Analysis) => void): Analysis {
            const a = this.get(id);
            change(a);
            db.prepare('UPDATE analyses SET json = ? WHERE id = ?').run(JSON.stringify({ ...a, status: deriveStatus(a) }), checkId(id));
            return this.get(id);
        },

        dismiss(id: string, reason: 'manual' | 'merged'): void {
            db.prepare('UPDATE analyses SET dismissed_at = ?, dismiss_reason = ? WHERE id = ?').run(new Date().toISOString(), reason, checkId(id));
        },

        restore(id: string): void {
            db.prepare('UPDATE analyses SET dismissed_at = NULL, dismiss_reason = NULL WHERE id = ?').run(checkId(id));
        },

        recordPrState(id: string, state: string, headOid: string): void {
            db.prepare('UPDATE analyses SET pr_state = ?, head_oid = ?, state_checked_at = ? WHERE id = ?').run(state, headOid, Date.now(), checkId(id));
            if (state === 'MERGED') {
                db.prepare(`UPDATE analyses SET dismissed_at = ?, dismiss_reason = 'merged' WHERE id = ? AND dismissed_at IS NULL`).run(
                    new Date().toISOString(),
                    id,
                );
            }
        },

        dueForStateCheck(maxAgeMs: number): string[] {
            const rows = db
                .prepare('SELECT id FROM analyses WHERE dismissed_at IS NULL AND (state_checked_at IS NULL OR state_checked_at < ?)')
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
