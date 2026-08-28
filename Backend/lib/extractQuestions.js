import { callStructured } from './openaiClient.js'

const QUESTION_TYPES = ['mcq', 'assertion_reason', 'true_false', 'fill_blank', 'short_answer', 'long_answer', 'numerical']

// Types whose grading is a single right/wrong match against a known correct answer,
// not a key-point-coverage judgement. Kept here so the rest of the pipeline can
// import one source of truth.
export const OBJECTIVE_QUESTION_TYPES = new Set(['mcq', 'assertion_reason', 'true_false', 'fill_blank'])

const QUESTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          displayNumber: {
            type: 'string',
            description: 'Exact printed label, e.g. "11(a)", "3", "Q5b"',
          },
          baseNumber: {
            type: 'string',
            description: 'The root question number without sub-part, e.g. "11" for "11(a)"',
          },
          subpart: {
            type: ['string', 'null'],
            description: 'Sub-part label if present, e.g. "a", "b"; null if none. Do NOT set this for MCQ answer options.',
          },
          questionType: {
            type: 'string',
            enum: QUESTION_TYPES,
            description:
              'Type of question. "mcq": a stem followed by a short list of candidate answers to choose one from. "assertion_reason": an Assertion + Reason pair with fixed lettered choices. "true_false": asks to state true/false. "fill_blank": fill in the blank(s). "numerical": answer is a computed number/value. "short_answer": 1-3 sentence or single-step written answer. "long_answer": explanation, derivation, essay, multi-step or diagram answer.',
          },
          options: {
            type: 'array',
            description:
              'For questionType "mcq" and "assertion_reason": the list of answer choices exactly as printed. Empty array for every other type.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: { type: 'string', description: 'The option letter/marker, normalized to just the letter, e.g. "a", "b", "c", "d"' },
                text: { type: 'string', description: 'The option text as printed, e.g. "4", "Infinitely many solutions"' },
              },
              required: ['label', 'text'],
            },
          },
          text: {
            type: 'string',
            description: 'Full text of the question STEM as printed (do not include the MCQ options here - they go in "options")',
          },
          maxMarks: {
            type: ['number', 'null'],
            description: 'Marks allotted to this question if printed, else null',
          },
          page: {
            type: 'number',
            description: 'Page number (1-indexed) this question appears on',
          },
          lineIndices: {
            type: 'array',
            items: { type: 'number' },
            description:
              "Indices (from the numbered OCR line list on this page) of every line that belongs to this question's printed text. For MCQ, include BOTH the stem line(s) AND the option line(s).",
          },
        },
        required: ['displayNumber', 'baseNumber', 'subpart', 'questionType', 'options', 'text', 'maxMarks', 'page', 'lineIndices'],
      },
    },
  },
  required: ['questions'],
}

const SYSTEM_PROMPT = `You are an expert exam paper parser. You will be given OCR output for a question paper: for each page, a numbered list of text lines in top-to-bottom reading order.

Rules:
- Extract every question in the exact order they are printed.
- Preserve the exact original numbering/labels as printed (do not renumber or normalize).
- Skip instructions-only text, section headers, or preamble - those are not questions.
- If marks are printed next to a question (e.g. "[5 marks]", "(10)"), extract them as maxMarks.
- Record which page number each question appears on.
- OCR text may contain minor recognition errors (e.g. "0" vs "O", broken words) - use your judgement to reconstruct the intended text.
- Be exhaustive: do not skip any question, including short one-line ones.

CLASSIFY EVERY QUESTION with a "questionType":
- "mcq": a question stem immediately followed by a short enumerated list of candidate answers to pick ONE from - typically labelled (a)(b)(c)(d) or (A)(B)(C)(D) or (i)(ii)(iii)(iv), often printed on one or two lines, each option only a few words/a number, mutually exclusive, and NONE of them an instruction. Signals: "Choose the correct option", "Which of the following", options that are bare values/short noun phrases.
- "assertion_reason": an Assertion statement + a Reason statement followed by fixed lettered choices about their truth.
- "true_false": asks to state whether a statement is true or false.
- "fill_blank": a sentence with a blank to complete.
- "numerical": the expected answer is a single computed number or value (no options given).
- "short_answer": a 1-3 sentence or single-step written answer.
- "long_answer": explanation, derivation, proof, essay, diagram, or multi-step answer.

MCQ OPTIONS ARE NOT SUB-PARTS. This is the most important rule:
- When a question is an MCQ, emit EXACTLY ONE question entry for it. Put the stem in "text", put every choice in "options" as {label, text}, set questionType "mcq", set subpart to null. NEVER create separate entries like "1(a)", "1(b)", "1(c)", "1(d)" for the options of a single MCQ.
- A genuine sub-part is an INDEPENDENTLY LABELLED TASK that itself demands its own full answer, e.g. "Q3 (a) Prove that... (b) Hence find..." or "5. (a) Define X. (b) Give two examples." Genuine sub-parts contain imperative verbs (Find, Prove, Draw, Explain, Show, Derive, Calculate, State), often have their own marks, and are usually printed on separate lines. Only THESE get separate entries, with subpart set to "a"/"b"/etc.
- Disambiguation: if the lettered items are short mutually-exclusive candidate answers with no imperative verb -> they are MCQ options, keep them in "options" on one entry. If the lettered items are each a task to perform -> they are sub-parts, split them.
- "options" must be an empty array for every non-MCQ / non-assertion_reason question.

For each question, list the "lineIndices" - the indices of the OCR lines (from the numbered list given for that page) that make up this question's printed text, including the option lines for an MCQ. This is used to locate the question on the page later, so be accurate and only include lines that are actually part of that question.`

/**
 * @param {Array<{page:number, lines: Array<{text:string,x:number,y:number,width:number,height:number}>}>} ocrPages
 */
export async function extractQuestions(ocrPages) {
  const userText = ocrPages
    .map((page) => {
      const numberedLines = page.lines.map((line, i) => `[${i}] ${line.text}`).join('\n')
      return `--- Page ${page.page} (OCR lines) ---\n${numberedLines}`
    })
    .join('\n\n')

  const result = await callStructured({
    systemPrompt: SYSTEM_PROMPT,
    userContent: [{ type: 'text', text: userText }],
    schemaName: 'question_extraction',
    schema: QUESTIONS_SCHEMA,
  })

  return result.questions.map((q, index) => {
    const page = ocrPages.find((p) => p.page === q.page)
    const regions = (q.lineIndices ?? [])
      .map((i) => page?.lines[i])
      .filter(Boolean)
      .map((line) => ({ page: q.page, x: line.x, y: line.y, width: line.width, height: line.height }))

    const { lineIndices, ...rest } = q
    return {
      id: `q-${index + 1}`,
      order: index + 1,
      ...rest,
      options: Array.isArray(q.options) ? q.options : [],
      regions,
    }
  })
}
