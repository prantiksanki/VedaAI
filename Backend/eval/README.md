# Grading eval harness

Runs the real pipeline (`rasterize → extractQuestions → extractAndMapAnswers → gradeAnswers`)
against fixtures where a teacher's marks are known, and reports how close we get.

## Run

```
cd Backend
npm run eval                 # all fixtures
npm run eval -- maths-10cbse  # one fixture (folder name)
```

Needs `OPENAI_API_KEY` in `Backend/.env`. Every run costs real API money
(roughly one exam's worth of vision calls per fixture).

## Add a fixture

Create `eval/fixtures/<name>/` with:

```
<name>/
  questions.pdf          the question paper (PDF, or questions.jpg / a questions/ folder of images)
  answers.pdf            one student's answer sheet (same formats)
  expected.json          the teacher's actual marking, see shape below
```

`expected.json`:

```json
{
  "paperTotal": 40,
  "questions": [
    {
      "displayNumber": "1",
      "maxMarks": 1,
      "answered": true,
      "expectedScore": 1,
      "expectedVerdict": "correct"
    },
    {
      "displayNumber": "11",
      "maxMarks": 2,
      "answered": true,
      "expectedScore": 1,
      "expectedVerdict": "partially_correct"
    }
  ],
  "notes": "optional free text"
}
```

Match questions by `displayNumber` (the harness canonicalizes labels the same way the
pipeline does). Include every question on the paper, answered or not.

## What it reports

Per fixture and aggregate:

- **question recall / precision** — did we find the right set of questions?
- **mapping recall** — of questions the teacher marked *answered*, how many did we mark answered?
- **score MAE** — mean |our score − teacher score| per question
- **within-1-mark rate** — fraction of questions scored within 1 mark of the teacher
- **verdict agreement** — fraction with the same verdict
- **total-score error** — |our total − teacher total|, absolute and as % of `paperTotal`

Exits non-zero if the aggregate within-1-mark rate is below `MIN_WITHIN_1` (see the script).
