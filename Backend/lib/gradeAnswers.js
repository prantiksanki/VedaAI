import { callStructured } from './openaiClient.js'
import { OBJECTIVE_QUESTION_TYPES } from './extractQuestions.js'

const GRADING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    grades: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          questionId: { type: 'string' },
          correctOption: {
            type: ['string', 'null'],
            description:
              'For an MCQ / assertion-reason / true-false / fill-blank question: the LETTER of the option you determine is correct (e.g. "a"). null for open-ended questions.',
          },
          effectiveMaxMarks: {
            type: 'number',
            description: 'The max marks used for this question - either the printed maxMarks if given, or your inferred ceiling based on question complexity',
          },
          expectedPoints: {
            type: 'number',
            description: 'How many distinct key points/steps a complete answer to this question should cover (your own estimate, used to judge coverage)',
          },
          coveredPoints: {
            type: 'number',
            description: 'How many of those expected points the student\'s answer actually covers, correctly',
          },
          verdict: { type: 'string', enum: ['correct', 'partially_correct', 'incorrect', 'unanswered'] },
          score: { type: 'number', description: 'Score out of effectiveMaxMarks, 0 if unanswered' },
          feedback: { type: 'string', description: 'One to two sentence feedback for the student' },
        },
        required: ['questionId', 'correctOption', 'effectiveMaxMarks', 'expectedPoints', 'coveredPoints', 'verdict', 'score', 'feedback'],
      },
    },
    overallFeedback: {
      type: 'string',
      description: 'Two to three sentence overall summary of the student performance',
    },
  },
  required: ['grades', 'overallFeedback'],
}

const SYSTEM_PROMPT = `You are an experienced teacher grading a student's exam answers, weighting marks by how much each question actually demands.

You will receive a list of questions (with printed maxMarks if available - may be null), each with a "questionType", and the student's transcribed answer for each (or "unanswered"). MCQ-style items also carry "options" (the answer choices) and "selectedOption" (the letter the student picked, or null). Each item also has "ocrLimited": true when the answer likely contains a diagram, drawing, or complex mathematical notation (equations with fractions, square roots, exponents, subscripts, etc).

OBJECTIVE QUESTIONS - questionType "mcq", "assertion_reason", "true_false", or "fill_blank":
- These are graded as a single right/wrong match, NOT by key-point coverage.
- First, work out the correct answer YOURSELF from the question stem and the "options" list, and put its letter in "correctOption" (for true_false/fill_blank without lettered options, still reason out the correct answer and describe it in feedback; correctOption may be null there).
- Then compare "selectedOption" (or the student's stated answer) to the correct answer:
  - matches -> verdict "correct", score = effectiveMaxMarks, coveredPoints = expectedPoints.
  - present but wrong -> verdict "incorrect", score = 0, coveredPoints = 0.
  - "unanswered" / selectedOption null and no stated answer -> verdict "unanswered", score = 0.
- effectiveMaxMarks = printed maxMarks if given, else 1. expectedPoints = 1.
- Do NOT apply the key-point-coverage logic or the OCR-diagram leniency to these questions.
- Feedback: state the correct option/answer; if the student was wrong, one short sentence on why.
- Set "correctOption" to null for every open-ended (short_answer / long_answer / numerical) question.

OPEN-ENDED QUESTIONS - questionType "short_answer", "long_answer", "numerical": grade as described below.

IMPORTANT - OCR limitation: the "studentAnswer" text comes from OCR on handwriting, which can only capture words in reading order - it CANNOT represent diagrams, flowcharts, boxes, arrows, or the actual 2D structure of a mathematical derivation (fractions, roots, superscripts collapse into flat, sometimes garbled text). A hand-drawn block diagram legitimately produces VERY LITTLE linear text - maybe only 3-6 short labels (box/component names) - even when the student drew a completely correct, fully detailed diagram, because most of the diagram's information is in shapes, boxes, and arrows that OCR cannot read at all. Do not expect diagram answers to look like written paragraphs.

When "ocrLimited" is true for a question:
- Do NOT penalize the answer for "missing" a diagram, "lacking detail", or being "too brief"/"too short" - a handful of correct component/block labels IS the expected, normal OCR footprint of a correct, complete diagram. This is not weak evidence, it is what a correctly-drawn diagram looks like once flattened to OCR text.
- If the labels present in the OCR text are terms that plausibly belong in this diagram/derivation (component names, signal names, formula fragments, final results), treat that as a strong signal of a correct, complete answer and award close to full marks - the actual visual layout, boxes, and arrows exist on the page even though you cannot see them.
- Only reduce the score if the OCR text contains labels/terms that are clearly WRONG or irrelevant to this specific question, or if there is no OCR text at all near this question (suggesting nothing was drawn).
- In feedback, do not say detail, boxes, arrows, or diagram structure was missing - instead say the diagram/derivation itself could not be fully verified from the scan, and comment only on whether the visible labels/terms are correct for this question.

For each open-ended question, work in two steps:

STEP 1 - Determine effectiveMaxMarks:
- If the question paper printed maxMarks for this question, use that value exactly.
- If not, INFER an appropriate ceiling from the question's own complexity and length - do not default to a flat number:
  - A simple one-line factual/definition question (e.g. "What is X?", "Define Y") -> low marks, around 1-3.
  - A question asking for an explanation with a few points, or a short calculation -> moderate marks, around 4-6.
  - A question demanding a derivation, multi-part answer, diagram, or several distinct steps/sub-results -> higher marks, around 7-10+.
  - Use your judgement on the actual demand of the question text - longer, more multi-part questions asking for more distinct things should get a higher ceiling than short factual ones.

STEP 2 - Score by coverage against that ceiling:
- Identify the distinct key points/steps a complete, correct answer to this question should include (expectedPoints - your own count).
- Count how many of those the student's answer actually gets right (coveredPoints) - remembering the ocrLimited leniency rule above when it applies.
- score = effectiveMaxMarks * (coveredPoints / expectedPoints), rounded sensibly, then adjusted for correctness of what IS covered (wrong content among what's covered should reduce the score, not just missing content).
- verdict: "correct" if coveredPoints is essentially all of expectedPoints and correct; "partially_correct" if some but not all; "incorrect" if answered but covers essentially none of the expected content correctly; "unanswered" if no answer was given (score 0).
- Give brief, constructive, specific feedback (1-2 sentences) naming what was covered well and what was missing.

Also provide a short overall performance summary.
Be fair and consistent. Do not penalize minor spelling/grammar issues from handwriting transcription - judge the substance of the answer.`

