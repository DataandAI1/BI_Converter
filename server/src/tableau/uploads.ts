/**
 * File-kind sniffing and the parser contract, lifted from Linetria's `bi/uploads.ts`.
 * BI_Converter has one platform and one caller, so the multi-platform registry, the
 * findings recorder, and the `extraction_run` orchestration stay behind; what remains is
 * "what is this file?" plus the `BiFileParser` shape `tableau/index.ts` implements.
 */

import { unzipSync } from 'fflate';
import { decodeXmlText } from './files.js';
import type { StagingBatch } from './staging.js';

export type BiFileKind = 'tableau_workbook' | 'tableau_datasource' | 'unknown';

// ---------------------------------------------------------------------------------
// Sniffing: extension first, then content. Pure — what a file *is* doesn't depend on
// anything the converter has been configured with.
// ---------------------------------------------------------------------------------

const EXTENSION_KIND: Record<string, BiFileKind> = {
  '.twb': 'tableau_workbook',
  '.twbx': 'tableau_workbook',
  '.tds': 'tableau_datasource',
  '.tdsx': 'tableau_datasource',
};

/** The first few KB as text — enough to see the root element — honouring a BOM or a
 *  UTF-16 encoding the way the parser does, so the two never disagree about a file. */
function tryDecodeText(data: Uint8Array): string | null {
  const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 8192));
  try {
    const text = decodeXmlText(head);
    // A binary file decodes to replacement characters, never to an XML prolog.
    return text.includes('\ufffd') && !text.trimStart().startsWith('<') ? null : text;
  } catch {
    return null;
  }
}

/** What a zip with no Tableau extension packages, if it packages a Tableau document
 *  at all. A browser or a mail client renaming a `.twbx` to `.zip` is common enough
 *  that "a .twbx is only a .twbx because it says so" cost real conversions. */
function sniffZipKind(data: Uint8Array): BiFileKind {
  let names: string[];
  try {
    names = Object.keys(unzipSync(data));
  } catch {
    return 'unknown';
  }
  if (names.some((n) => /\.twb$/i.test(n))) return 'tableau_workbook';
  if (names.some((n) => /\.tds$/i.test(n))) return 'tableau_datasource';
  return 'unknown';
}

function sniffXmlKind(text: string): BiFileKind {
  // First real element tag — skips the XML declaration and any leading comments, neither
  // of which start with a letter/underscore right after '<'.
  const m = text.match(/<\s*([a-zA-Z_][\w:-]*)/);
  if (!m) return 'unknown';
  switch (m[1].toLowerCase()) {
    case 'workbook':
      return 'tableau_workbook';
    case 'datasource':
      return 'tableau_datasource';
    default:
      return 'unknown';
  }
}

/** True for the standard zip local-file-header / empty-archive / spanned signatures. */
function looksLikeZip(data: Uint8Array): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07) &&
    (data[3] === 0x04 || data[3] === 0x06 || data[3] === 0x08)
  );
}

/**
 * Determine a file's kind. Extension wins when recognized (covers `.twb`/`.twbx`/`.tds`/
 * `.tdsx` without opening the file); otherwise the content decides — the XML root
 * element, or the document a zip packages.
 */
export function sniffBiFileKind(name: string, data: Uint8Array): BiFileKind {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot === -1 ? '' : lower.slice(dot);
  const byExt = EXTENSION_KIND[ext];
  if (byExt) return byExt;

  if (looksLikeZip(data)) return sniffZipKind(data);
  const text = tryDecodeText(data);
  if (text == null) return 'unknown';
  if (text.trimStart().startsWith('<')) return sniffXmlKind(text);
  return 'unknown';
}

export interface BiUploadFile {
  name: string;
  data: Uint8Array;
}

export interface BiFileParser {
  /** The platform this parser serves — always 'tableau' here. */
  platform: string;
  /** BiFileKinds this parser accepts. */
  kinds: BiFileKind[];
  /** Parse one recognized file straight to staging batches (pass 'bi'). Throwing marks the
   *  file failed with the error's message as the reason. */
  parseAndMap(file: BiUploadFile): Promise<StagingBatch[]> | StagingBatch[];
}
