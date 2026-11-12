import test from 'node:test';
import assert from 'node:assert/strict';
import { citationRecords } from '../src/sources.mjs';

test('citation metadata must have an arXiv ID, a real integer count and a source record', () => {
  const checkedAt = '2026-11-13T00:00:00Z';
  const record = (id, count, key = 'a') => ({ paperId: key.repeat(40), externalIds: { ArXiv: id }, citationCount: count });
  const records = citationRecords({ data: [
    record('1706.03762v1', 100), record('1706.03762', 200, 'b'),
    record('1512.03385', 300), record('not-an-id', 500),
    record('2611.10000', null), record('2611.10001', -1), record('2611.10002', 3.2),
    { ...record('2611.10003', 500), paperId: undefined },
  ] }, 2, checkedAt);
  assert.deepEqual(records.map(item => [item.id, item.citations.count]), [['1512.03385', 300], ['1706.03762', 200]]);
  assert.ok(records.every(item => item.citations.checkedAt === checkedAt && item.citations.source === 'Semantic Scholar'));
  assert.throws(() => citationRecords({ error: 'API failure' }, 3, checkedAt));
});
