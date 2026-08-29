import PDFDocument from 'pdfkit'

const INK = '#2b2540'
const MUTED = '#6b6375'
const GREEN = '#1a7f4b'
const AMBER = '#b57500'
const RED = '#c0392b'
const PURPLE = '#8b5cf6'
const FEEDBACK_BG = '#f4ecff'

const VERDICT_META = {
  correct: { label: 'Correct', color: GREEN },
  partially_correct: { label: 'Partial', color: AMBER },
  incorrect: { label: 'Incorrect', color: RED },
  unanswered: { label: 'Unanswered', color: MUTED },
}

function verdictMeta(grade) {
  if (!grade) return { label: 'Not graded', color: MUTED }
  return VERDICT_META[grade.verdict] ?? { label: grade.verdict ?? 'Not graded', color: MUTED }
}

function maxMarksFor(question) {
  return question.grade?.effectiveMaxMarks ?? question.maxMarks ?? null
}

function scoreLabel(question) {
  const max = maxMarksFor(question)
  const score = question.grade?.score
  if (score == null) return max != null ? `- / ${max}` : '-'
  return max != null ? `${score} / ${max}` : `${score}`
}

/**
 * Builds the "checked copy" PDF (grading summary + annotated answer-sheet pages)
 * and returns the PDFDocument stream. Pipe it to an HTTP response or a file.
 *
 * @param {{
 *   questions: Array<object>,
 *   answerPages: Array<{ page:number, width:number, height:number, dataUrl:string }>,
 *   overallFeedback: string|null,
 * }} result
 */
