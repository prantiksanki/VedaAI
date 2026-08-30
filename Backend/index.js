import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { v4 as uuid } from 'uuid'

import { rasterize } from './lib/rasterize.js'
import { detectLines } from './lib/lineGeometry.js'
import { extractQuestions } from './lib/extractQuestions.js'
import { extractAndMapAnswers } from './lib/extractAnswers.js'
import { gradeAnswers } from './lib/gradeAnswers.js'
import { buildCheckedCopyPdf } from './lib/checkedCopyReport.js'
import { detectAiContent } from './lib/winstonClient.js'
import { buildAiDetectionReportPdf } from './lib/plagiarismReport.js'
import { createJob, getJob, updateJob } from './lib/store.js'

const app = express()
const PORT = process.env.PORT || 4000

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }))
// Limit is generous: the checked-copy endpoint receives the graded result including
// base64 answer-sheet page images (answer-sheet upload cap is 25MB; base64 inflates ~33%).
app.use(express.json({ limit: '30mb' }))

const MAX_FILE_SIZE = 25 * 1024 * 1024 // 25MB - scanned PDFs/photos routinely exceed 10MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
})

app.get('/health', (req, res) => res.json({ ok: true }))
app.head('/health', (req, res) => res.sendStatus(200))

function handleUpload(req, res, next) {
  upload.fields([
    { name: 'questionPaper', maxCount: 1 },
    { name: 'answerSheet', maxCount: 1 },
  ])(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          error: `"${err.field}" is too large. Max file size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.`,
        })
      }
      return res.status(400).json({ error: err.message })
    }
    if (err) return next(err)
    next()
  })
}

app.post('/api/upload', handleUpload, async (req, res) => {
  const questionPaperFile = req.files?.questionPaper?.[0]
  const answerSheetFile = req.files?.answerSheet?.[0]

  if (!questionPaperFile || !answerSheetFile) {
    return res.status(400).json({ error: 'Both questionPaper and answerSheet files are required.' })
  }

  const jobId = uuid()
  createJob(jobId)
  res.status(202).json({ jobId })

  processJob(jobId, questionPaperFile, answerSheetFile).catch((err) => {
    console.error(`Job ${jobId} failed:`, err)
    updateJob(jobId, { status: 'error', error: err.message })
  })
})

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  res.json(job)
})

// Builds a downloadable "checked copy" PDF (grading summary + annotated answer-sheet
// pages) from the graded result the frontend already holds.
app.post('/api/checked-copy', async (req, res, next) => {
  try {
    const { result } = req.body ?? {}
    if (!result || !Array.isArray(result.questions) || !Array.isArray(result.answerPages)) {
      return res.status(400).json({ error: 'A graded result is required.' })
    }

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename="checked-copy.pdf"')

    buildCheckedCopyPdf(result).pipe(res)
  } catch (err) {
    next(err)
  }
})

// Runs Winston AI content detection on the teacher's question-paper text and
// streams back a downloadable PDF report.
app.post('/api/plagiarism-report', async (req, res, next) => {
  try {
    const { text } = req.body ?? {}
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'text is required' })
    }

    const trimmed = text.trim()
    if (trimmed.length < 300) {
      return res.status(400).json({
        error: 'Not enough text to analyze. Winston AI needs at least 300 characters.',
      })
    }

    const winston = await detectAiContent(trimmed.slice(0, 150000))

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename="ai-content-detection-report.pdf"')

    const wordCount = trimmed.split(/\s+/).filter(Boolean).length
    buildAiDetectionReportPdf(winston, { wordCount }).pipe(res)
  } catch (err) {
    next(err)
  }
})

// Wrap a pipeline stage so a failure is recorded on the job with the stage name,
// instead of surfacing as a generic 500.
async function stage(jobId, step, fn) {
  updateJob(jobId, { step })
  try {
    return await fn()
  } catch (err) {
    const message = `${step}: ${err.message}`
    console.error(`Job ${jobId} ${message}`)
    updateJob(jobId, { status: 'error', error: message, failedStep: step })
    throw err
  }
}

async function processJob(jobId, questionPaperFile, answerSheetFile) {
  const [questionPaperPages, answerPages, answerLineGeometry] = await stage(jobId, 'rasterizing', () =>
    Promise.all([
      rasterize({
        buffer: questionPaperFile.buffer,
        mimetype: questionPaperFile.mimetype,
        originalname: questionPaperFile.originalname,
      }),
      rasterize({
        buffer: answerSheetFile.buffer,
        mimetype: answerSheetFile.mimetype,
        originalname: answerSheetFile.originalname,
      }),
      // Geometry only (no text reading) - gives pixel-precise line boxes for the
      // vision model to point at, instead of guessing coordinates. Non-fatal if the
      // service is down: extraction/grading still work, just without highlight boxes.
      detectLines({
        buffer: answerSheetFile.buffer,
        mimetype: answerSheetFile.mimetype,
        originalname: answerSheetFile.originalname,
      }).catch((err) => {
        console.error(`Job ${jobId} line-geometry unavailable (non-fatal): ${err.message}`)
        return null
      }),
    ]),
  )

  const questions = await stage(jobId, 'extracting_questions', () => extractQuestions(questionPaperPages))

  const { mappings } = await stage(jobId, 'mapping_answers', () =>
    extractAndMapAnswers(questions, answerPages, answerLineGeometry),
  )

  // Grading is best-effort: if it fails, the teacher still gets extraction + mapping.
  updateJob(jobId, { step: 'grading' })
  let grading = null
  try {
    grading = await gradeAnswers(questions, mappings, answerPages)
  } catch (err) {
    console.error(`Job ${jobId} grading failed (non-fatal): ${err.message}`)
  }

  const answerPageMeta = answerPages.map((p) => ({ page: p.page, width: p.width, height: p.height, dataUrl: p.dataUrl }))
  const gradeById = new Map((grading?.grades ?? []).map((g) => [g.questionId, g]))
  const mappingById = new Map(mappings.map((m) => [m.questionId, m]))

  // Concatenated printed text of the question paper, kept so the results screen
  // can run the AI content-detection check without re-reading the file. The vision
  // pipeline doesn't OCR the question paper into raw lines - reconstruct the same
  // "full printed text" input from the questions it already extracted.
  const questionPaperText = questions
    .map((q) => {
      const optionsText = (q.options ?? []).map((o) => `(${o.label}) ${o.text}`).join(' ')
      return [q.displayNumber, q.text, optionsText].filter(Boolean).join(' ')
    })
    .join(' ')
    .trim()

  const questionResults = questions.map((q) => {
    const { regions: _paperRegions, ...questionRest } = q
    const mapping = mappingById.get(q.id) ?? {
      status: 'unanswered',
      answerText: null,
      selectedOption: null,
      regions: [],
    }
    const { _isObjective, ...mappingRest } = mapping
    return { ...questionRest, ...mappingRest, grade: gradeById.get(q.id) ?? null }
  })

  const lowConfidence = questionResults.filter((q) => q.grade?.confidence === 'low').length

  updateJob(jobId, {
    status: 'done',
    step: 'complete',
    error: null,
    result: {
      questions: questionResults,
      answerPages: answerPageMeta,
      overallFeedback: grading?.overallFeedback ?? null,
      gradingAvailable: !!grading,
      lowConfidenceCount: lowConfidence,
      questionPaperText,
    },
  })
}

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: err.message || 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`)
})
