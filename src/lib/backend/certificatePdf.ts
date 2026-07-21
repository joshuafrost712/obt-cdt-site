/**
 * Workshop completion certificate as a PDF, generated client-side with
 * pdfmake (same library and lazy-loading pattern as the genre app's export).
 * This module is imported dynamically from the Certificates page so pdfmake's
 * ~2 MB font VFS never touches the main bundle.
 */
import * as pdfMakeNs from 'pdfmake/build/pdfmake'
import pdfVfs from 'pdfmake/build/vfs_fonts'
import type { TDocumentDefinitions } from 'pdfmake/interfaces'

interface PdfMake {
  createPdf(def: TDocumentDefinitions): { download(filename: string): void }
  addVirtualFileSystem(vfs: unknown): void
}

const pdfMake = ((pdfMakeNs as unknown as { default?: PdfMake }).default ?? pdfMakeNs) as unknown as PdfMake

let vfsReady = false
function ensureFonts(): void {
  if (vfsReady) return
  pdfMake.addVirtualFileSystem(pdfVfs)
  vfsReady = true
}

const INK = '#211a13'
const CLAY = '#8f3f12'
const FAINT = '#8b7d6e'

export interface CertificateData {
  participantName: string
  eventTitle: string
  eventLocation: string
  dateRange: string
  issuedAt: string
}

export function downloadCertificate(data: CertificateData): void {
  ensureFonts()
  const def: TDocumentDefinitions = {
    pageSize: 'LETTER',
    pageOrientation: 'landscape',
    pageMargins: [64, 56, 64, 56],
    content: [
      { text: 'OBT CONSULTANT DEVELOPMENT TRACK', alignment: 'center', fontSize: 11, characterSpacing: 2, color: CLAY, margin: [0, 24, 0, 6] },
      { text: 'Certificate of Completion', alignment: 'center', fontSize: 30, bold: true, color: INK, margin: [0, 0, 0, 26] },
      { text: 'This certifies that', alignment: 'center', fontSize: 12, color: FAINT, margin: [0, 0, 0, 8] },
      { text: data.participantName, alignment: 'center', fontSize: 24, bold: true, color: INK, margin: [0, 0, 0, 8] },
      { text: 'completed', alignment: 'center', fontSize: 12, color: FAINT, margin: [0, 0, 0, 8] },
      { text: data.eventTitle, alignment: 'center', fontSize: 17, bold: true, color: INK },
      { text: `${data.eventLocation} · ${data.dateRange}`, alignment: 'center', fontSize: 12, color: FAINT, margin: [0, 6, 0, 34] },
      {
        columns: [
          { width: '*', text: '' },
          {
            width: 220,
            stack: [
              { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 220, y2: 0, lineWidth: 0.75, lineColor: INK }] },
              { text: 'SIL Global Consulting Pool', alignment: 'center', fontSize: 10, color: FAINT, margin: [0, 6, 0, 0] },
            ],
          },
          { width: '*', text: '' },
        ],
      },
      { text: `Issued ${data.issuedAt}`, alignment: 'center', fontSize: 9, color: FAINT, margin: [0, 22, 0, 0] },
    ],
    defaultStyle: { font: 'Roboto' },
  }
  const safe = data.participantName.replace(/[^\w]+/g, '-')
  pdfMake.createPdf(def).download(`obt-cdt-certificate-${safe}.pdf`)
}
