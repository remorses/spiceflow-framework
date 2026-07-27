'use client'
// Shared top progress bar state for router navigations and manual client work.
import { useContext, useEffect, useSyncExternalStore } from 'react'
import { isHashOnlyLocationChange, router } from 'spiceflow/react'
import { FlightDataContext } from './context.js'

export interface ProgressBarProps {
  /**
   * Color of the progress bar
   * @default "#0ea5e9"
   */
  color?: string
  /**
   * Duration of the transition animation in milliseconds
   * @default 300
   */
  duration?: number
  /**
   * Delay before the bar becomes visible, in milliseconds.
   * The bar stays fully transparent during this period, then fades in with
   * ease-in over 150ms. Fast navigations that complete before the delay
   * never show the bar. Set to 0 to show the bar immediately.
   * @default 100
   */
  delay?: number
}

function getProgressShadow(color: string) {
  return `0 4px 6px -1px color-mix(in srgb, ${color} 20%, transparent)`
}

export type ProgressState = 'initial' | 'in-progress' | 'completing'

export type ProgressSnapshot = {
  state: ProgressState
  width: number
}

export function createProgressStore() {
  let snapshot: ProgressSnapshot = {
    state: 'initial',
    width: 0,
  }
  let interval: ReturnType<typeof setInterval> | null = null
  let manualCount = 0
  let navigationPending = false
  const listeners = new Set<() => void>()

  function emit() {
    for (const listener of listeners) {
      listener()
    }
  }

  function setSnapshot(next: ProgressSnapshot) {
    if (snapshot.state === next.state && snapshot.width === next.width) {
      return
    }
    snapshot = next
    emit()
  }

  function stopInterval() {
    if (!interval) {
      return
    }
    clearInterval(interval)
    interval = null
  }

  function tick() {
    if (snapshot.state !== 'in-progress') {
      return
    }

    const diff =
      snapshot.width === 0
        ? 15
        : snapshot.width < 50
          ? rand(1, 10)
          : rand(1, 5)

    setSnapshot({
      state: 'in-progress',
      width: Math.min(snapshot.width + diff, 99),
    })
  }

  function ensureInterval() {
    if (snapshot.state !== 'in-progress') {
      stopInterval()
      return
    }
    if (interval) {
      return
    }
    interval = setInterval(tick, 750)
  }

  function startProgress() {
    if (snapshot.state === 'in-progress') {
      return
    }

    const width = snapshot.width === 0 || snapshot.width === 100 ? 15 : snapshot.width
    setSnapshot({
      state: 'in-progress',
      width,
    })
    ensureInterval()
  }

  function completeProgress() {
    if (snapshot.state === 'initial' || snapshot.state === 'completing') {
      return
    }
    stopInterval()
    setSnapshot({
      state: 'completing',
      width: 100,
    })
  }

  function syncProgressState() {
    if (manualCount > 0 || navigationPending) {
      startProgress()
      return
    }
    completeProgress()
  }

  function startManual() {
    manualCount += 1
    syncProgressState()
  }

  function endManual() {
    if (manualCount === 0) {
      return
    }
    manualCount -= 1
    syncProgressState()
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot() {
      return snapshot
    },
    start: startManual,
    end: endManual,
    done() {
      endManual()
    },
    beginNavigation() {
      if (navigationPending) {
        return
      }
      navigationPending = true
      syncProgressState()
    },
    endNavigation() {
      if (!navigationPending) {
        return
      }
      navigationPending = false
      syncProgressState()
    },
    reset() {
      if (manualCount > 0 || navigationPending) {
        startProgress()
        return
      }
      stopInterval()
      setSnapshot({
        state: 'initial',
        width: 0,
      })
    },
    destroy() {
      stopInterval()
      listeners.clear()
    },
  }
}

const progressStore = createProgressStore()

export function ProgressBar({
  color = '#0ea5e9',
  duration = 300,
  delay = 100,
}: ProgressBarProps) {
  const progress = useSyncExternalStore(
    progressStore.subscribe,
    progressStore.getSnapshot,
    progressStore.getSnapshot,
  )

  const data = useContext(FlightDataContext)
  useEffect(() => {
    progressStore.endNavigation()
  }, [data])

  useEffect(() => {
    return router.subscribe((event) => {
      if (event.action === 'LOADER_DATA') return
      if (
        isHashOnlyLocationChange({
          previousLocation: event.previousLocation,
          location: event.location,
        })
      ) {
        return
      }
      progressStore.beginNavigation()
    })
  }, [])

  const isInProgress = progress.state === 'in-progress'
  const isCompleting = progress.state === 'completing'
  const isInitial = progress.state === 'initial'

  // Use a CSS animation with a delay so the bar stays invisible for `delay`ms,
  // then fades in with ease-in over 150ms. Fast navigations that complete before
  // the delay never show the bar. The animation-delay keeps opacity at 0 (via
  // fill-mode: backwards) during the wait period.
  // On completing, we skip opacity transition entirely and reset via the width
  // transitionend event, because cancelling the animation snaps opacity to 0.
  return (
    <>
      {delay > 0 && (
        <style
          dangerouslySetInnerHTML={{
            __html:
              '@keyframes spiceflow-progress-fade-in{from{opacity:0}to{opacity:1}}',
          }}
        />
      )}
      <div
        style={{
          position: 'fixed',
          zIndex: 200,
          top: 0,
          left: 0,
          right: 0,
          height: '4px',
          backgroundColor: color,
          boxShadow: getProgressShadow(color),
          transition: isInitial ? '' : `all ${duration}ms`,
          width: `${progress.width}%`,
          opacity: isCompleting ? 0 : delay === 0 || !isInProgress ? 1 : undefined,
          animation:
            isInProgress && delay > 0
              ? `spiceflow-progress-fade-in 150ms ease-in ${delay}ms both`
              : 'none',
        }}
        onTransitionEnd={(e) => {
          if (
            isCompleting &&
            (e.propertyName === 'opacity' || e.propertyName === 'width')
          ) {
            progressStore.reset()
          }
        }}
      />
    </>
  )
}

ProgressBar.start = () => progressStore.start()
ProgressBar.end = () => progressStore.end()
ProgressBar.done = () => progressStore.done()

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
