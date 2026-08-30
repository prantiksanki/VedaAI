import { callStructured, userContent } from './llmClient.js'
import { OBJECTIVE_QUESTION_TYPES } from './extractQuestions.js'

// How many answer-sheet page images to send per grading call. Grading is batched by
// page (all questions whose answers live on those pages are graded in ONE request),
// instead of one request per question - that used to fire up to ~30 parallel
// image-heavy calls for a single paper and blew through the org's tokens-per-minute
// limit. Keep this small enough that a request stays well under typical TPM limits
// even with several full-page images at high detail.
const PAGES_PER_CALL = 2
// Re-grade a page-batch once more if ANY open-ended question in it came back
// low-confidence; if the two runs disagree by more than this on a given question,
// take the lower score and keep it flagged for teacher review.
const SELF_CONSISTENCY_TOLERANCE = 1

const GRADE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    grades: {
      type: 'array',
      description: 'One entry per question graded from what is visible on these pages.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          questionId: { type: 'string', description: 'id copied exactly from the provided question list' },
          // "working" MUST come before "correctAnswer": structured-output generation
          // follows key order, so without a reasoning field ahead of it the model
          // commits to an answer before doing any actual work. Verified this causes
          // real arithmetic errors on computed-answer MCQs (e.g. AP/GP terms) that a
          // plain "solve it and answer" instruction does not fix on its own.
          working: {
            type: 'string',
            description:
              'Work out the answer step by step here FIRST, especially for anything computed (arithmetic, formulas, derivations). A one-line justification is fine for simple factual/definitional questions.',
          },
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
        required: ['questionId', 'working', 'correctAnswer', 'effectiveMaxMarks', 'keyPoints', 'verdict', 'score', 'feedback', 'confidence', 'confidenceReason'],
      },
    },
  },
  required: ['grades'],
}

const SYSTEM_PROMPT = `You are an experienced teacher marking a student's exam. You are shown page images of the student's answer sheet and a list of questions (with printed marks, options, and where on these pages each answer is transcribed/located).

Grade EVERY question in the list whose answer appears on these pages - look at the actual page image for each one, not just the transcription, since transcriptions can lose diagrams, math notation, and working.

FIRST, in "working": actually solve/derive the question yourself before judging the student's answer. For anything computed (arithmetic, formulas, series, geometry, chemistry equations, etc.) show the calculation step by step and double-check the final number - do not state a final answer you have not actually worked out. This matters even for multiple-choice: pick the correct option by solving the question, not by pattern-matching the option text.

Work marks by how much the question actually demands:
- If the paper printed marks for this question, use exactly that as effectiveMaxMarks.
- If not, infer a sensible ceiling: a one-line definition/fact -> ~1-3; an explanation or short calculation -> ~4-6; a derivation, proof, multi-step problem, or diagram -> ~7-10+.

Then:
- List the distinct key points/steps a complete correct answer needs, and mark each covered or not from what the student actually wrote/drew on the page (diagrams, working, and notation - not just the transcription).
- Award "score" for the points genuinely covered and correct. Wrong content among what's covered reduces the score.
- verdict: "correct" = essentially all key points, correct; "partially_correct" = some; "incorrect" = attempted but essentially nothing correct; "unanswered" = nothing written for this question on these pages.
- Do not penalise handwriting-transcription typos - mark the substance.
- Give brief, specific feedback naming what was right and what was missing.
- Set confidence "low" (with a reason) if the writing is hard to read, the answer is ambiguous, or the score is a borderline judgement call. Otherwise "high".

For OBJECTIVE questions (multiple-choice, assertion-reason, true/false, fill-in-the-blank): work out the correct answer yourself. For multiple-choice / assertion-reason, set "correctAnswer" to ONLY the option's bare letter (e.g. "a" or "b") - never the option's value, never both, never with parentheses or extra words. For true/false, use exactly "true" or "false". For fill-in-the-blank, use the expected text. Give keyPoints a single entry, and set score = effectiveMaxMarks if the student's choice matches, else 0 (the final match is re-checked deterministically afterwards, so just state correctAnswer clearly in the required format).

Only include a "grades" entry for a question if you can actually see its answer (or confirm it's genuinely blank) on these pages. If a question in the list has no trace here, omit it - it will be graded from another batch of pages.`

function chunkPages(pages, size) {
  const out = []
  for (let i = 0; i < pages.length; i += size) out.push(pages.slice(i, i + size))
  return out
}

