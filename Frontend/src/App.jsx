import { useRef, useState } from 'react'
import { Lottie } from 'lottie-react'
import './App.css'
import MappingView from './MappingView.jsx'
import { uploadFiles, pollJob, PROCESSING_STEPS } from './api.js'

const NAV_ITEMS = [
  { key: 'home', label: 'Home', icon: 'grid' },
  { key: 'classroom', label: 'My Classroom', icon: 'classroom' },
  { key: 'assignments', label: 'Assignments', icon: 'file' },
  { key: 'exams', label: 'Exams', icon: 'clipboard' },
  { key: 'library', label: 'My Library', icon: 'clock' },
]

function NavIcon({ name }) {
  switch (name) {
    case 'grid':
      return (
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
          <rect x="2.5" y="2.5" width="6" height="6" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
          <rect x="11.5" y="2.5" width="6" height="6" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
          <rect x="2.5" y="11.5" width="6" height="6" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
          <rect x="11.5" y="11.5" width="6" height="6" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      )
    case 'classroom':
      return (
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
          <rect x="2.5" y="3.5" width="15" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M7 16.5h6M10 13.5v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )
    case 'file':
      return (
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
          <path d="M5 2.5h6.5L15 6v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M11 2.5V6h4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M6.5 10h5M6.5 12.8h5M6.5 15.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )
    case 'clipboard':
      return (
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
          <rect x="4" y="3.5" width="12" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <rect x="7" y="2" width="6" height="3" rx="1" stroke="currentColor" strokeWidth="1.4" />
          <path d="M7 10h6M7 13h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )
    case 'clock':
      return (
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10 6v4l2.5 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'settings':
      return (
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M10 2.8v1.6M10 15.6v1.6M17.2 10h-1.6M4.4 10H2.8M14.9 5.1l-1.1 1.1M6.2 13.7l-1.1 1.1M14.9 14.9l-1.1-1.1M6.2 6.2 5.1 5.1"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      )
    default:
      return null
  }
}

function UploadCard({ label, highlight, hint, file, onFileSelect }) {
  const inputRef = useRef(null)

  return (
    <div
      className={`upload-card${file ? ' has-file' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg"
        hidden
        onChange={(e) => onFileSelect(e.target.files?.[0] ?? null)}
      />
      <div className="upload-icon">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
          <path
            d="M12 15.5V4M12 4 7.5 8.5M12 4l4.5 4.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
      <p className="upload-title">
        Upload <span className="highlight">{highlight}</span>
      </p>
      <p className="upload-hint">{file ? file.name : hint}</p>
    </div>
  )
}

function LiveStatus({ currentStep }) {
  const index = PROCESSING_STEPS.findIndex((s) => s.key === currentStep)
  const step = index === -1 ? PROCESSING_STEPS[0] : PROCESSING_STEPS[index]
  const progressPercent = index === -1 ? 0 : ((index + 1) / PROCESSING_STEPS.length) * 100

  return (
    <div className="live-status">
      <div className="live-status-line">
        <span className="live-status-spinner" aria-hidden="true" />
        <span className="live-status-label">{step.label}&hellip;</span>
      </div>
      <div className="live-status-track" role="progressbar" aria-valuenow={Math.round(progressPercent)} aria-valuemin={0} aria-valuemax={100}>
        <div className="live-status-fill" style={{ width: `${progressPercent}%` }} />
      </div>
    </div>
  )
}

function App() {
  const [activeNav, setActiveNav] = useState('exams')
  const [questionPaper, setQuestionPaper] = useState(null)
  const [answerSheet, setAnswerSheet] = useState(null)
  const [stage, setStage] = useState('upload') // 'upload' | 'processing' | 'results'
  const [processingStep, setProcessingStep] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const canStartMapping = Boolean(questionPaper && answerSheet)

  async function handleStartMapping() {
    setError(null)
    setStage('processing')
    setProcessingStep('uploading')
    try {
      const { jobId } = await uploadFiles(questionPaper, answerSheet)
      const job = await pollJob(jobId, (job) => setProcessingStep(job.step))
      if (job.status === 'error') {
        throw new Error(job.error || 'Processing failed')
      }
      setResult(job.result)
      setStage('results')
    } catch (err) {
      setError(err.message)
      setStage('upload')
    }
  }

  function handleReset() {
    setQuestionPaper(null)
    setAnswerSheet(null)
    setResult(null)
    setError(null)
    setStage('upload')
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand">
            <img src="/logo.avif" className="brand-mark" alt="" width="30" height="30" />
            <img src="/text.png" className="brand-name" alt="VedaAI" height="20" />
          </div>
          <button type="button" className="collapse-btn" aria-label="Collapse sidebar">
            <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" strokeWidth="1.3" />
              <path d="M8 3.5v13" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
        </div>

        <button type="button" className="toolkit-pill">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M8 0 9.4 5.9 15 8l-5.6 2.1L8 16l-1.4-5.9L1 8l5.6-2.1L8 0Z" />
          </svg>
          AI Teacher&apos;s Toolkit
        </button>

        <nav className="nav-list">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`nav-item${activeNav === item.key ? ' active' : ''}`}
              onClick={() => setActiveNav(item.key)}
            >
              <NavIcon name={item.icon} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button type="button" className="nav-item settings-item">
            <NavIcon name="settings" />
            Settings
          </button>

          <div className="school-card">
            <div className="school-logo" aria-hidden="true">
              🏫
            </div>
            <div className="school-info">
              <span className="school-name">Delhi Public School</span>
              <span className="school-location">Bokaro Steel City</span>
            </div>
          </div>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <button type="button" className="back-btn" aria-label="Go back">
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
              <path d="M12.5 15 7.5 10l5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" className="crumb-icon" aria-hidden="true">
            <path d="M6 2.5h6L15 5.5v10a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 5 15.5v-11A1.5 1.5 0 0 1 6.5 3Z" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          <span className="crumb-text">Exams</span>

          <div className="topbar-actions">
            <button type="button" className="icon-btn" aria-label="Help">
              <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
                <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.4" />
                <path d="M7.8 7.8a2.2 2.2 0 1 1 3.2 1.96c-.7.4-1 .7-1 1.44v.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <circle cx="10" cy="14" r="0.9" fill="currentColor" />
              </svg>
            </button>
            <button type="button" className="icon-btn has-dot" aria-label="Notifications">
              <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
                <path
                  d="M10 2.5a4 4 0 0 0-4 4v2.4c0 .5-.2 1-.5 1.4l-1 1.3c-.6.8 0 1.9 1 1.9h9a1.2 1.2 0 0 0 1-1.9l-1-1.3a2.3 2.3 0 0 1-.5-1.4V6.5a4 4 0 0 0-4-4Z"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
                <path d="M8.3 16a1.8 1.8 0 0 0 3.4 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
            <button type="button" className="icon-btn sparkle-btn" aria-label="AI assistant">
              <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true">
                <path d="M10 2 11.6 8.4 18 10l-6.4 1.6L10 18l-1.6-6.4L2 10l6.4-1.6L10 2Z" />
              </svg>
            </button>
            <div className="user-chip">
              <span className="user-avatar" aria-hidden="true">
                👤
              </span>
              <span className="user-name">Madhur Rastogi</span>
              <svg viewBox="0 0 12 8" width="10" height="7" fill="none" aria-hidden="true">
                <path d="M1 1.5 6 6.5l5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
        </header>

        <main className="content">
          {stage === 'results' && result ? (
            <MappingView result={result} onReset={handleReset} />
          ) : (
            <div className="content-card">
              {stage === 'processing' ? (
                <>
                  <div className="page-heading">
                    <h1>
                      Processing{' '}
                      <span className="heading-highlight">Question Paper &amp; Answer Sheet</span>
                    </h1>
                  </div>
                  <p className="page-subheading">This may take a minute, please don&apos;t close the tab</p>

                  <div className="mascot" aria-hidden="true">
                    <span className="mascot-ring">
                      <Lottie src="/generating.json" autoplay loop className="mascot-lottie" />
                    </span>
                  </div>

                  <LiveStatus currentStep={processingStep} />
                </>
              ) : (
                <>
                  <div className="page-heading">
                    <h1>
                      Upload{' '}
                      <span className="heading-highlight">
                        Question Paper &amp; Answer Sheets
                      </span>
                    </h1>
                    <span className="assignee-tag">Vishal Lodhi</span>
                  </div>
                  <p className="page-subheading">Upload both files to get started</p>

                  <div className="mascot" aria-hidden="true">
                    <span className="mascot-ring">
                      <Lottie src="/Teaching.json" autoplay loop className="mascot-lottie" />
                    </span>
                  </div>

                  {error && <p className="upload-error">{error}</p>}

                  <div className="upload-grid">
                    <UploadCard
                      highlight="Question Paper"
                      hint="Max 500MB"
                      file={questionPaper}
                      onFileSelect={setQuestionPaper}
                    />
                    <UploadCard
                      highlight="Answer Sheet"
                      hint="Max 500MB"
                      file={answerSheet}
                      onFileSelect={setAnswerSheet}
                    />
                  </div>

                  <button
                    type="button"
                    className="start-mapping-btn"
                    disabled={!canStartMapping}
                    onClick={handleStartMapping}
                  >
                    Start Mapping
                    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
                      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <p className="mapping-note">Once both files are uploaded, you&apos;ll able to map answers with questions</p>
                </>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

export default App





