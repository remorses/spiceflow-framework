---
'spiceflow': patch
---

Add `delay` prop to `ProgressBar` (default 100ms). The bar stays fully transparent during the delay period, then fades in with ease-in over 150ms. Fast navigations that complete before the delay never flash the bar. Set `delay={0}` to restore the previous instant-show behavior.
