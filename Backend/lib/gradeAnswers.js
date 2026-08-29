import sharp from 'sharp'
import { callStructured, userContent } from './llmClient.js'
import { OBJECTIVE_QUESTION_TYPES } from './extractQuestions.js'

// Cap on concurrent grading calls so we grade a 30-question paper fast without
// hammering rate limits.
const GRADE_CONCURRENCY = 6
// Re-grade open-ended answers twice; if the two scores disagree by more than this,
// take the lower and flag the question for teacher review.
const SELF_CONSISTENCY_TOLERANCE = 1

const GRADE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    correctAnswer: {
      type: ['string', 'null'],
      description: 'For objective questions: the correct option letter / "true"|"false" / expected blank text. For open-ended: a one-line model answer or key result. null only if genuinely indeterminable.',
    },
    effectiveMaxMarks: { type: 'number', description: 'Printed maxMarks if given; otherwise your inferred ceiling from the question\'s demand.' },
    keyPoints: {
      type: 'array',
      description: 'The distinct things a complete correct answer must contain, each with whether the student covered it.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          point: { type: 'string' },
          covered: { type: 'boolean' },
        },
        required: ['point', 'covered'],
      },
    },
    verdict: { type: 'string', enum: ['correct', 'partially_correct', 'incorrect', 'unanswered'] },
    score: { type: 'number', description: 'Marks awarded, 0..effectiveMaxMarks.' },
    feedback: { type: 'string', description: '1-2 sentences of specific feedback for the student.' },
    confidence: { type: 'string', enum: ['high', 'low'] },
    confidenceReason: { type: ['string', 'null'], description: 'If confidence is low, why (illegible, ambiguous, borderline).' },
  },
  required: ['correctAnswer', 'effectiveMaxMarks', 'keyPoints', 'verdict', 'score', 'feedback', 'confidence', 'confidenceReason'],
}

const SYSTEM_PROMPT = `You are an experienced teacher marking ONE exam question. You are given the question, the student's answer (transcription plus a cropped image of what they actually wrote/drew), and the printed marks if any.

Work marks by how much the question actually demands:
- If the paper printed marks for this question, use exactly that as effectiveMaxMarks.
- If not, infer a sensible ceiling: a one-line definition/fact → ~1-3; an explanation or short calculation → ~4-6; a derivation, proof, multi-step problem, or diagram → ~7-10+.

Then:
- List the distinct key points/steps a complete correct answer needs, and mark each covered or not from what the student actually wrote/drew (you can SEE the image — judge diagrams, working, and notation directly, not just the transcription).
- Award "score" for the points genuinely covered and correct. Wrong content among what's covered reduces the score.
- verdict: "correct" = essentially all key points, correct; "partially_correct" = some; "incorrect" = attempted but essentially nothing correct; "unanswered" = nothing written.
- Do not penalise handwriting-transcription typos — mark the substance.
- Give brief, specific feedback naming what was right and what was missing.
- Set confidence "low" (with a reason) if the writing is hard to read, the answer is ambiguous, or the score is a borderline judgement call. Otherwise "high".

For OBJECTIVE questions (multiple-choice, assertion-reason, true/false, fill-in-the-blank): work out the correct answer yourself and put it in "correctAnswer". Give keyPoints a single entry, and set score = effectiveMaxMarks if the student's choice matches, else 0 (the final match is re-checked deterministically afterwards, so just state correctAnswer clearly).`

async function cropRegion(pageImageBuffer, region, pagePx) {
  // region is normalized 0..1; expand slightly for context, clamp to page.
  const pad = 0.02
  const left = Math.max(0, region.x - pad)
  const top = Math.max(0, region.y - pad)
  const right = Math.min(1, region.x + region.width + pad)
  const bottom = Math.min(1, region.y + region.height + pad)
  const x = Math.round(left * pagePx.width)
  const y = Math.round(top * pagePx.height)
  const w = Math.max(1, Math.round((right - left) * pagePx.width))
  const h = Math.max(1, Math.round((bottom - top) * pagePx.height))
  const buf = await sharp(pageImageBuffer)
    .extract({ left: x, top: y, width: Math.min(w, pagePx.width - x), height: Math.min(h, pagePx.height - y) })
    .jpeg({ quality: 92 })
    .toBuffer()
  return `data:image/jpeg;base64,${buf.toString('base64')}`
}

