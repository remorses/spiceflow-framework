---
'spiceflow': minor
---

Add toast notifications for uncaught server action errors.

When a server action throws and the caller does not catch the error (no `try/catch`, no `ErrorBoundary`), the framework now shows a dismissable error toast instead of crashing the page to a white screen.

```ts
// Before: this crashes the page if the action throws
onClick={() => myAction()}

// After: a toast appears with the error message, page stays intact
```

The toast renderer is auto-mounted by the framework. Users can import `toast` for custom notifications:

```ts
import { toast } from 'spiceflow/react'

toast.error('Something failed')
toast.success('Saved!')
toast('Info message')
toast.dismiss(id)
```

If the user wraps with `<ErrorBoundary>`, it catches the error normally and no toast fires.