async function gradePageBatch(questionList, pages) {
  const imageDataUrls = pages.map((p) => p.dataUrl)
  const labelled = pages.map((p, i) => `Image ${i + 1} is answer-sheet page ${p.page}.`).join('\n')

  const result = await callStructured({
    system: SYSTEM_PROMPT,
    content: userContent(
      `Question list (JSON) - includes each question's text, options, marks, the student's transcribed answer, and which page(s)/regions it was found on:\n${JSON.stringify(questionList, null, 2)}\n\n${labelled}\n\nGrade every question above whose answer is visible on these pages.`,
      imageDataUrls,
    ),
    schemaName: 'grade_batch',
    schema: GRADE_SCHEMA,
    stage: 'gradeAnswers',
    maxTokens: 8000,
  })
  return result.grades ?? []
}

function normText(v) {
  return String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Resolves a free-form "correct answer" string from the grader (which may be a bare
 * letter "a", the option's value "47", or both combined "(a) 47" despite the prompt
 * asking for just the letter) back to a canonical option letter, using the question's
 * own options list. Mirrors how extractAnswers.js resolves the student's own choice.
 * Falls back to the normalized raw string for MCQ-less objective types (true_false,
 * fill_blank) where there is no options list to match against.
 */
function resolveOptionLetter(rawAnswer, options) {
  const norm = normText(rawAnswer)
  if (!norm) return null
  if (!options?.length) return norm

  // Direct letter match: the model said e.g. "a" or "(a)".
  const byLetter = options.find((o) => normText(o.label) === norm)
  if (byLetter) return normText(byLetter.label)

  // Value match: the model said the option's text instead of its letter.
  const byValue = options.find((o) => normText(o.text) === norm)
  if (byValue) return normText(byValue.label)

  // Combined "(a) 47" or "a 47": the string contains a known letter/value pair.
  const byLetterAndValue = options.find(
    (o) => norm.includes(normText(o.label)) && norm.includes(normText(o.text)) && normText(o.text).length > 0,
  )
  if (byLetterAndValue) return normText(byLetterAndValue.label)

  // Isolated letter token anywhere in the raw string, e.g. "Option (a)", "Ans: a.",
  // "the answer is a" - bounded by non-letters so it doesn't match a letter buried
  // inside another word.
  const raw = String(rawAnswer ?? '').toLowerCase()
  const byIsolatedLetter = options.find((o) => {
    const letter = normText(o.label)
    if (!letter) return false
    return new RegExp(`(^|[^a-z0-9])${letter}([^a-z0-9]|$)`).test(raw)
  })
  if (byIsolatedLetter) return normText(byIsolatedLetter.label)

  return norm
}

/**
 * Deterministic re-check of objective questions from the model-stated correctAnswer
 * and the student's selectedOption. Fixes true_false / fill_blank (previously unscorable),
 * and resolves both sides through the question's options list so a grader that names the
 * option's VALUE instead of its LETTER (or both) doesn't get marked wrong against a bare
 * letter from the mapper.
 */
function enforceObjectiveGrade(question, mapping, grade) {
  if (!OBJECTIVE_QUESTION_TYPES.has(question.questionType)) return grade
  const max = question.maxMarks ?? grade.effectiveMaxMarks ?? 1
  const selected = mapping.selectedOption ?? null
  const correctRaw = grade.correctAnswer ?? null

  const base = { ...grade, effectiveMaxMarks: max, keyPoints: grade.keyPoints ?? [] }

  if (mapping.status !== 'answered' || selected == null) {
    return { ...base, verdict: 'unanswered', score: 0 }
  }
  if (correctRaw == null) {
    // model couldn't determine the answer key — keep its own call but clamp
    return { ...base, score: clamp(grade.score, 0, max) }
  }

  const options = question.options ?? []
  const selectedNorm = resolveOptionLetter(selected, options)
  const correctNorm = resolveOptionLetter(correctRaw, options)

  const isRight =
    selectedNorm === correctNorm ||
    // fill_blank: allow the student's text to contain / equal the expected answer
    (question.questionType === 'fill_blank' && normText(selected).includes(normText(correctRaw)) && normText(correctRaw).length > 0)

  return { ...base, verdict: isRight ? 'correct' : 'incorrect', score: isRight ? max : 0 }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, typeof n === 'number' ? n : 0))
}

/**
 * @param {Array<object>} questions
 * @param {Array<{questionId,status,answerText,selectedOption,regions}>} mappings
 * @param {Array<{page,width,height,dataUrl}>} answerPages
 */
