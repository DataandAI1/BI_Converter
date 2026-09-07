import { describe, it, expect } from 'vitest';
import { buildFqn } from '../../src/model/fqn.js';

describe('buildFqn', () => {
  it('joins catalog.schema.object lower-cased', () => {
    expect(buildFqn('MyDb', 'Sales', 'Orders')).toBe('mydb.sales.orders');
  });

  it('skips null levels (two-level namespace)', () => {
    expect(buildFqn(null, 'sales', 'orders')).toBe('sales.orders');
  });

  it('skips both container levels', () => {
    expect(buildFqn(null, null, 'orders')).toBe('orders');
  });

  it('preserves exotic characters, only case-folds', () => {
    expect(buildFqn('db', 'sch', 'Order Détails')).toBe('db.sch.order détails');
  });
});
