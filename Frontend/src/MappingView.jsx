import { useMemo, useRef, useState } from 'react'
import { requestCheckedCopy } from './api.js'

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

const STATUS_META = {
  answered: { label: 'Answered', className: 'status-answered' },
  unanswered: { label: 'Unanswered', className: 'status-unanswered' },
}

const VERDICT_META = {
  correct: { label: 'Correct', className: 'verdict-correct' },
  partially_correct: { label: 'Partial', className: 'verdict-partial' },
  incorrect: { label: 'Incorrect', className: 'verdict-incorrect' },
  unanswered: { label: 'Unanswered', className: 'verdict-unanswered' },
  ungraded: { label: 'Not graded', className: 'verdict-unanswered' },
}

function isLowConfidence(question) {
  return question.grade?.confidence === 'low'
}

function isMcq(question) {
  return question.questionType === 'mcq' || question.questionType === 'assertion_reason'
}

function normalizeLetter(value) {
  if (value == null) return null
  const s = String(value).trim().toLowerCase()
  return s ? s.replace(/[^a-z0-9]/g, '') : null
}

// Renders the MCQ choice list, marking the student's pick and (once graded) the correct one.
function McqOptions({ question }) {
  const options = question.options ?? []
  if (!options.length) return null
  const selected = normalizeLetter(question.selectedOption)
  const correct = normalizeLetter(question.grade?.correctAnswer)

  return (
    <ul className="mcq-options">
      {options.map((opt) => {
        const label = normalizeLetter(opt.label)
        const isSelected = selected != null && label === selected
        const isCorrect = correct != null && label === correct
        const cls = ['mcq-option', isSelected && 'selected', isCorrect && 'correct'].filter(Boolean).join(' ')
        return (
          <li key={opt.label} className={cls}>
            <span className="mcq-option-label">{opt.label}</span>
            <span className="mcq-option-text">{opt.text}</span>
            {isSelected && <span className="mcq-tag">Chosen</span>}
            {isCorrect && !isSelected && <span className="mcq-tag mcq-tag-correct">Correct</span>}
          </li>
        )
      })}
    </ul>
  )
}

function QuestionListItem({ question, isActive, onClick }) {
  const status = STATUS_META[question.status] ?? STATUS_META.unanswered
  const verdict = question.grade ? VERDICT_META[question.grade.verdict] : null
  const maxMarks = question.grade?.effectiveMaxMarks ?? question.maxMarks

  const lowConfidence = isLowConfidence(question)

  return (
    <button
      type="button"
      className={`question-item${isActive ? ' active' : ''}${lowConfidence ? ' needs-review' : ''}`}
      onClick={onClick}
    >
      <div className="question-item-top">
        <span className="question-number">Q{question.displayNumber}</span>
        {lowConfidence && <span className="review-chip">Review</span>}
        <span className={`status-pill ${status.className}`}>{status.label}</span>
      </div>
      <p className="question-text">{question.text}</p>
      {isMcq(question) && <McqOptions question={question} />}
      <div className="question-item-bottom">
        {maxMarks != null && <span className="marks-tag">{maxMarks} marks</span>}
        {verdict && (
          <span className={`verdict-pill ${verdict.className}`}>
            {verdict.label}
            {question.grade.score != null && ` · ${question.grade.score}${maxMarks != null ? `/${maxMarks}` : ''}`}
          </span>
        )}
      </div>
    </button>
  )
}