const DIAGRAM_OR_FORMULA_PATTERN =
  /\b(draw|diagram|block diagram|sketch|plot|graph|derive|derivation|equation|expression|circuit|waveform|spectrum|constellation)\b/i

/**
 * Heuristic: does this question likely expect a diagram or complex math notation
 * that OCR (which only captures words in reading order) cannot fully represent?
 */
function isOcrLimited(questionText, questionType) {
  // Objective questions (MCQ, true/false, etc.) are graded as a single right/wrong
  // match - a wrong answer must be able to score 0, so the diagram/formula floor
  // never applies to them regardless of any keyword in the stem.
  if (OBJECTIVE_QUESTION_TYPES.has(questionType)) return false
  return DIAGRAM_OR_FORMULA_PATTERN.test(questionText)
}

const OCR_LIMITED_MIN_ANSWER_LENGTH = 8 // characters - filters out near-empty "answers" from getting the floor
const OCR_LIMITED_SCORE_FLOOR_RATIO = 0.7 // minimum fraction of effectiveMaxMarks for a diagram/formula question with real content

/**
 * The LLM inconsistently follows the "don't penalize thin diagram/formula OCR" instruction
 * in the prompt (verified: identical input graded 3/9 then 0/9 across runs). This is a
 * deterministic backstop: if a question likely needs a diagram/complex notation, the student
 * wrote something substantial there, and the LLM still scored it low, lift the score to a
 * floor rather than relying on the LLM alone to be lenient every time.
 */
