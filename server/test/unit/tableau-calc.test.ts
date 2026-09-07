import { describe, it, expect } from 'vitest';
import { tokenizeCalc } from '../../src/tableau/calc.js';

/**
 * Tableau calc tokenizer (BI connectors plan decision 8) — mechanical classification onto
 * the existing `DerivationType` taxonomy, plus ref extraction (`\[([^\]]+)\]` tokens, with
 * the `[DS].[Field]` cross-datasource form split out). No semantics: a formula classifies
 * by which function/keyword/operator shapes appear in its text, nothing more.
 */

describe('tokenizeCalc — decision 8 classification table', () => {
  it('IF ... THEN ... END ⇒ case_switch', () => {
    const r = tokenizeCalc('IF [Sales] > 100 THEN "High" ELSE "Low" END');
    expect(r.derivationType).toEqual(['case_switch']);
    expect(r.refs).toEqual([{ field: 'Sales' }]);
  });

  it('CASE ... WHEN ... END ⇒ case_switch', () => {
    const r = tokenizeCalc('CASE [Region] WHEN "West" THEN 1 ELSE 0 END');
    expect(r.derivationType).toEqual(['case_switch']);
  });

  it('IIF(...) ⇒ case_switch', () => {
    const r = tokenizeCalc('IIF([Profit] > 0, "Profitable", "Loss")');
    expect(r.derivationType).toEqual(['case_switch']);
  });

  it('SUM(...) ⇒ aggregation', () => {
    const r = tokenizeCalc('SUM([Sales])');
    expect(r.derivationType).toEqual(['aggregation']);
    expect(r.refs).toEqual([{ field: 'Sales' }]);
  });

  it('AVG/MIN/MAX/COUNT/COUNTD/MEDIAN/STDEV/VAR/PERCENTILE/ATTR ⇒ aggregation', () => {
    for (const fn of [
      'AVG', 'MIN', 'MAX', 'COUNT', 'COUNTD', 'MEDIAN', 'STDEV', 'VAR', 'PERCENTILE', 'ATTR',
    ]) {
      const r = tokenizeCalc(`${fn}([Sales])`);
      expect(r.derivationType, fn).toContain('aggregation');
    }
  });

  it('{FIXED ...} LOD ⇒ window', () => {
    const r = tokenizeCalc('{FIXED [Region] : SUM([Sales])}');
    expect(r.derivationType).toContain('window');
    // The nested SUM still contributes its own classification.
    expect(r.derivationType).toContain('aggregation');
    expect(r.refs).toEqual(
      expect.arrayContaining([{ field: 'Region' }, { field: 'Sales' }]),
    );
  });

  it('{INCLUDE ...} / {EXCLUDE ...} LOD ⇒ window', () => {
    expect(tokenizeCalc('{INCLUDE [Customer] : COUNTD([Order ID])}').derivationType).toContain('window');
    expect(tokenizeCalc('{EXCLUDE [Region] : SUM([Sales])}').derivationType).toContain('window');
  });

  it('WINDOW_SUM/RUNNING_SUM/LOOKUP/INDEX/RANK ⇒ window', () => {
    for (const fn of ['WINDOW_SUM', 'RUNNING_SUM', 'LOOKUP', 'INDEX', 'RANK']) {
      const r = tokenizeCalc(`${fn}([Sales])`);
      expect(r.derivationType, fn).toContain('window');
    }
  });

  it('DATEADD(...) ⇒ arithmetic', () => {
    const r = tokenizeCalc("DATEADD('month', 1, [Order Date])");
    expect(r.derivationType).toEqual(['arithmetic']);
    expect(r.refs).toEqual([{ field: 'Order Date' }]);
  });

  it('bare arithmetic operators with no known function ⇒ arithmetic', () => {
    const r = tokenizeCalc('[Sales] - [Cost]');
    expect(r.derivationType).toEqual(['arithmetic']);
    expect(r.refs).toEqual(expect.arrayContaining([{ field: 'Sales' }, { field: 'Cost' }]));
  });

  it('LEFT(...) ⇒ string_transform', () => {
    const r = tokenizeCalc('LEFT([Customer Name], 3)');
    expect(r.derivationType).toEqual(['string_transform']);
    expect(r.refs).toEqual([{ field: 'Customer Name' }]);
  });

  it('RIGHT/MID/UPPER/LOWER/TRIM/CONTAINS ⇒ string_transform', () => {
    for (const fn of ['RIGHT', 'MID', 'UPPER', 'LOWER', 'TRIM', 'CONTAINS']) {
      const r = tokenizeCalc(`${fn}([Name])`);
      expect(r.derivationType, fn).toContain('string_transform');
    }
  });

  it('bare [Field] passthrough ⇒ passthrough, exclusive', () => {
    const r = tokenizeCalc('[Customer ID]');
    expect(r.derivationType).toEqual(['passthrough']);
    expect(r.refs).toEqual([{ field: 'Customer ID' }]);
  });

  it('bare [Field] with surrounding whitespace still passthrough', () => {
    const r = tokenizeCalc('  [Customer ID]  ');
    expect(r.derivationType).toEqual(['passthrough']);
  });

  it('string literal ⇒ constant', () => {
    const r = tokenizeCalc('"North America"');
    expect(r.derivationType).toEqual(['constant']);
    expect(r.refs).toEqual([]);
  });

  it('numeric literal ⇒ constant', () => {
    const r = tokenizeCalc('42');
    expect(r.derivationType).toEqual(['constant']);
  });

  it('unknown/custom function ⇒ udf_call, with a flag', () => {
    const r = tokenizeCalc('MYCUSTOMFUNC([Sales])');
    expect(r.derivationType).toEqual(['udf_call']);
    expect(r.flags).toContain('unknown_function:MYCUSTOMFUNC');
    expect(r.refs).toEqual([{ field: 'Sales' }]);
  });

  it('[DS].[Field] cross-datasource form extracts {ds, field}, not two bare refs', () => {
    const r = tokenizeCalc('[Sales Data].[Revenue]');
    expect(r.refs).toEqual([{ ds: 'Sales Data', field: 'Revenue' }]);
  });

  it('mixes cross-datasource refs with bare refs in the same formula', () => {
    const r = tokenizeCalc('[Sales Data].[Revenue] - [Local Cost]');
    expect(r.refs).toEqual(
      expect.arrayContaining([
        { ds: 'Sales Data', field: 'Revenue' },
        { field: 'Local Cost' },
      ]),
    );
    expect(r.refs).toHaveLength(2);
  });

  it('a formula combining IF + SUM classifies both', () => {
    const r = tokenizeCalc('IF [Region] = "West" THEN SUM([Sales]) ELSE 0 END');
    expect(r.derivationType).toEqual(expect.arrayContaining(['case_switch', 'aggregation']));
  });
});
