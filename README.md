# VedaAI

VedaAI grades handwritten exam answer sheets against a printed question paper using
vision-capable LLMs — no manual marking, no fragile OCR-then-text pipeline. A teacher
uploads a question paper and a student's answer sheet (PDF or photos); VedaAI extracts
the questions, reads and locates each answer directly from the page images, grades
every question with per-question reasoning, and hands back an evaluation report the
teacher can review, adjust, and export as a checked copy.

## Why vision, not OCR

Traditional OCR text-recognition models are trained on printed/scene text, not
handwriting — on real answer sheets they produce heavily garbled output, especially
for math notation and non-Latin scripts, and everything downstream inherits that
noise. VedaAI instead sends page images straight to a vision LLM (GPT-4o) to read and
grade, and uses a small local model only for **geometry** — precise line-position
detection, never text reading — so that answer highlight boxes land pixel-accurately
without reintroducing OCR's accuracy ceiling.

## How it works

```
Question Paper (PDF/image)         Answer Sheet (PDF/image)
        │                                    │
        ▼                                    ▼
   rasterize (pdfjs-dist)              rasterize (pdfjs-dist)
        │                                    │
        ▼                                    ├──► line-geometry detection (OcrService, optional)
 extract questions (GPT-4o vision)           │        — position only, never reads text
        │                                    ▼
        └──────────────► read & map answers to questions (GPT-4o vision)
                                    — transcribes each answer, locates it via numbered
                                      line markers instead of guessing coordinates
                                    │
                                    ▼
                          grade every question (GPT-4o vision, batched by page)
                          — step-by-step reasoning before scoring, self-consistency
                            re-check on low-confidence answers
                                    │
                                    ▼
                          Evaluation Report (React UI)
                          — score ring, question-wise breakdown, AI reasoning,
                            teacher score overrides, checked-copy PDF export,
                            AI plagiarism check on the question paper
```

## Project layout

| Directory | Stack | Role |
|---|---|---|
| [`Backend/`](Backend) | Node.js (Express, ESM) | Upload handling, the grading pipeline, PDF report generation |
| [`Frontend/`](Frontend) | React + Vite | Upload flow and the evaluation report UI |
| [`OcrService/`](OcrService) | Python (FastAPI + docTR) | Optional sidecar: detects text-line positions for highlight boxes only |

## Getting started

### 1. Backend

```bash
cd Backend
npm install
cp .env.example .env   # add your OPENAI_API_KEY
npm run dev             # http://localhost:4000
```

Required environment variables (see [`Backend/.env.example`](Backend/.env.example)):

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Powers the whole grading pipeline (vision reading + grading) |
| `OPENAI_VISION_MODEL` | Default `gpt-4o` |
| `OPENAI_FAST_MODEL` | Default `gpt-4o-mini`, reserved for cheap sub-calls |
| `PORT` | Default `4000` |
| `FRONTEND_ORIGIN` | CORS origin, default `http://localhost:5173` |
| `OCR_SERVICE_URL` | Optional; the pipeline runs fine without it, just without highlight boxes |
| `WISTON_AI` | Optional; enables the AI content-detection (plagiarism) report on the question paper |

### 2. Frontend

```bash
cd Frontend
npm install
npm run dev              # http://localhost:5173
```

### 3. OCR geometry sidecar (optional but recommended)

Provides pixel-precise answer-highlight boxes. The grading pipeline works without it —
you just lose the highlight overlay on the answer sheet viewer.

```bash
cd OcrService
py -3.10 -m venv venv
.\venv\Scripts\pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
.\venv\Scripts\python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

See [`OcrService/README.md`](OcrService/README.md) for details on why this service
only detects line positions and never reads text.

With all three running, open `http://localhost:5173`, upload a question paper and an
answer sheet, and the app will walk through rasterizing, extracting questions, mapping
answers, and grading.

## API

| Endpoint | Description |
|---|---|
| `POST /api/upload` | Accepts `questionPaper` + `answerSheet` files, returns `{ jobId }` and starts grading in the background |
| `GET /api/jobs/:id` | Poll for job status/result |
| `POST /api/checked-copy` | Given a graded result, streams back a checked-copy PDF (summary + annotated pages) |
| `POST /api/plagiarism-report` | Given question-paper text, streams back an AI-content-detection PDF (requires `WISTON_AI`) |

## Accuracy evaluation

`Backend/eval/` is a harness for measuring grading accuracy against real, teacher-marked
fixtures — question recall, mapping recall, score MAE, within-1-mark rate, and verdict
agreement. See [`Backend/eval/README.md`](Backend/eval/README.md) for how to add a
fixture and run it:

```bash
cd Backend
npm run eval
```

## Design notes worth knowing

- **Stable question IDs.** Questions are identified by a slug derived from their
  printed label (`q-11`, `q-11a`), not by extraction order — so a miscount or reorder
  in one pass can't silently misalign answers and grades from another.
- **Batched grading.** Grading requests are grouped by answer-sheet page, not issued
  one per question, to stay well within LLM rate limits on longer papers.
- **Confidence flags.** Low-confidence questions (illegible writing, borderline
  scores, self-consistency disagreement) are surfaced to the teacher for review rather
  than silently trusted.
- **Teacher overrides are non-destructive.** Score and comment edits made in the UI
  are layered on top of the AI grade and flow through to the checked-copy export
  without mutating the original graded result.