function applyOcrLimitedFloor(questions, mappingById, grades) {
  const questionById = new Map(questions.map((q) => [q.id, q]))

  return grades.map((grade) => {
    const question = questionById.get(grade.questionId)
    const mapping = mappingById.get(grade.questionId)
    if (!question || !mapping || mapping.status !== 'answered') return grade
    if (!isOcrLimited(question.text, question.questionType)) return grade
    if ((mapping.answerText?.length ?? 0) < OCR_LIMITED_MIN_ANSWER_LENGTH) return grade
    // Require the LLM to have found at least some genuine coverage - this is what
    // distinguishes "thin OCR of real diagram content" from "off-topic/no-answer text
    // that happens to be long enough", which should NOT get the benefit of the doubt.
    if (!(grade.coveredPoints > 0)) return grade

    const floor = Math.round(grade.effectiveMaxMarks * OCR_LIMITED_SCORE_FLOOR_RATIO)
    if (grade.score >= floor) return grade

    return {
      ...grade,
      score: floor,
      verdict: grade.verdict === 'incorrect' || grade.verdict === 'unanswered' ? 'partially_correct' : grade.verdict,
      feedback: `${grade.feedback} (Diagram/derivation content was present but could not be fully verified from the scan, so this score reflects the benefit of the doubt.)`,
    }
  })
}

/**
 * @param {Array<{id:string, displayNumber:string, text:string, maxMarks:number|null, questionType?:string, options?:Array<{label:string,text:string}>}>} questions
 * @param {Array<{questionId:string, status:string, answerText:string|null, selectedOption?:string|null}>} mappings
 */
export async function gradeAnswers(questions, mappings) {
  const mappingById = new Map(mappings.map((m) => [m.questionId, m]))

  const payload = questions.map((q) => {
    const mapping = mappingById.get(q.id)
    const questionType = q.questionType ?? 'long_answer'
    return {
      questionId: q.id,
      displayNumber: q.displayNumber,
      questionType,
      questionText: q.text,
      options: q.options ?? [],
      maxMarks: q.maxMarks,
      studentAnswer: mapping?.status === 'answered' ? mapping.answerText : null,
      selectedOption: mapping?.selectedOption ?? null,
      status: mapping?.status ?? 'unanswered',
      ocrLimited: isOcrLimited(q.text, questionType),
    }
  })

  const userContent = [
    {
      type: 'text',
      text: `Grade the following questions and answers (JSON):\n${JSON.stringify(payload, null, 2)}`,
    },
  ]

  const result = await callStructured({
    systemPrompt: SYSTEM_PROMPT,
    userContent,
    schemaName: 'grading',
    schema: GRADING_SCHEMA,
  })

  const withOcrFloor = applyOcrLimitedFloor(questions, mappingById, result.grades)
  return {
    ...result,
    grades: enforceObjectiveGrades(questions, mappingById, withOcrFloor),
  }
}

/**
 * Deterministic backstop for objective questions: once the LLM has decided which
 * option is correct, the verdict/score is a mechanical comparison. The LLM is not
 * always consistent about this (same failure mode as applyOcrLimitedFloor), so
 * recompute it here rather than trust the model's arithmetic.
 */
function enforceObjectiveGrades(questions, mappingById, grades) {
  const questionById = new Map(questions.map((q) => [q.id, q]))

  return grades.map((grade) => {
    const question = questionById.get(grade.questionId)
    if (!question || !OBJECTIVE_QUESTION_TYPES.has(question.questionType)) return grade

    const mapping = mappingById.get(grade.questionId)
    const selected = mapping?.selectedOption ?? null
    const correct = grade.correctOption ?? null
    const maxMarks = question.maxMarks ?? grade.effectiveMaxMarks ?? 1

    // Unanswered: nothing selected.
    if (mapping?.status !== 'answered' || !selected) {
      return {
        ...grade,
        effectiveMaxMarks: maxMarks,
        expectedPoints: 1,
        coveredPoints: 0,
        verdict: 'unanswered',
        score: 0,
      }
    }

    // Can't determine correctness (LLM gave no correctOption) - leave the LLM's own call.
    if (!correct) return { ...grade, effectiveMaxMarks: maxMarks, expectedPoints: 1 }

    const isRight = selected.toLowerCase() === correct.toLowerCase()
    return {
      ...grade,
      effectiveMaxMarks: maxMarks,
      expectedPoints: 1,
      coveredPoints: isRight ? 1 : 0,
      verdict: isRight ? 'correct' : 'incorrect',
      score: isRight ? maxMarks : 0,
    }
  })
}
