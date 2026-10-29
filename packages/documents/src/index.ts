/**
 * @atelier/documents — lecture multi-format (texte, PDF, images, docx, xlsx) et
 * vision. Voir docs/BRIEF.md §2bis et le README du package.
 */
export const PACKAGE_NAME = '@atelier/documents';

export {
  createDocumentTools,
  createLookAtTool,
  createReadFileTool,
  describePages,
  INCOMPLETE_READ_MARKER,
  MAX_BINARY_BYTES,
  MAX_TEXT_BYTES,
  MAX_VISION_PAGES_PER_CALL,
} from './tools.js';
export type { DocumentToolsOptions } from './tools.js';
export {
  createVisionAnalyzer,
  DESCRIBE_IMAGE_PROMPT,
  TRANSCRIBE_PAGE_PROMPT,
  VISION_INSTRUCTIONS,
} from './vision.js';
export type {
  VisionAnalyzer,
  VisionAnalyzerOptions,
  VisionImage,
  VisionRequest,
} from './vision.js';
export {
  findAttachment,
  importAttachment,
  importAttachments,
  listAttachments,
  toAttachment,
  sanitizeFileName,
  MAX_ATTACHMENT_BYTES,
  UPLOADS_DIR,
} from './attachments.js';
export type {
  AttachmentLookup,
  ImportAttachmentOptions,
  ImportedAttachment,
} from './attachments.js';
export { CACHE_DIR, cacheKey, createWorkspaceCache, noCache, sha256 } from './cache.js';
export type { CacheKeyParts, ExtractionCache } from './cache.js';
export { detectType, readSample } from './detect.js';
export type { DetectedType, DocumentKind, ImageFormat } from './detect.js';
export { decodeText, looksBinary } from './encoding.js';
export type { DecodedText, TextEncodingName } from './encoding.js';
export { MAX_IMAGE_SIDE, prepareImage } from './image.js';
export type { PreparedImage } from './image.js';
export {
  cellText,
  docxToMarkdown,
  markdownTable,
  MAX_SHEET_ROWS,
  xlsxToMarkdown,
} from './office.js';
export {
  extractPdfText,
  isScannedPage,
  MAX_PDF_PAGES_PER_CALL,
  parsePageRange,
  SCANNED_PAGE_MIN_CHARS,
} from './pdf.js';
export type { PdfExtraction, PdfPageText } from './pdf.js';
export { PAGES_DIR, renderPdfPage, shellQuote } from './render.js';
export {
  MAX_LINES,
  MAX_OUTPUT_TOKENS,
  OUTPUT_SHARE,
  outputTokensForContext,
  windowLines,
} from './text.js';