function dataUrlToBuffer(dataUrl) {
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

async function gradeOne(question, mapping, answerPages) {
  const isObjective = OBJECTIVE_QUESTION_TYPES.has(question.questionType)
  const pageByNumber = new Map(answerPages.map((p) => [p.page, p]))

  // Build the answer-crop images (or, if unanswered / no region, none).
  const images = []
  for (const region of (mapping.regions ?? []).slice(0, 3)) {
    const page = pageByNumber.get(region.page)
    if (!page) continue
    try {
      images.push(await cropRegion(dataUrlToBuffer(page.dataUrl), region, { width: page.width, height: page.height }))
    } catch {
      /* skip a bad crop */
    }
  }

  const promptText = [
    `Question ${question.displayNumber} (${question.questionType}${question.maxMarks != null ? `, ${question.maxMarks} marks` : ''}):`,
    question.text,
    question.options?.length ? `Options:\n${question.options.map((o) => `  (${o.label}) ${o.text}`).join('\n')}` : '',
    '',
    mapping.status === 'answered'
      ? `Student's answer (transcription): ${mapping.answerText ?? '(no prose — see image / marked option)'}`
      : 'The student did not answer this question.',
    mapping.selectedOption != null ? `Student's selected option / stated answer: ${mapping.selectedOption}` : '',
    images.length ? '' : '(No answer image available.)',
  ]
    .filter(Boolean)
    .join('\n')

  const runOnce = () =>
    callStructured({
      system: SYSTEM_PROMPT,
      content: userContent(promptText, images),
      schemaName: 'grade_one',
      schema: GRADE_SCHEMA,
      stage: `gradeAnswers(${question.displayNumber})`,
      maxTokens: 4000,
    })

  let grade = await runOnce()

  // Cost control: only re-grade when the FIRST pass itself flagged uncertainty
  // (its own low-confidence signal), rather than doubling every open-ended call.
  // This catches genuinely borderline cases without paying 2x on every question.
  if (!isObjective && mapping.status === 'answered' && grade.confidence === 'low') {
    const second = await runOnce()
    const lower = (second.score ?? 0) < (grade.score ?? 0) ? second : grade
    grade = {
      ...lower,
      confidence: Math.abs((grade.score ?? 0) - (second.score ?? 0)) > SELF_CONSISTENCY_TOLERANCE ? 'low' : 'high',
      confidenceReason:
        Math.abs((grade.score ?? 0) - (second.score ?? 0)) > SELF_CONSISTENCY_TOLERANCE
          ? `Scores varied between grading runs (${grade.score} vs ${second.score}); took the lower.`
          : null,
    }
  }

  return { questionId: question.id, ...grade }
}

/**
 * Deterministic re-check of objective questions from the model-stated correctAnswer
 * and the student's selectedOption. Fixes true_false / fill_blank (previously unscorable).
 */
function enforceObjectiveGrade(question, mapping, grade) {
  if (!OBJECTIVE_QUESTION_TYPES.has(question.questionType)) return grade
  const max = question.maxMarks ?? grade.effectiveMaxMarks ?? 1
  const selected = mapping.selectedOption ?? null
  const correct = grade.correctAnswer ?? null

  const base = { ...grade, effectiveMaxMarks: max, keyPoints: grade.keyPoints ?? [] }

  if (mapping.status !== 'answered' || selected == null) {
    return { ...base, verdict: 'unanswered', score: 0 }
  }
  if (correct == null) {
    // model couldn't determine the answer key — keep its own call but clamp
    return { ...base, score: clamp(grade.score, 0, max) }
  }

  const norm = (v) => String(v).trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  const isRight =
    norm(selected) === norm(correct) ||
    // fill_blank: allow the student's text to contain / equal the expected answer
    (question.questionType === 'fill_blank' && norm(selected).includes(norm(correct)) && norm(correct).length > 0)

  return { ...base, verdict: isRight ? 'correct' : 'incorrect', score: isRight ? max : 0 }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, typeof n === 'number' ? n : 0))
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      results[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * @param {Array<object>} questions
 * @param {Array<{questionId,status,answerText,selectedOption,regions}>} mappings
 * @param {Array<{page,width,height,dataUrl}>} answerPages
 */
export async function gradeAnswers(questions, mappings, answerPages) {
  const mappingById = new Map(mappings.map((m) => [m.questionId, m]))

  const raw = await mapWithConcurrency(questions, GRADE_CONCURRENCY, (q) =>
    gradeOne(q, mappingById.get(q.id) ?? { status: 'unanswered', regions: [] }, answerPages).catch((err) => ({
      questionId: q.id,
      _error: err.message,
    })),
  )

  const grades = raw.map((g) => {
    const question = questions.find((q) => q.id === g.questionId)
    const mapping = mappingById.get(g.questionId) ?? { status: 'unanswered' }
    if (g._error) {
      return {
        questionId: g.questionId,
        correctAnswer: null,
        effectiveMaxMarks: question?.maxMarks ?? 1,
        keyPoints: [],
        verdict: 'ungraded',
        score: 0,
        feedback: 'This question could not be graded automatically — please review it.',
        confidence: 'low',
        confidenceReason: g._error,
      }
    }
    const fixed = enforceObjectiveGrade(question, mapping, g)
    return {
      ...fixed,
      score: clamp(fixed.score, 0, fixed.effectiveMaxMarks ?? question?.maxMarks ?? Infinity),
    }
  })

  const overallFeedback = buildOverallFeedback(questions, mappingById, grades)
  return { grades, overallFeedback }
}

function buildOverallFeedback(questions, mappingById, grades) {
  const gradeById = new Map(grades.map((g) => [g.questionId, g]))
  let total = 0
  let max = 0
  let answered = 0
  const weak = []
  for (const q of questions) {
    const g = gradeById.get(q.id)
    const m = mappingById.get(q.id)
    if (!g) continue
    total += g.score ?? 0
    max += g.effectiveMaxMarks ?? q.maxMarks ?? 0
    if (m?.status === 'answered') answered++
    if ((g.verdict === 'incorrect' || g.verdict === 'partially_correct') && m?.status === 'answered') {
      weak.push(q.displayNumber)
    }
  }
  const pct = max > 0 ? Math.round((total / max) * 100) : 0
  const parts = [`Scored ${total} out of ${max} (${pct}%), attempting ${answered} of ${questions.length} questions.`]
  if (weak.length) parts.push(`Lost marks on Q${weak.slice(0, 6).join(', Q')}${weak.length > 6 ? ' and others' : ''}.`)
  const lowConf = grades.filter((g) => g.confidence === 'low').length
  if (lowConf) parts.push(`${lowConf} question${lowConf > 1 ? 's are' : ' is'} flagged for teacher review.`)
  return parts.join(' ')
}
