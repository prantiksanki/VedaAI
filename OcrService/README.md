# OCR Service

A small FastAPI sidecar that runs [docTR](https://github.com/mindee/doctr) locally to OCR question papers and answer sheets: it rasterizes PDF/image uploads to page images, runs text detection + recognition to get every line of text with a normalized bounding box, and returns both the OCR data and the page images (as base64 JPEG) in one response.

The Node backend calls this service instead of sending page images to an LLM vision model. Bounding boxes for highlighting come from OCR geometry (deterministic, fast) rather than an LLM guessing coordinates from an image.

Two recognition models are loaded, routed by document type (see `doc_type` below):
- **printed** (question papers): `db_mobilenet_v3_large` + `crnn_mobilenet_v3_small` - fast, accurate enough for clean typed/printed text.
- **handwritten** (answer sheets): `db_resnet50` + `parseq` - docTR's strongest architectures, needed for messier, more varied handwriting. Slower per page and downloads larger weights on first run, but meaningfully more accurate on handwriting than the small models.

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

First startup will be slow (a few minutes) while docTR downloads both models' weights. Subsequent requests are fast (typically under 1-2s per page on CPU for printed, a bit more for handwritten).

## API

`GET /health` -> `{"ok": true}`

`POST /ocr` (multipart, field `file`: a PDF or image; field `doc_type`: `"printed"` or `"handwritten"`, defaults to `"printed"`) ->
```json
{
  "pages": [
    {
      "page": 1,
      "width": 1420,
      "height": 2000,
      "dataUrl": "data:image/jpeg;base64,...",
      "lines": [
        { "text": "1. Define Newton's second law.", "x": 0.08, "y": 0.05, "width": 0.6, "height": 0.02 }
      ]
    }
  ]
}
```
`x`, `y`, `width`, `height` are normalized 0-1 fractions of the page, in top-to-bottom reading order (assumes single-column layout).

## Backend integration

The Node backend reads `OCR_SERVICE_URL` (default `http://localhost:8000`) from its `.env` and calls this service via `Backend/lib/ocrClient.js`.
