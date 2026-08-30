# OCR Service (line geometry only)

A small FastAPI sidecar that runs [Tesseract](https://github.com/tesseract-ocr/tesseract) in detection mode (its recognized text is discarded, only word bounding boxes are used) to find precise text-line bounding boxes on a scanned answer sheet.

Reading and transcribing the actual handwriting is done by a vision LLM (GPT-4o) in the Node backend directly from the page images — that is far more accurate than any OCR text-recognition model on messy handwriting, math notation, or non-Latin scripts. This service exists only to give the LLM **pixel-precise locations**: the backend overlays the detected line boxes as numbered markers on the image (`Backend/lib/annotateLines.js`), and the LLM reports which numbered lines belong to which answer instead of guessing coordinates — a discrete pick, not coordinate regression, which is much more reliable.

Tesseract was chosen over a PyTorch-based detector (docTR) specifically because it has no ML runtime overhead — it fits comfortably in small deploy environments (e.g. Render's free tier), which matters because this service only needs to find *where* text is, not read it, so a heavier/more accurate text-recognition model buys nothing here.

## Setup

Requires the `tesseract-ocr` system binary in addition to the Python packages in `requirements.txt`.

```powershell
# Windows: install Tesseract (e.g. https://github.com/UB-Mannheim/tesseract/wiki), then:
py -3.11 -m venv venv
.\venv\Scripts\pip install -r requirements.txt
```

On Linux/Docker: `apt-get install tesseract-ocr` (see `Dockerfile`).

## Run

```powershell
.\venv\Scripts\python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

### Deploying (Render)

This service ships a `Dockerfile` so Render can install the `tesseract-ocr` system package, which isn't available on Render's native Python runtime. Set the service's Runtime to **Docker**.

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
