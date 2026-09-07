import { describe, expect, it } from 'vitest';
import { mapTableauDocs } from '../../src/tableau/mapper.js';
import type { TableauWorkbookDoc } from '../../src/tableau/model.js';

const doc = (): TableauWorkbookDoc => ({
  site: 'default', project: 'Ops', name: 'wb', datasources: [], visualSource: 'twb_content',
  sheets: [{
    name: 'S1', luid: 'v-s1', datasourceRefs: [], fieldRefs: [],
    visual: { markClass: 'Bar', markClasses: ['Bar'], rows: ['Region'], cols: ['Sales'],
              rowsRaw: 'rr', colsRaw: 'cr',
              encodings: [{ channel: 'color', field: 'Region' }],
              filters: [{ field: 'Region', filterClass: 'categorical' }] },
  }],
  dashboards: [{
    name: 'D1', luid: 'v-d1', sheetNames: ['S1'],
    layout: { width: 1200, height: 800, sizing: 'fixed',
              zones: [{ sheetName: 'S1', type: 'worksheet', x: 0, y: 0, w: 100, h: 50 }] },
  }],
  thumbnails: [{ name: 'D1', base64: 'QUJD' }],
});

describe('mapTableauDocs visual persistence', () => {
  const [batch] = mapTableauDocs([doc()], 'live');

  it('writes snake_case visual/layout platform_properties with captured_via and luid', () => {
    const sheet = batch.assets!.find((a) => a.assetType === 'bi_sheet')!;
    expect(sheet.platformProperties).toEqual({
      luid: 'v-s1',
      visual: {
        mark_class: 'Bar', mark_classes: ['Bar'], rows: ['Region'], cols: ['Sales'],
        rows_raw: 'rr', cols_raw: 'cr',
        encodings: [{ channel: 'color', field: 'Region' }],
        filters: [{ field: 'Region', filter_class: 'categorical' }],
        captured_via: 'twb_content',
      },
    });
    const dash = batch.assets!.find((a) => a.assetType === 'bi_dashboard')!;
    expect(dash.platformProperties).toEqual({
      luid: 'v-d1',
      layout: {
        width: 1200, height: 800, sizing: 'fixed',
        zones: [{ sheet_name: 'S1', type: 'worksheet', x: 0, y: 0, w: 100, h: 50 }],
        captured_via: 'twb_content',
      },
    });
  });

  it('maps thumbnails to twb_thumbnail screenshot recs typed by matching asset', () => {
    expect(batch.screenshots).toEqual([{
      catalog: 'default', schemaName: 'Ops', name: 'wb/D1', assetType: 'bi_dashboard',
      source: 'twb_thumbnail', contentType: 'image/png', base64: 'QUJD',
    }]);
  });

  it('emits no platformProperties for sheets/dashboards without capture', () => {
    const bare: TableauWorkbookDoc = {
      site: 'default', project: '', name: 'wb2', datasources: [],
      sheets: [{ name: 'S', datasourceRefs: [], fieldRefs: [] }],
      dashboards: [{ name: 'D', sheetNames: [] }],
    };
    const [b] = mapTableauDocs([bare], 'live');
    expect(b.assets!.find((a) => a.assetType === 'bi_sheet')!.platformProperties).toBeUndefined();
    expect(b.screenshots ?? []).toEqual([]);
  });
});

describe('mapTableauDocs — workbook parameters + sheet sorts persistence (Task 6)', () => {
  it('writes snake_case parameters onto the bi_workbook platform_properties', () => {
    const withParams: TableauWorkbookDoc = {
      site: 'default', project: '', name: 'wb3', datasources: [],
      sheets: [], dashboards: [],
      parameters: [
        {
          name: 'Parameter 1', caption: 'Select Metric', datatype: 'string', currentValue: '"Sales"',
          allowableValues: { kind: 'list', values: ['"Sales"', '"Profit"'] },
        },
        { name: 'Parameter 2', datatype: 'integer', currentValue: '5', allowableValues: { kind: 'range', min: '1', max: '20' } },
      ],
    };
    const [batch] = mapTableauDocs([withParams], 'file');
    const wb = batch.assets!.find((a) => a.assetType === 'bi_workbook')!;
    expect(wb.platformProperties).toEqual({
      parameters: [
        {
          name: 'Parameter 1', caption: 'Select Metric', datatype: 'string', current_value: '"Sales"',
          allowable_values: { kind: 'list', values: ['"Sales"', '"Profit"'] },
        },
        {
          name: 'Parameter 2', datatype: 'integer', current_value: '5',
          allowable_values: { kind: 'range', min: '1', max: '20' },
        },
      ],
    });
  });

  it('emits no platformProperties on a workbook asset with no parameters', () => {
    const bare: TableauWorkbookDoc = {
      site: 'default', project: '', name: 'wb4', datasources: [], sheets: [], dashboards: [],
    };
    const [batch] = mapTableauDocs([bare], 'file');
    const wb = batch.assets!.find((a) => a.assetType === 'bi_workbook')!;
    expect(wb.platformProperties).toBeUndefined();
  });

  it('writes snake_case sorts onto the sheet visual platform_properties', () => {
    const withSorts: TableauWorkbookDoc = {
      site: 'default', project: '', name: 'wb5', datasources: [],
      sheets: [{
        name: 'S1', datasourceRefs: [], fieldRefs: [],
        visual: {
          markClass: 'Bar', markClasses: ['Bar'], rows: ['Region'], cols: ['Sales'],
          rowsRaw: 'rr', colsRaw: 'cr', encodings: [], filters: [],
          sorts: [{ field: 'Region', direction: 'DESC' }],
        },
      }],
      dashboards: [], visualSource: 'twb_file',
    };
    const [batch] = mapTableauDocs([withSorts], 'file');
    const sheet = batch.assets!.find((a) => a.assetType === 'bi_sheet')!;
    expect(sheet.platformProperties!.visual).toMatchObject({
      sorts: [{ field: 'Region', direction: 'DESC' }],
    });
  });
});
