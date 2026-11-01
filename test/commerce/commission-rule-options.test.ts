import {describe, expect, it} from 'vitest';
import {parseCommissionOptions} from '../../src/modules/commissions/domain/commission-rule-options.contract';

const brandId = 'b764b504-b055-47d5-9b81-ac5eab212b1d';
describe('Commission scope selection contract', () => {
  it('requires the selected brand for articles', () => {
    expect(() => parseCommissionOptions('products', {})).toThrow();
    expect(parseCommissionOptions('products', {brandId}).query.brandId).toBe(brandId);
  });
  it('rejects filters that cannot apply to a selection', () => {
    expect(() => parseCommissionOptions('grades', {brandId})).toThrow();
    expect(() => parseCommissionOptions('brands', {brandId})).toThrow();
    expect(() => parseCommissionOptions('other', {})).toThrow();
  });
  it('keeps UUID and grade-code cursors distinct', () => {
    expect(() => parseCommissionOptions('brands', {cursor: 'seed'})).toThrow();
    expect(parseCommissionOptions('grades', {cursor: 'seed'}).query.cursor).toBe('seed');
    expect(parseCommissionOptions('brands', {cursor: brandId}).query.cursor).toBe(brandId);
  });
  it('bounds and trims the query without dropping unknown fields', () => {
    expect(parseCommissionOptions('brands', {search: ' Maison ', limit: '1'}).query).toEqual({search: 'Maison', limit: 1});
    expect(() => parseCommissionOptions('brands', {limit: 0})).toThrow();
    expect(() => parseCommissionOptions('brands', {offset: 10})).toThrow();
    expect(() => parseCommissionOptions('brands', {search: 'a'.repeat(101)})).toThrow();
  });
});
