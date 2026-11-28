## 1.9.1.9
- One swipe now turns exactly one page. Page turning is a single smooth ease: your finger drags the page, and on release it slides to the next page or back.
- Opens EPUB books as real pages (chapters, headings, bold and italic, lists, pictures, Bangla). Swipe to turn a page, or tap the left or right edge. The − and + buttons change the text size and the pages flow again. It remembers your page. Use "Open with Reader" on an .epub or pick one from Open.
- Read aloud for books: the speaker button reads from the page you are on with the phone's own voice (English, and Bangla if the phone has a Bangla voice), highlights the paragraph, turns the pages by itself, and the speed button switches 1×, 1.25×, 1.5× and 0.8×. Tap the speaker again to stop.
- Security: updated the PDF engine (PDF.js 6.2.108) to fix a published vulnerability in older versions.
- Removed the experimental .boox opening from 1.9.1.8.

## 1.9.1.8
- No more bounce after a page lands: swipes now finish with one smooth slide that stops exactly on the page.
- Opens `.boox` files, read-only. The format is not published, so Reader opens it as an archive and shows the PDF or the page pictures inside; if there is neither it says so.
- `.boox` files can be opened from other apps with "Open with Reader".

## 1.9.1.7
- Page turning is now a plain slide to the left or right: the page just moves with your finger, with no tilt effect.
- Nothing is restyled or redrawn while you swipe. The page counter, the tick and saving your place all happen after the swipe lands.
- Two pages on each side stay loaded, so turning to a nearby page shows it at once.

## 1.9.1.6
- Fixed the stutter when a swipe finishes: pages are now drawn one at a time in quiet moments, only the next and previous page are prepared, and a new swipe cancels pending drawing.
- Book pages are drawn at screen size instead of oversized, so they reach the screen without a stall (zooming still re-draws sharper).

## 1.9.1.5
- A book button in the top-right corner of the reader switches book pages on or off (it hides with the toolbar).
- Smoother page turns: pages are drawn only after a swipe settles, the next pages are prepared in order, and the page-turn sound of the phone's tick waits for the swipe to land.
- Pinch to zoom in book mode (up to 4x, sharp when you stop), double-tap to zoom in and out, and one finger moves a zoomed page. Swiping doesn't turn the page while it is zoomed.
- The app starts lighter: the PDF engine now loads only when you open a PDF.