export async function gradeAnswers(questions, mappings, answerPages) {
  const mappingById = new Map(mappings.map((m) => [m.questionId, m]))
  const questionById = new Map(questions.map((q) => [q.id, q]))

  // Group questions by which answer-sheet page-batch their regions fall on, so each
  // batch's prompt only needs to name the questions actually visible there. A question
  // with no located region (unanswered / no box) is graded once, in the first batch,
  // purely from its transcription (there's nothing page-specific to show it against).
  const groups = chunkPages(answerPages, PAGES_PER_CALL)
  const pageToGroupIndex = new Map()
  groups.forEach((g, i) => g.forEach((p) => pageToGroupIndex.set(p.page, i)))

  const questionsByGroup = groups.map(() => [])
  const noRegionQuestions = []
  for (const q of questions) {
    const mapping = mappingById.get(q.id) ?? { status: 'unanswered', regions: [] }
    const firstPage = mapping.regions?.[0]?.page
    const groupIdx = firstPage != null ? pageToGroupIndex.get(firstPage) : undefined
    if (groupIdx != null) questionsByGroup[groupIdx].push(q)
    else noRegionQuestions.push(q)
  }
  if (noRegionQuestions.length && groups.length) questionsByGroup[0].push(...noRegionQuestions)
  else if (noRegionQuestions.length) questionsByGroup.push(noRegionQuestions)
  if (!groups.length && noRegionQuestions.length) groups.push([])

  function buildQuestionList(groupQuestions) {
    return groupQuestions.map((q) => {
      const mapping = mappingById.get(q.id) ?? { status: 'unanswered', answerText: null, selectedOption: null }
      return {
        id: q.id,
        displayNumber: q.displayNumber,
        questionType: q.questionType ?? 'long_answer',
        text: q.text,
        options: q.options ?? [],
        maxMarks: q.maxMarks,
        status: mapping.status,
        transcribedAnswer: mapping.status === 'answered' ? mapping.answerText : null,
        selectedOption: mapping.selectedOption ?? null,
      }
    })
  }

  async function gradeGroup(groupQuestions, pages) {
    if (!groupQuestions.length) return []
    const questionList = buildQuestionList(groupQuestions)
    let grades = await gradePageBatch(questionList, pages)

    // Cost control: only re-grade the whole batch once more if it came back with any
    // low-confidence open-ended question, rather than doubling every batch. This
    // catches genuinely borderline cases without paying 2x on every request.
    const hasLowConfidenceOpenEnded = grades.some((g) => {
      const q = questionById.get(g.questionId)
      return q && !OBJECTIVE_QUESTION_TYPES.has(q.questionType) && g.confidence === 'low'
    })
    if (hasLowConfidenceOpenEnded) {
      const second = await gradePageBatch(questionList, pages)
      const secondById = new Map(second.map((g) => [g.questionId, g]))
      grades = grades.map((g) => {
        const q = questionById.get(g.questionId)
        const isObjective = q && OBJECTIVE_QUESTION_TYPES.has(q.questionType)
        const other = secondById.get(g.questionId)
        if (isObjective || !other) return g
        const lower = (other.score ?? 0) < (g.score ?? 0) ? other : g
        const diverged = Math.abs((g.score ?? 0) - (other.score ?? 0)) > SELF_CONSISTENCY_TOLERANCE
        return {
          ...lower,
          confidence: diverged ? 'low' : 'high',
          confidenceReason: diverged
            ? `Scores varied between grading runs (${g.score} vs ${other.score}); took the lower.`
            : null,
        }
      })
    }
    return grades
  }

  const perGroup = await Promise.all(groups.map((pages, i) => gradeGroup(questionsByGroup[i], pages)))
  const rawById = new Map()
  for (const grades of perGroup) {
    for (const g of grades) {
      if (questionById.has(g.questionId)) rawById.set(g.questionId, g)
    }
  }

  const grades = questions.map((q) => {
    const mapping = mappingById.get(q.id) ?? { status: 'unanswered' }
    const g = rawById.get(q.id)
    if (!g) {
      return {
        questionId: q.id,
        correctAnswer: null,
        effectiveMaxMarks: q.maxMarks ?? 1,
        keyPoints: [],
        verdict: mapping.status === 'answered' ? 'ungraded' : 'unanswered',
        score: 0,
        feedback:
          mapping.status === 'answered'
            ? 'This question could not be graded automatically — please review it.'
            : 'No answer was provided for this question.',
        confidence: mapping.status === 'answered' ? 'low' : 'high',
        confidenceReason: mapping.status === 'answered' ? 'Not returned by the grading model.' : null,
      }
    }
    const fixed = enforceObjectiveGrade(q, mapping, g)
    return {
      ...fixed,
      score: clamp(fixed.score, 0, fixed.effectiveMaxMarks ?? q.maxMarks ?? Infinity),
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