export function buildCheckedCopyPdf(result) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true })

  const questions = Array.isArray(result.questions) ? result.questions : []
  const answerPages = Array.isArray(result.answerPages) ? result.answerPages : []
  const contentLeft = doc.page.margins.left
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right
  const bottomLimit = doc.page.height - doc.page.margins.bottom

  // ---------------------------------------------------------------------------
  // Page 1 - Grading summary
  // ---------------------------------------------------------------------------
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text('Checked Copy - Grading Summary')
  doc
    .moveDown(0.2)
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text(`Generated ${new Date().toLocaleString()}`)

  doc.moveDown(1)

  const col = {
    q: contentLeft,
    marks: contentLeft + contentWidth * 0.5,
    score: contentLeft + contentWidth * 0.64,
    verdict: contentLeft + contentWidth * 0.8,
  }

  function tableHeader() {
    const y = doc.y
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED)
    doc.text('QUESTION', col.q, y, { width: col.marks - col.q - 8, lineBreak: false })
    doc.text('MAX', col.marks, y, { lineBreak: false })
    doc.text('SCORE', col.score, y, { lineBreak: false })
    doc.text('VERDICT', col.verdict, y, { lineBreak: false })
    doc.x = contentLeft
    doc.y = y + 14
    doc
      .moveTo(contentLeft, doc.y)
      .lineTo(contentLeft + contentWidth, doc.y)
      .lineWidth(0.75)
      .strokeColor('#d9d3e4')
      .stroke()
    doc.y += 6
  }

  tableHeader()

  let totalScore = 0
  let totalMax = 0

  for (const q of questions) {
    if (doc.y > bottomLimit - 24) {
      doc.addPage()
      tableHeader()
    }

    const meta = verdictMeta(q.grade)
    const max = maxMarksFor(q)
    if (q.grade?.score != null) totalScore += q.grade.score
    if (max != null) totalMax += max

    const y = doc.y
    doc
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .fillColor(INK)
      .text(`Q${q.displayNumber}`, col.q, y, { width: col.marks - col.q - 8, lineBreak: false })
    doc.font('Helvetica').fontSize(9.5).fillColor(INK)
    doc.text(max != null ? String(max) : '-', col.marks, y, { lineBreak: false })
    doc.text(q.grade?.score != null ? String(q.grade.score) : '-', col.score, y, { lineBreak: false })
    doc.font('Helvetica-Bold').fillColor(meta.color).text(meta.label, col.verdict, y, { lineBreak: false })

    doc.x = contentLeft
    doc.y = y + 15
  }

  doc.y += 8

  // Total banner
  const pct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : null
  if (doc.y > bottomLimit - 60) doc.addPage()
  const bannerTop = doc.y
  const bannerHeight = 34
  doc.roundedRect(contentLeft, bannerTop, contentWidth, bannerHeight, 8).fill(FEEDBACK_BG)
  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(13)
    .text(
      `TOTAL: ${totalScore} / ${totalMax}${pct != null ? `   (${pct}%)` : ''}`,
      contentLeft + 14,
      bannerTop + 9,
      { lineBreak: false },
    )
  doc.x = contentLeft
  doc.y = bannerTop + bannerHeight + 20

  // Overall feedback
  if (result.overallFeedback) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('Overall Feedback', contentLeft, doc.y)
    doc.moveDown(0.3)
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(MUTED)
      .text(result.overallFeedback, contentLeft, doc.y, { width: contentWidth })
  }

  // ---------------------------------------------------------------------------
  // Pages 2..N - annotated answer-sheet pages
  // ---------------------------------------------------------------------------
  const locatedQuestionIds = new Set()

  for (const page of answerPages) {
    doc.addPage()

    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(INK)
      .text(`Answer Sheet - Page ${page.page}`, contentLeft, doc.page.margins.top)
    doc.moveDown(0.4)

    // Fit the page image: full content width, capped at half the content height so
    // annotations have room beneath it.
    const imgTop = doc.y
    const aspect = page.width > 0 ? page.height / page.width : 1.414
    const maxImgHeight = (bottomLimit - imgTop) * 0.5
    let imgW = contentWidth
    let imgH = imgW * aspect
    if (imgH > maxImgHeight) {
      imgH = maxImgHeight
      imgW = imgH / aspect
    }
    const imgX = contentLeft + (contentWidth - imgW) / 2

    let drewImage = false
    try {
      const b64 = String(page.dataUrl || '').split(',')[1]
      if (b64) {
        doc.image(Buffer.from(b64, 'base64'), imgX, imgTop, { width: imgW, height: imgH })
        drewImage = true
      }
    } catch {
      // fall through - the annotations below still carry the graded content
    }

    if (drewImage) {
      // Highlight boxes for every question's regions on this page.
      for (const q of questions) {
        const meta = verdictMeta(q.grade)
        const color = q.grade ? meta.color : PURPLE
        for (const region of q.regions ?? []) {
          if (region.page !== page.page) continue
          doc
            .save()
            .rect(imgX + region.x * imgW, imgTop + region.y * imgH, region.width * imgW, region.height * imgH)
            .lineWidth(1)
            .strokeColor(color)
            .fillColor(color)
            .fillOpacity(0.12)
            .fillAndStroke()
            .restore()
        }
      }
      doc.x = contentLeft
      doc.y = imgTop + imgH + 16
    } else {
      doc
        .font('Helvetica-Oblique')
        .fontSize(9)
        .fillColor(MUTED)
        .text('(page image unavailable)', contentLeft, imgTop)
      doc.moveDown(1)
    }

    // Annotation blocks for questions whose answer appears on this page.
    const pageQuestions = questions.filter((q) => (q.regions ?? []).some((r) => r.page === page.page))
    for (const q of pageQuestions) locatedQuestionIds.add(q.id)

    if (pageQuestions.length === 0) {
      doc
        .font('Helvetica-Oblique')
        .fontSize(9)
        .fillColor(MUTED)
        .text('No graded answers located on this page.', contentLeft, doc.y)
      continue
    }

    for (const q of pageQuestions) {
      if (doc.y > bottomLimit - 60) {
        doc.addPage()
        doc
          .font('Helvetica-Bold')
          .fontSize(10)
          .fillColor(MUTED)
          .text(`Answer Sheet - Page ${page.page} (annotations continued)`, contentLeft, doc.page.margins.top)
        doc.moveDown(0.5)
      }
      writeAnnotation(doc, q, contentLeft, contentWidth)
    }
  }

  // ---------------------------------------------------------------------------
  // Trailing section - questions never located on any answer-sheet page
  // ---------------------------------------------------------------------------
  const unlocated = questions.filter((q) => !locatedQuestionIds.has(q.id))
  if (unlocated.length > 0) {
    doc.addPage()
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor(INK)
      .text('Not Located on the Answer Sheet', contentLeft, doc.page.margins.top)
    doc
      .moveDown(0.3)
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text('These questions could not be matched to a spot on the scanned pages.', contentLeft, doc.y)
    doc.moveDown(0.8)

    for (const q of unlocated) {
      if (doc.y > bottomLimit - 60) {
        doc.addPage()
        doc.y = doc.page.margins.top
      }
      writeAnnotation(doc, q, contentLeft, contentWidth)
    }
  }

  // ---------------------------------------------------------------------------
  // Footer on every page. Writing into the bottom margin band would trip
  // pdfkit's page-overflow check and spawn blank pages, so drop the bottom
  // margin to 0 for the duration of the footer pass.
  // ---------------------------------------------------------------------------
  const range = doc.bufferedPageRange()
  const savedBottom = doc.page.margins.bottom
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    doc.page.margins.bottom = 0
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        `VedaAI checked copy  ·  Page ${i + 1} of ${range.count}`,
        contentLeft,
        bottomLimit + 16,
        { width: contentWidth, align: 'center', lineBreak: false },
      )
    doc.page.margins.bottom = savedBottom
  }

  doc.end()
  return doc
}

function writeAnnotation(doc, question, left, width) {
  const meta = verdictMeta(question.grade)

  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor(meta.color)
    .text(`Q${question.displayNumber}   ${meta.label} · ${scoreLabel(question)}`, left, doc.y, { width })

  const feedback = question.grade?.feedback || 'No feedback for this question.'
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(feedback, left, doc.y, { width })

  if (question.questionType === 'mcq' || question.questionType === 'assertion_reason') {
    const chosen = question.selectedOption ?? '-'
    const correct = question.grade?.correctOption ?? '-'
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(INK)
      .text(`Chosen: ${chosen}    Correct: ${correct}`, left, doc.y, { width })
  }

  doc.moveDown(0.7)
}
