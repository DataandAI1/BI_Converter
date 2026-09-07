/**
 * File-kind sniffing and the parser contract, lifted from Linetria's `bi/uploads.ts`.
 * BI_Converter has one platform and one caller, so the multi-platform registry, the
 * findings recorder, and the `extraction_run` orchestration stay behind; what remains is
 * "what is this file?" plus the `BiFileParser` shape `tableau/index.ts` implements.
 */

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

function tryDecodeText(data: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
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
 * `.tdsx` without opening the file); otherwise the XML root element decides. A zip with
 * no recognized extension is `unknown` — a `.twbx` is only a `.twbx` because it says so.
 */
export function sniffBiFileKind(name: string, data: Uint8Array): BiFileKind {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot === -1 ? '' : lower.slice(dot);
  const byExt = EXTENSION_KIND[ext];
  if (byExt) return byExt;

  if (looksLikeZip(data)) return 'unknown';
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