// Merges regions that form a contiguous block (vertically stacked lines with
// overlapping or near-touching x-ranges) into one bounding box, so a multi-line
// answer draws as a single continuous highlight instead of one box per line.
function mergeAdjacentRegions(regions) {
  if (regions.length <= 1) return regions

  const sorted = [...regions].sort((a, b) => a.y - b.y)
  const groups = []

  for (const region of sorted) {
    const target = groups.find((group) =>
      group.some((member) => {
        const verticalGap = region.y - (member.y + member.height)
        const closeVertically = verticalGap <= Math.max(region.height, member.height) * 0.9
        const horizontallyOverlaps =
          region.x < member.x + member.width && member.x < region.x + region.width
        const bothWide = region.width > 0.5 || member.width > 0.5
        return closeVertically && (horizontallyOverlaps || bothWide)
      })
    )
    if (target) {
      target.push(region)
    } else {
      groups.push([region])
    }
  }

  return groups.map((group) => {
    const x0 = Math.min(...group.map((r) => r.x))
    const y0 = Math.min(...group.map((r) => r.y))
    const x1 = Math.max(...group.map((r) => r.x + r.width))
    const y1 = Math.max(...group.map((r) => r.y + r.height))
    return { page: group[0].page, x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  })
}

function AnswerSheetViewer({ answerPages, activeRegions }) {
  const containerRefs = useRef({})

  const regionsByPage = useMemo(() => {
    const map = new Map()
    for (const region of activeRegions ?? []) {
      if (!map.has(region.page)) map.set(region.page, [])
      map.get(region.page).push(region)
    }
    for (const [page, regions] of map) {
      map.set(page, mergeAdjacentRegions(regions))
    }
    return map
  }, [activeRegions])

  return (
    <div className="answer-sheet-viewer">
      {answerPages.map((page) => (
        <div
          key={page.page}
          className="answer-page"
          ref={(el) => {
            containerRefs.current[page.page] = el
          }}
        >
          <img src={page.dataUrl} alt={`Answer sheet page ${page.page}`} className="answer-page-image" />
          {(regionsByPage.get(page.page) ?? []).map((region, i) => (
            <div
              key={i}
              className="highlight-box"
              style={{
                left: `${region.x * 100}%`,
                top: `${region.y * 100}%`,
                width: `${region.width * 100}%`,
                height: `${region.height * 100}%`,
              }}
            />
          ))}
          <span className="answer-page-label">Page {page.page}</span>
        </div>
      ))}
    </div>
  )
}

function ReviewPanel({ question }) {
  if (!question) {
    return (
      <div className="review-panel">
        <p className="review-empty">Select a question to see its review.</p>
      </div>
    )
  }

  return (
    <div className="review-panel">
      <div className="review-header">
        <span className="question-number">Q{question.displayNumber}</span>
        {question.status === 'unanswered' ? (
          <span className="status-pill status-unanswered">Not answered on sheet</span>
        ) : (
          <span className="status-pill status-answered">Answered</span>
        )}
      </div>

      {isLowConfidence(question) && (
        <div className="review-section review-flag">
          <h4 className="review-section-title">Flagged for review</h4>
          <p className="answer-feedback">
            {question.grade.confidenceReason || 'The AI was not confident about this one — please check it.'}
          </p>
        </div>
      )}

      {question.grade?.feedback && (
        <div className="review-section">
          <h4 className="review-section-title">AI Feedback</h4>
          <p className="answer-feedback">{question.grade.feedback}</p>
        </div>
      )}

      {isMcq(question) ? (
        <McqReview question={question} />
      ) : (
        <div className="review-section">
          <h4 className="review-section-title">Extracted Answer</h4>
          {question.answerText ? (
            <p className="answer-transcript">&ldquo;{question.answerText}&rdquo;</p>
          ) : (
            <p className="review-empty">No answer text extracted for this question.</p>
          )}
        </div>
      )}
    </div>
  )
}

function findOption(question, letter) {
  const norm = normalizeLetter(letter)
  if (norm == null) return null
  return (question.options ?? []).find((o) => normalizeLetter(o.label) === norm) ?? null
}

function formatChoice(question, letter) {
  const opt = findOption(question, letter)
  if (opt) return `(${opt.label}) ${opt.text}`
  return letter ? `(${letter})` : null
}

function McqReview({ question }) {
  const student = formatChoice(question, question.selectedOption)
  const correct = formatChoice(question, question.grade?.correctAnswer)

  return (
    <>
      <div className="review-section">
        <h4 className="review-section-title">Options</h4>
        <McqOptions question={question} />
      </div>
      <div className="review-section">
        <h4 className="review-section-title">Student&rsquo;s Answer</h4>
        {student ? (
          <p className="answer-transcript">{student}</p>
        ) : (
          <p className="review-empty">No option selected on the sheet.</p>
        )}
      </div>
      {correct && (
        <div className="review-section">
          <h4 className="review-section-title">Correct Answer</h4>
          <p className="answer-transcript">{correct}</p>
        </div>
      )}
    </>
  )
}

export default function MappingView({ result, onReset }) {
  const [selectedQuestionId, setSelectedQuestionId] = useState(result.questions[0]?.id ?? null)
  const [copyStatus, setCopyStatus] = useState('idle') // 'idle' | 'loading' | 'error'
  const [copyError, setCopyError] = useState(null)

  const selectedQuestion = result.questions.find((q) => q.id === selectedQuestionId) ?? null

  const activeRegions = selectedQuestion?.regions ?? []

  const answeredCount = result.questions.filter((q) => q.status === 'answered').length
  const hasGrading = result.questions.some((q) => q.grade)
  const reviewCount = result.questions.filter(isLowConfidence).length

  // Low-confidence questions first (stable within each group by original order).
  const orderedQuestions = useMemo(() => {
    return result.questions
      .map((q, i) => ({ q, i }))
      .sort((a, b) => (isLowConfidence(b.q) ? 1 : 0) - (isLowConfidence(a.q) ? 1 : 0) || a.i - b.i)
      .map(({ q }) => q)
  }, [result.questions])

  function selectQuestion(id) {
    setSelectedQuestionId(id)
  }

  async function handleDownloadCheckedCopy() {
    setCopyStatus('loading')
    setCopyError(null)
    try {
      const blob = await requestCheckedCopy(result)
      downloadBlob(blob, 'checked-copy.pdf')
      setCopyStatus('idle')
    } catch (err) {
      setCopyError(err.message)
      setCopyStatus('error')
    }
  }

  return (
    <div className="mapping-view">
      <div className="mapping-header">
        <div>
          <h2>Question &amp; Answer Mapping</h2>
          <p className="mapping-summary">
            {answeredCount} of {result.questions.length} questions answered
          </p>
        </div>
        <div className="mapping-header-actions">
          <div className="checked-copy-action">
            <button
              type="button"
              className="checked-copy-btn"
              onClick={handleDownloadCheckedCopy}
              disabled={!hasGrading || copyStatus === 'loading'}
            >
              {copyStatus === 'loading' ? 'Preparing…' : 'Download Checked Copy'}
            </button>
            {!hasGrading && <span className="checked-copy-hint">Grading unavailable</span>}
            {copyStatus === 'error' && copyError && (
              <span className="checked-copy-error">{copyError}</span>
            )}
          </div>
          <button type="button" className="reset-btn" onClick={onReset}>
            Upload New Files
          </button>
        </div>
      </div>

      {reviewCount > 0 && (
        <div className="review-banner">
          {reviewCount} question{reviewCount > 1 ? 's' : ''} flagged for your review — check the ones marked{' '}
          <span className="review-chip">Review</span> below.
        </div>
      )}

      {result.overallFeedback && (
        <div className="overall-feedback">
          <strong>Overall Feedback:</strong> {result.overallFeedback}
        </div>
      )}

      <div className="mapping-grid">
        <div className="question-panel">
          {orderedQuestions.map((q) => (
            <QuestionListItem
              key={q.id}
              question={q}
              isActive={selectedQuestionId === q.id}
              onClick={() => selectQuestion(q.id)}
            />
          ))}
        </div>

        <div className="answer-panel">
          <AnswerSheetViewer answerPages={result.answerPages} activeRegions={activeRegions} />
        </div>

        <ReviewPanel question={selectedQuestion} />
      </div>
    </div>
  )
}
