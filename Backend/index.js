import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { v4 as uuid } from 'uuid'

import { ocrFile } from './lib/ocrClient.js'
import { extractQuestions } from './lib/extractQuestions.js'
import { extractAndMapAnswers } from './lib/extractAnswers.js'
import { gradeAnswers } from './lib/gradeAnswers.js'
import { createJob, getJob, updateJob } from './lib/store.js'

const app = express()
const PORT = process.env.PORT || 4000

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }))
app.use(express.json())

const MAX_FILE_SIZE = 25 * 1024 * 1024 // 25MB - scanned PDFs/photos routinely exceed 10MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
})

app.get('/health', (req, res) => res.json({ ok: true }))

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

async function processJob(jobId, questionPaperFile, answerSheetFile) {
  updateJob(jobId, { step: 'running_ocr' })
  const [questionOcrPages, answerOcrPages] = await Promise.all([
    ocrFile(questionPaperFile, 'printed'),
    ocrFile(answerSheetFile, 'handwritten'),
  ])

  updateJob(jobId, { step: 'extracting_questions' })
  const questions = await extractQuestions(questionOcrPages)

  updateJob(jobId, { step: 'mapping_answers' })
  const { mappings } = await extractAndMapAnswers(questions, answerOcrPages)

  updateJob(jobId, { step: 'grading' })
  let grading = null
  try {
    grading = await gradeAnswers(questions, mappings)
  } catch (err) {
    console.error(`Job ${jobId} grading failed (non-fatal):`, err)
  }

  const answerPageMeta = answerOcrPages.map((p) => ({ page: p.page, width: p.width, height: p.height, dataUrl: p.dataUrl }))
  const gradeById = new Map((grading?.grades ?? []).map((g) => [g.questionId, g]))

  const questionResults = questions.map((q) => {
    const { regions: questionPaperRegions, ...questionRest } = q
    const mapping = mappings.find((m) => m.questionId === q.id) ?? {
      status: 'unanswered',
      answerText: null,
      selectedOption: null,
      regions: [],
    }
    const grade = gradeById.get(q.id) ?? null
    // `regions` here is the answer's location on the answer sheet (what the frontend highlights),
    // not the question's own location on the question paper (questionPaperRegions, currently unused).
    return { ...questionRest, ...mapping, grade }
  })

  updateJob(jobId, {
    status: 'done',
    step: 'complete',
    result: {
      questions: questionResults,
      answerPages: answerPageMeta,
      overallFeedback: grading?.overallFeedback ?? null,
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
