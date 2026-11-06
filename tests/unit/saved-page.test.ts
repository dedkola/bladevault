import { describe, expect, it } from 'vitest'
import {
  findSavedPageUrl,
  hasProductMarkup,
  isSavedPageLocalImage,
  parseSavedPage,
} from '@/lib/saved-page'

const pageUrl = 'https://www.buckknives.com/product/110-folding-hunter-knife/'

describe('saved page import parsing', () => {
  it('reads a "Webpage, Complete" HTML save and its saved-from address', () => {
    const html = `<!DOCTYPE html>
<!-- saved from url=(0061)${pageUrl} -->
<html><head><title>110 Folding Hunter</title></head><body><h1>110</h1></body></html>`
    const page = parseSavedPage('110.html', html)
    expect(page.html).toBe(html)
    expect(findSavedPageUrl(page.html)).toBe(pageUrl)
  })

  it('falls back to canonical and Open Graph addresses', () => {
    expect(
      findSavedPageUrl(
        `<html><head><link href="${pageUrl}" rel="canonical"></head></html>`,
      ),
    ).toBe(pageUrl)
    expect(
      findSavedPageUrl(
        `<html><head><meta property="og:url" content="${pageUrl}?a=1&amp;b=2"></head></html>`,
      ),
    ).toBe(`${pageUrl}?a=1&b=2`)
    expect(
      findSavedPageUrl('<html><link rel="canonical" href="file:///x"></html>'),
    ).toBeUndefined()
  })

  it('extracts the HTML document from a Chrome single-file MHTML save', () => {
    const mhtml = [
      'From: <Saved by Blink>',
      `Snapshot-Content-Location: ${pageUrl}`,
      'Subject: 110 Folding Hunter',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related;',
      '\ttype="text/html";',
      '\tboundary="----MultipartBoundary--abc----"',
      '',
      '',
      '------MultipartBoundary--abc----',
      'Content-Type: text/html',
      'Content-ID: <frame-1@mhtml.blink>',
      'Content-Transfer-Encoding: quoted-printable',
      `Content-Location: ${pageUrl}`,
      '',
      '<html><head><meta charset=3D"utf-8"></head><body><h1>Buck 110 =E2=80=94 Fol=',
      'ding Hunter</h1></body></html>',
      '------MultipartBoundary--abc----',
      'Content-Type: image/jpeg',
      'Content-Transfer-Encoding: base64',
      'Content-Location: https://cdn.example.com/110.jpg',
      '',
      '/9j/4AAQ',
      '------MultipartBoundary--abc------',
      '',
    ].join('\r\n')
    const page = parseSavedPage('110.mhtml', mhtml)
    expect(page.url).toBe(pageUrl)
    expect(page.html).toContain('<meta charset="utf-8">')
    expect(page.html).toContain('Buck 110 — Folding Hunter')
  })

  it('rejects Safari archives and files that are not web pages', () => {
    expect(() => parseSavedPage('110.webarchive', 'bplist00')).toThrow(
      /Safari web archives/,
    )
    expect(() => parseSavedPage('notes.html', 'just some text')).toThrow(
      /Webpage, Complete/,
    )
  })

  it('recognizes product markup that a verification page lacks', () => {
    expect(
      hasProductMarkup(
        '<script type="application/ld+json">{"@type": "Product"}</script>',
      ),
    ).toBe(true)
    expect(
      hasProductMarkup('<meta property="og:type" content="product">'),
    ).toBe(true)
    expect(hasProductMarkup('<h1>Just a moment...</h1>')).toBe(false)
  })

  it('drops images rewritten into the local saved-files folder', () => {
    expect(
      isSavedPageLocalImage(
        'https://www.buckknives.com/product/110-folding-hunter-knife/110%20Folding%20Hunter_files/0110.jpg',
      ),
    ).toBe(true)
    expect(isSavedPageLocalImage('file:///Users/me/110_files/0110.jpg')).toBe(
      true,
    )
    expect(
      isSavedPageLocalImage('https://cdn.buckknives.com/images/0110.jpg'),
    ).toBe(false)
  })
})
