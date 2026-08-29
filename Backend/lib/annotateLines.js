import sharp from 'sharp'

/**
 * Draws a small numbered marker at the left of every detected line, so a vision
 * model can literally read the line index off the image instead of guessing
 * coordinates. Returns a new JPEG data URL - the original page image is untouched.
 *
 * @param {string} dataUrl - original page "data:image/jpeg;base64,..."
 * @param {{ width:number, height:number }} pagePx
 * @param {Array<{index:number,x:number,y:number,width:number,height:number}>} lines
 */
export async function annotateLines(dataUrl, pagePx, lines) {
  if (!lines.length) return dataUrl

  const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
  const fontSize = Math.max(14, Math.round(pagePx.height * 0.011))
  const markerW = fontSize * 1.8

  const markers = lines
    .map((l) => {
      const cy = (l.y + l.height / 2) * pagePx.height
      const x = Math.max(0, l.x * pagePx.width - markerW - 4)
      return `
        <rect x="${x}" y="${cy - fontSize / 2 - 2}" width="${markerW}" height="${fontSize + 4}" rx="3" fill="#ff2d55" fill-opacity="0.85"/>
        <text x="${x + markerW / 2}" y="${cy + fontSize / 3}" font-size="${fontSize}" font-family="monospace" font-weight="bold" fill="white" text-anchor="middle">${l.index}</text>
        <rect x="${l.x * pagePx.width}" y="${l.y * pagePx.height}" width="${l.width * pagePx.width}" height="${l.height * pagePx.height}" fill="none" stroke="#ff2d55" stroke-width="1" stroke-opacity="0.5"/>
      `
    })
    .join('')

  const svg = `<svg width="${pagePx.width}" height="${pagePx.height}" xmlns="http://www.w3.org/2000/svg">${markers}</svg>`

  const out = await sharp(buf)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer()

  return `data:image/jpeg;base64,${out.toString('base64')}`
}
