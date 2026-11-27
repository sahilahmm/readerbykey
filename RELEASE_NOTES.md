## 1.9.1.6
- Fixed the stutter when a swipe finishes: pages are now drawn one at a time in quiet moments, only the next and previous page are prepared, and a new swipe cancels pending drawing.
- Book pages are drawn at screen size instead of oversized, so they reach the screen without a stall (zooming still re-draws sharper).

## 1.9.1.5
- A book button in the top-right corner of the reader switches book pages on or off (it hides with the toolbar).
- Smoother page turns: pages are drawn only after a swipe settles, the next pages are prepared in order, and the page-turn sound of the phone's tick waits for the swipe to land.
- Pinch to zoom in book mode (up to 4x, sharp when you stop), double-tap to zoom in and out, and one finger moves a zoomed page. Swiping doesn't turn the page while it is zoomed.
- The app starts lighter: the PDF engine now loads only when you open a PDF.
