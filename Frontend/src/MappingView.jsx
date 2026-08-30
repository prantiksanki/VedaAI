import { useMemo, useRef, useState } from 'react'
import { requestCheckedCopy, requestPlagiarismReport } from './api.js'

const MIN_PLAGIARISM_CHARS = 300

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

// Letter grade + qualitative label from a percentage, used for the score-ring summary.
function gradeFromPercent(pct) {
  if (pct >= 90) return { grade: 'A+', label: 'Outstanding' }
  if (pct >= 80) return { grade: 'A', label: 'Outstanding' }
  if (pct >= 70) return { grade: 'B', label: 'Very Good' }
  if (pct >= 60) return { grade: 'C', label: 'Good' }
  if (pct >= 50) return { grade: 'D', label: 'Satisfactory' }
  return { grade: 'F', label: 'Needs Improvement' }
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

function McqAnswerLine({ question }) {
  const student = formatChoice(question, question.selectedOption)
  const correct = formatChoice(question, question.grade?.correctAnswer)
  return (
    <>
      <McqOptions question={question} />
      <div className="qc-answer-lines">
        <p className="qc-answer-line">
          <span className="qc-answer-label">Student&rsquo;s answer:</span>{' '}
          {student ?? <em className="review-empty">No option selected</em>}
        </p>
        {correct && (
          <p className="qc-answer-line">
            <span className="qc-answer-label">Correct answer:</span> {correct}
          </p>
        )}
      </div>
    </>
  )
}

/**
 * One row in the question-wise breakdown: collapsed shows the stem + score badge;
 * expanded reveals AI reasoning (feedback + key points), the extracted/MCQ answer,
 * an editable score override, and a teacher's-comments box.
 */
function QuestionCard({ question, isExpanded, isActive, onToggle, onSelect, override, onScoreChange, onCommentChange }) {
  const grade = question.grade
  const verdict = grade ? VERDICT_META[grade.verdict] ?? VERDICT_META.ungraded : null
  const maxMarks = grade?.effectiveMaxMarks ?? question.maxMarks
  const displayScore = override?.score ?? grade?.score ?? null
  const aiSuggested = grade?.score ?? null
  const scoreEdited = aiSuggested != null && displayScore != null && displayScore !== aiSuggested
  const lowConfidence = isLowConfidence(question)

  return (
    <div className={`qc${isActive ? ' active' : ''}${lowConfidence ? ' needs-review' : ''}`}>
      <button type="button" className="qc-row" onClick={() => { onSelect(); onToggle() }}>
        <span className="qc-number">{question.displayNumber}</span>
        <span className="qc-stem">
          {question.text}
          {lowConfidence && <span className="review-chip">Review</span>}
        </span>
        {maxMarks != null && grade && (
          <span className={`qc-score-badge ${verdict?.className ?? ''}`}>
            {displayScore}/{maxMarks}
          </span>
        )}
        <svg
          className={`qc-chevron${isExpanded ? ' open' : ''}`}
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {isExpanded && (
        <div className="qc-body">
          <div className="qc-body-top">
            <div className="qc-score-edit">
              {maxMarks != null && grade ? (
                <>
                  <input
                    type="number"
                    className="qc-score-input"
                    min={0}
                    max={maxMarks}
                    value={displayScore ?? 0}
                    onChange={(e) => onScoreChange(Math.max(0, Math.min(maxMarks, Number(e.target.value))))}
                  />
                  <span className="qc-score-max">/ {maxMarks}</span>
                </>
              ) : (
                <span className="review-empty">Not graded</span>
              )}
            </div>
            {aiSuggested != null && (
              <span className="qc-ai-suggested">
                AI Suggested: {aiSuggested}
                {scoreEdited && <span className="qc-edited-tag">edited</span>}
              </span>
            )}
          </div>

          {lowConfidence && (
            <div className="qc-flag">
              {grade.confidenceReason || 'The AI was not confident about this one — please check it.'}
            </div>
          )}

          {grade?.feedback && (
            <div className="qc-reasoning">
              <h5>AI Reasoning</h5>
              <p>{grade.feedback}</p>
              {grade.keyPoints?.length > 0 && (
                <ul className="qc-keypoints">
                  {grade.keyPoints.map((kp, i) => (
                    <li key={i} className={kp.covered ? 'covered' : 'missed'}>
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
                        {kp.covered ? (
                          <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        ) : (
                          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                        )}
                      </svg>
                      {kp.point}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="qc-answer">
            <h5>{isMcq(question) ? 'Answer' : 'Extracted Answer'}</h5>
            {isMcq(question) ? (
              <McqAnswerLine question={question} />
            ) : question.answerText ? (
              <p className="answer-transcript">&ldquo;{question.answerText}&rdquo;</p>
            ) : (
              <p className="review-empty">No answer text extracted for this question.</p>
            )}
          </div>

          <div className="qc-comments">
            <h5>Teacher&rsquo;s Comments (Optional)</h5>
            <textarea
              className="qc-comments-input"
              placeholder="Add your feedback to this question..."
              value={override?.comment ?? ''}
              onChange={(e) => onCommentChange(e.target.value)}
              rows={2}
            />
          </div>
        </div>
      )}
    </div>
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

const ZOOM_STEP = 10
const ZOOM_MIN = 50
const ZOOM_MAX = 200

function AnswerSheetViewer({ answerPages, activeQuestion }) {
  const containerRef = useRef(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [zoom, setZoom] = useState(100)

  const activeRegions = useMemo(() => activeQuestion?.regions ?? [], [activeQuestion])

  const regionsByPage = useMemo(() => {
    const map = new Map()
    for (const region of activeRegions) {
      if (!map.has(region.page)) map.set(region.page, [])
      map.get(region.page).push(region)
    }
    for (const [page, regions] of map) {
      map.set(page, mergeAdjacentRegions(regions))
    }
    return map
  }, [activeRegions])

  // Jump to the first page that has a highlight whenever the selected question changes.
  // (Adjusting state during render in response to a prop change, per React's guidance,
  // instead of an effect that would cause an extra render.)
  const firstHighlightedPage = activeRegions[0]?.page
  const lastQuestionRef = useRef(activeQuestion?.id)
  if (lastQuestionRef.current !== activeQuestion?.id) {
    lastQuestionRef.current = activeQuestion?.id
    if (firstHighlightedPage != null) {
      const idx = answerPages.findIndex((p) => p.page === firstHighlightedPage)
      if (idx !== -1 && idx !== pageIndex) setPageIndex(idx)
    }
  }

  const page = answerPages[pageIndex] ?? answerPages[0]
  const pageRegions = page ? regionsByPage.get(page.page) ?? [] : []

  function goToPage(delta) {
    setPageIndex((cur) => Math.max(0, Math.min(answerPages.length - 1, cur + delta)))
  }

  if (!page) {
    return <p className="review-empty">No answer sheet pages available.</p>
  }

  return (
    <div className="asv">
      <div className="asv-toolbar">
        <div className="asv-zoom">
          <button type="button" onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))} aria-label="Zoom out">
            &minus;
          </button>
          <span>{zoom}%</span>
          <button type="button" onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))} aria-label="Zoom in">
            +
          </button>
        </div>
        <div className="asv-pager">
          <button type="button" onClick={() => goToPage(-1)} disabled={pageIndex === 0} aria-label="Previous page">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
              <path d="M10 3l-5 5 5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <span>
            Page {pageIndex + 1} of {answerPages.length}
          </span>
          <button
            type="button"
            onClick={() => goToPage(1)}
            disabled={pageIndex === answerPages.length - 1}
            aria-label="Next page"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
              <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      <div className="asv-viewport" ref={containerRef}>
        <div className="asv-page" style={{ width: `${zoom}%` }}>
          <img src={page.dataUrl} alt={`Answer sheet page ${page.page}`} className="answer-page-image" />
          {pageRegions.map((region, i) => (
            <div
              key={i}
              className="highlight-box"
              style={{
                left: `${region.x * 100}%`,
                top: `${region.y * 100}%`,
                width: `${region.width * 100}%`,
                height: `${region.height * 100}%`,
              }}
            >
              {activeQuestion && (
                <span className="highlight-tag">Q{activeQuestion.displayNumber}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Score ring (SVG) showing score/max as a proportion, colored by performance band. */
function ScoreRing({ score, max }) {
  const pct = max > 0 ? Math.round((score / max) * 100) : 0
  const radius = 42
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - pct / 100)
  const color = pct >= 80 ? '#16803c' : pct >= 50 ? '#b45309' : '#c0392b'

  return (
    <div className="score-ring">
      <svg viewBox="0 0 100 100" width="96" height="96">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="#f0eef2" strokeWidth="9" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <div className="score-ring-text">
        <strong>{score}</strong>
        <span>Out of {max}</span>
      </div>
    </div>
  )
}

export default function MappingView({ result, onReset }) {
  const [selectedQuestionId, setSelectedQuestionId] = useState(result.questions[0]?.id ?? null)
  const [expandedId, setExpandedId] = useState(result.questions[0]?.id ?? null)
  const [copyStatus, setCopyStatus] = useState('idle') // 'idle' | 'loading' | 'error'
  const [copyError, setCopyError] = useState(null)
  const [reportStatus, setReportStatus] = useState('idle') // 'idle' | 'loading' | 'error'
  const [reportError, setReportError] = useState(null)
  const [showAnswerSheet, setShowAnswerSheet] = useState(true)
  const [mobileTab, setMobileTab] = useState('questions') // 'questions' | 'answers'
  // Per-question teacher overrides: { [questionId]: { score, comment } }
  const [overrides, setOverrides] = useState({})

  const selectedQuestion = result.questions.find((q) => q.id === selectedQuestionId) ?? null
  const hasGrading = result.questions.some((q) => q.grade)

  const questionPaperText = result.questionPaperText ?? ''
  const canCheckPlagiarism = questionPaperText.trim().length >= MIN_PLAGIARISM_CHARS

  // Apply teacher score overrides on top of the AI grade, without mutating result.
  const gradedQuestions = useMemo(() => {
    return result.questions.map((q) => {
      const ov = overrides[q.id]
      if (!ov || !q.grade) return q
      return {
        ...q,
        grade: {
          ...q.grade,
          score: ov.score ?? q.grade.score,
          teacherComment: ov.comment ?? q.grade.teacherComment,
        },
      }
    })
  }, [result.questions, overrides])

  const { totalScore, totalMax, correctCount, partialCount, incorrectCount } = useMemo(() => {
    let score = 0
    let max = 0
    let correct = 0
    let partial = 0
    let incorrect = 0
    for (const q of gradedQuestions) {
      if (!q.grade) continue
      score += q.grade.score ?? 0
      max += q.grade.effectiveMaxMarks ?? q.maxMarks ?? 0
      if (q.grade.verdict === 'correct') correct++
      else if (q.grade.verdict === 'partially_correct') partial++
      else if (q.grade.verdict === 'incorrect') incorrect++
    }
    return { totalScore: score, totalMax: max, correctCount: correct, partialCount: partial, incorrectCount: incorrect }
  }, [gradedQuestions])

  const pct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0
  const { grade: letterGrade, label: gradeLabel } = gradeFromPercent(pct)

  function selectQuestion(id) {
    setSelectedQuestionId(id)
  }

  function toggleExpanded(id) {
    setExpandedId((cur) => (cur === id ? null : id))
  }

  function setOverride(id, patch) {
    setOverrides((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } }))
  }

  async function handleDownloadCheckedCopy() {
    setCopyStatus('loading')
    setCopyError(null)
    try {
      const blob = await requestCheckedCopy({ ...result, questions: gradedQuestions })
      downloadBlob(blob, 'checked-copy.pdf')
      setCopyStatus('idle')
    } catch (err) {
      setCopyError(err.message)
      setCopyStatus('error')
    }
  }

  async function handlePlagiarismCheck() {
    setReportStatus('loading')
    setReportError(null)
    try {
      const blob = await requestPlagiarismReport(questionPaperText)
      downloadBlob(blob, 'ai-content-detection-report.pdf')
      setReportStatus('idle')
    } catch (err) {
      setReportError(err.message)
      setReportStatus('error')
    }
  }

  const studentName = result.studentName || 'Student'

  return (
    <div className="mapping-view">
      <div className="eval-summary">
        <div className="eval-summary-head">
          <div>
            <h2>Evaluation Report</h2>
            <p className="eval-summary-sub">
              {studentName} - {totalScore}/{totalMax} marks
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
              {copyStatus === 'error' && copyError && <span className="checked-copy-error">{copyError}</span>}
            </div>
            <div className="plagiarism-action">
              <button
                type="button"
                className="plagiarism-btn"
                onClick={handlePlagiarismCheck}
                disabled={!canCheckPlagiarism || reportStatus === 'loading'}
              >
                {reportStatus === 'loading' ? 'Generating report…' : 'AI Plagiarism Checker'}
              </button>
              {!canCheckPlagiarism && (
                <span className="plagiarism-hint">Not enough question-paper text to analyze</span>
              )}
              {reportStatus === 'error' && reportError && <span className="plagiarism-error">{reportError}</span>}
            </div>
            <button type="button" className="reset-btn" onClick={onReset}>
              Upload New Files
            </button>
          </div>
        </div>

        {hasGrading && (
          <div className="eval-summary-card">
            <div className="eval-summary-info">
              <span className="eval-student-name">{studentName}</span>
              <span className="eval-paper-title">{result.overallFeedback ? 'Evaluation Summary' : 'Answer Sheet'}</span>
              <div className="eval-pill-row">
                <span className="eval-pill correct">✓ {correctCount} Correct</span>
                <span className="eval-pill partial">✕ {partialCount} Partial</span>
                <span className="eval-pill incorrect">✕ {incorrectCount} Incorrect</span>
              </div>
            </div>
            <div className="eval-summary-score">
              <ScoreRing score={totalScore} max={totalMax} />
              <div className="eval-grade-badge">
                <span className={`eval-grade-label grade-${letterGrade[0].toLowerCase()}`}>{gradeLabel}</span>
                <span className="eval-grade-letter">
                  {letterGrade}
                  <small>{pct}%</small>
                </span>
              </div>
            </div>
            <button type="button" className="hide-sheets-btn" onClick={() => setShowAnswerSheet((v) => !v)}>
              {showAnswerSheet ? 'Hide Answer Sheets' : 'Show Answer Sheets'}
            </button>
          </div>
        )}

        {result.overallFeedback && <div className="overall-feedback">{result.overallFeedback}</div>}
      </div>

      <div className="mobile-tabs">
        <button
          type="button"
          className={mobileTab === 'questions' ? 'active' : ''}
          onClick={() => setMobileTab('questions')}
        >
          Questions
        </button>
        <button
          type="button"
          className={mobileTab === 'answers' ? 'active' : ''}
          onClick={() => setMobileTab('answers')}
        >
          Answer Sheet
        </button>
      </div>

      <div className={`eval-grid${showAnswerSheet ? '' : ' sheets-hidden'}`}>
        <div className={`question-column${mobileTab === 'answers' ? ' mobile-hidden' : ''}`}>
          <div className="question-column-head">
            <h4>Question-wise Breakdown</h4>
            <button
              type="button"
              className="expand-all-btn"
              onClick={() =>
                setExpandedId((cur) => (cur ? null : gradedQuestions[0]?.id ?? null))
              }
            >
              {expandedId ? 'Collapse All' : 'Expand All'}
            </button>
          </div>
          <div className="question-list">
            {gradedQuestions.map((q) => (
              <QuestionCard
                key={q.id}
                question={q}
                isActive={selectedQuestionId === q.id}
                isExpanded={expandedId === q.id}
                onToggle={() => toggleExpanded(q.id)}
                onSelect={() => selectQuestion(q.id)}
                override={overrides[q.id]}
                onScoreChange={(score) => setOverride(q.id, { score })}
                onCommentChange={(comment) => setOverride(q.id, { comment })}
              />
            ))}
          </div>
        </div>

        {showAnswerSheet && (
          <div className={`answer-column${mobileTab === 'questions' ? ' mobile-hidden' : ''}`}>
            <div className="answer-column-head">
              <h4>Answer Sheet</h4>
            </div>
            <AnswerSheetViewer answerPages={result.answerPages} activeQuestion={selectedQuestion} />
          </div>
        )}
      </div>
    </div>
  )
}
