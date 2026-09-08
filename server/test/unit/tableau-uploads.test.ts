import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { sniffBiFileKind } from '../../src/tableau/uploads.js';

/**
 * "What is this file?" decides whether a conversion even starts. The extension wins
 * when it is one Tableau uses; past that the content has to speak for itself — a
 * package a browser renamed to .zip, or an XML file saved as UTF-16, is still a
 * workbook.
 */

const FIXTURES = fileURLToPath(new URL('../fixtures/tableau/files/', import.meta.url));
const sample = fs.readFileSync(path.join(FIXTURES, 'sample.twb'));
const published = fs.readFileSync(path.join(FIXTURES, 'published.tds'));

describe('sniffBiFileKind', () => {
  it('trusts a Tableau extension without opening the file', () => {
    expect(sniffBiFileKind('x.twb', Buffer.alloc(0))).toBe('tableau_workbook');
    expect(sniffBiFileKind('x.TDSX', Buffer.alloc(0))).toBe('tableau_datasource');
  });

  it('reads the root element of an extensionless or misnamed XML file', () => {
    expect(sniffBiFileKind('export', sample)).toBe('tableau_workbook');
    expect(sniffBiFileKind('export.xml', published)).toBe('tableau_datasource');
  });

  it('reads a UTF-16 XML file rather than calling it unknown', () => {
    const utf16 = Buffer.from(`\ufeff${sample.toString('utf8')}`, 'utf16le');
    expect(sniffBiFileKind('export.xml', utf16)).toBe('tableau_workbook');
  });

  it('looks inside a zip with no Tableau extension for the document it packages', () => {
    const asZip = Buffer.from(zipSync({ 'sample.twb': new Uint8Array(sample) }));
    expect(sniffBiFileKind('download.zip', asZip)).toBe('tableau_workbook');
    const dsZip = Buffer.from(zipSync({ 'Data/x.tds': new Uint8Array(published) }));
    expect(sniffBiFileKind('download.zip', dsZip)).toBe('tableau_datasource');
  });

  it('is unknown for a zip with no Tableau document, a corrupt zip, and plain text', () => {
    const other = Buffer.from(zipSync({ 'readme.txt': new Uint8Array(Buffer.from('hi')) }));
    expect(sniffBiFileKind('download.zip', other)).toBe('unknown');
    expect(sniffBiFileKind('download.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBe('unknown');
    expect(sniffBiFileKind('notes.txt', Buffer.from('just text'))).toBe('unknown');
  });
});
