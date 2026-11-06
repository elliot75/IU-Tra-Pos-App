import assert from 'node:assert/strict';
import { catalog as example } from '../src/catalog.js';

export const staff = '11111111-1111-4111-8111-111111111111';
export const other = '22222222-2222-4222-8222-222222222222';
export const operation = '33333333-3333-4333-8333-333333333333';
export const release = 'release-44444444-4444-4444-8444-444444444444';
export const published = { ...structuredClone(example), release, isExample: false };
export const input = () => ({ staffId: staff, operationId: operation, menuRelease: release, items: [{ productId: 'oolong', variantId: 'oolong-500', quantity: 2, toppings: [{ id: 'example-topping', portions: 1 }] }] });

// Scripted pg double shared by store and HTTP tests. Not a PostgreSQL lock emulator.
export function fakeDb() {
  const db = { rows: [], log: [], current: release, catalog: structuredClone(published), failInsert: false, raceRow: null };
  const find = (staffId, operationId) => db.rows.find(r => r.staff_id === staffId && r.operation_id === operationId);
  db.connect = async () => {
    let pending;
    return {
      async query(sql, params = []) {
        db.log.push(sql);
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'COMMIT') { if (pending) db.rows.push(pending); pending = null; return { rows: [] }; }
        if (sql === 'ROLLBACK') { pending = null; return { rows: [] }; }
        if (sql.includes('WHERE staff_id = $1 AND operation_id = $2')) return { rows: structuredClone([find(...params)].filter(Boolean)) };
        if (sql.includes('FROM iutra_pos.catalog_state')) return { rows: [{ current_release: db.current, catalog: structuredClone(db.catalog) }] };
        if (sql.startsWith('INSERT INTO iutra_pos.order_drafts')) {
          if (db.failInsert) throw new Error('injected database failure');
          assert.equal(params[6], JSON.parse(params[5]).total, 'bigint total uses the server quote');
          if (db.raceRow) { db.rows.push(db.raceRow(params)); db.raceRow = null; return { rows: [] }; }
          if (find(params[1], params[2])) return { rows: [] };
          pending = { id: params[0], staff_id: params[1], operation_id: params[2], request: JSON.parse(params[4]), quote: JSON.parse(params[5]), created_at: '2026-01-01T00:00:00.000Z' };
          return { rows: [structuredClone(pending)] };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
      release() { db.log.push('RELEASE'); }
    };
  };
  db.query = async (sql, [staffId, id]) => {
    db.log.push(sql);
    assert.match(sql, /WHERE staff_id = \$1 AND id = \$2/);
    assert.doesNotMatch(sql.split(' FROM ')[0], /\brequest\b/, 'GET must not load the unused original request');
    return { rows: db.rows.filter(row => row.staff_id === staffId.toLowerCase() && row.id === id.toLowerCase()).map(({ request, ...row }) => structuredClone(row)) };
  };
  return db;
}
