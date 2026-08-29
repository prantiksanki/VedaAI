# OCR Service (line geometry only)

A small FastAPI sidecar that runs [docTR](https://github.com/mindee/doctr)'s text **detection** model (no recognition/reading) to find precise text-line bounding boxes on a scanned answer sheet.

Reading and transcribing the actual handwriting is done by a vision LLM (GPT-4o) in the Node backend directly from the page images — that is far more accurate than any OCR text-recognition model on messy handwriting, math notation, or non-Latin scripts. This service exists only to give the LLM **pixel-precise locations**: the backend overlays the detected line boxes as numbered markers on the image (`Backend/lib/annotateLines.js`), and the LLM reports which numbered lines belong to which answer instead of guessing coordinates — a discrete pick, not coordinate regression, which is much more reliable.

Uses `db_resnet50`, docTR's strongest detector, which handles both printed and handwritten strokes well since it only needs to find *where* text is, not read it.

## Setup

Requires Python 3.10 or 3.11 (docTR's PyTorch backend wheels aren't published for 3.13 yet on all platforms).

```powershell
py -3.10 -m venv venv
.\venv\Scripts\pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
```

## Run

```powershell
.\venv\Scripts\python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

First startup will be slow (a minute or so) while docTR downloads the detector weights. Subsequent requests are fast — detection-only is quicker than the old full OCR (detection + recognition) pipeline.

This service is **optional**: if it's not running, the backend still works — question extraction, answer reading, and grading all happen via the vision LLM regardless. You just won't get answer-highlight boxes on the results screen.

## API

`GET /health` -> `{"ok": true}`

`POST /detect-lines` (multipart, field `file`: a PDF or image) ->
```json
{
  "pages": [
    {
      "page": 1,
      "width": 1420,
      "height": 2000,
      "dataUrl": "data:image/jpeg;base64,...",
      "lines": [
        { "index": 0, "x": 0.08, "y": 0.05, "width": 0.6, "height": 0.02 }
      ]
    }
  ]
}
```
`x`, `y`, `width`, `height` are normalized 0-1 fractions of the page. `index` numbers lines in reading order (top-to-bottom, then left-to-right within a row — assumes single-column layout). No `text` field: this service never reads content.

## Backend integration

The Node backend reads `OCR_SERVICE_URL` (default `http://localhost:8000`) from its `.env` and calls this service via `Backend/lib/lineGeometry.js`, only for the answer sheet (the question paper doesn't need highlight boxes).
