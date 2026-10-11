import { describe, expect, it } from 'vitest';

import { orderCategoryOf } from './exam-catalogue.repository';

/**
 * ORD-010, ORD-097 (BI-284). An orderable is a service of the one catalogue,
 * and the category of the order it goes on is its kind's.
 */
describe('orderCategoryOf (ORD-010, ORD-097)', () => {
  it('ORD-097 a laboratory exam, an imaging study and a procedure go on their own order', () => {
    expect(orderCategoryOf('LAB_EXAM')).toBe('LABORATORY');
    expect(orderCategoryOf('IMAGING')).toBe('IMAGING');
    expect(orderCategoryOf('PROCEDURE')).toBe('PROCEDURE');
  });

  it('ORD-010 a consultation, a supply or anything else is never ordered', () => {
    expect(orderCategoryOf('CONSULTATION')).toBeUndefined();
    expect(orderCategoryOf('SUPPLY')).toBeUndefined();
    expect(orderCategoryOf('OTHER')).toBeUndefined();
  });
});
