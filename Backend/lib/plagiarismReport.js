import PDFDocument from 'pdfkit'

const PURPLE = '#8b5cf6'
const INK = '#2b2540'
const MUTED = '#6b6375'
const GREEN = '#1a7f4b'
const AMBER = '#b57500'
const RED = '#c0392b'

// Winston's score is 0-100 where higher = more human. Pick a color/label for a score.
function scoreVerdict(score) {
  if (score >= 80) return { label: 'Likely human-written', color: GREEN }
  if (score <= 30) return { label: 'Likely AI-generated', color: RED }
  return { label: 'Mixed / inconclusive', color: AMBER }
}

function scoreColor(score) {
  if (score >= 80) return GREEN
  if (score <= 30) return RED
  return AMBER
}

/**
 * Builds the AI content-detection report PDF and returns the PDFDocument stream.
 * Pipe it to an HTTP response or a file.
 *
 * @param {import('./winstonClient.js').detectAiContent extends (...a:any)=>Promise<infer R> ? R : any} winston
 * @param {{ wordCount?: number }} [meta]
 */
export function buildAiDetectionReportPdf(winston, meta = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true })

  const humanScore = Math.round(winston.score ?? 0)
  const aiLikelihood = 100 - humanScore
  const verdict = scoreVerdict(humanScore)
  const sentences = Array.isArray(winston.sentences) ? winston.sentences : []
  const generatedAt = new Date().toLocaleString()

  // --- Header ---
  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(20)
    .text('AI Content Detection Report')
  doc
    .moveDown(0.2)
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text(`Generated ${generatedAt}  ·  Source: question paper text`)

  doc.moveDown(1)

  // --- Summary box ---
  const boxTop = doc.y
  const boxLeft = doc.page.margins.left
  const boxWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right
  const boxHeight = 96

  doc.roundedRect(boxLeft, boxTop, boxWidth, boxHeight, 8).fill('#f4ecff')

  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(28)
    .text(`${humanScore}/100`, boxLeft + 18, boxTop + 16)
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text('Human score (higher = more human)', boxLeft + 18, boxTop + 50)

  doc
    .fillColor(verdict.color)
    .font('Helvetica-Bold')
    .fontSize(12)
    .text(verdict.label, boxLeft + 18, boxTop + 66)

  const rightColX = boxLeft + boxWidth / 2 + 10
  doc.font('Helvetica').fontSize(10).fillColor(INK)
  doc.text(`AI-generated likelihood: ${aiLikelihood}%`, rightColX, boxTop + 16)
  doc.text(
    `Readability score: ${winston.readability_score ?? 'n/a'}`,
    rightColX,
    boxTop + 32,
  )
  doc.text(`Word count: ${meta.wordCount ?? 'n/a'}`, rightColX, boxTop + 48)
  doc.text(
    `Language: ${winston.language ?? 'n/a'}   Model: ${winston.version ?? 'n/a'}`,
    rightColX,
    boxTop + 64,
  )

  doc.y = boxTop + boxHeight + 24
  doc.x = boxLeft

  // --- Interpretation ---
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(INK)
    .text('What this means')
  doc
    .moveDown(0.3)
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(MUTED)
    .text(
      'Winston AI estimates how likely the analyzed text was written by a human. Scores near 100 ' +
        'indicate human authorship; scores near 0 indicate AI-generated content. Sentence-level scores ' +
        'below highlight which parts of the text look AI-generated. This is a probabilistic signal, not proof.',
      { align: 'left' },
    )

  doc.moveDown(1)

  // --- Per-sentence breakdown ---
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(INK)
    .text(`Sentence-level breakdown (${sentences.length})`)
  doc.moveDown(0.5)

  if (sentences.length === 0) {
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text('No sentence-level data returned.')
  }

  for (const s of sentences) {
    const sScore = Math.round(s.score ?? 0)
    const startY = doc.y

    // score chip in the left gutter
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(scoreColor(sScore))
      .text(`${sScore}`, boxLeft, startY, { width: 26 })

    // sentence text, indented past the chip
    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor(INK)
      .text((s.text ?? '').trim(), boxLeft + 32, startY, {
        width: boxWidth - 32,
      })

    doc.moveDown(0.4)

    if (doc.y > doc.page.height - doc.page.margins.bottom - 40) {
      doc.addPage()
    }
  }

  // --- Footer on every page ---
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        `Powered by Winston AI  ·  Credits used: ${winston.credits_used ?? 'n/a'}  ·  ` +
          `Credits remaining: ${winston.credits_remaining ?? 'n/a'}`,
        doc.page.margins.left,
        doc.page.height - doc.page.margins.bottom + 10,
        { width: boxWidth, align: 'center' },
      )
  }

  doc.end()
  return doc
}
