import { useEffect, useRef, useState, type RefObject } from 'react'
import type FullCalendar from '@fullcalendar/react'
import {
  calendarFollowTime,
  calendarVisibleStart
} from '@shared/calendar-follow'

export function useCalendarFollow(
  calendar: RefObject<FullCalendar | null>,
  range: { start: number; end: number } | null,
  view: string,
  preferred: string,
  blocked: boolean
) {
  const [now, setNow] = useState(Date.now),
    [height, setHeight] = useState(500),
    interactionUntil = useRef(0),
    interactionVersion = useRef(0),
    positionedView = useRef('')
  const following = calendarFollowTime(now, range, view),
    axisStart = calendarVisibleStart(preferred, now, following !== null)
  const latest = useRef({ range, view, blocked })
  latest.current = { range, view, blocked }
  useEffect(() => {
    const section = document.querySelector('.schedule-calendar')
    if (!section) return
    let frame = 0
    const measure = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (latest.current.blocked) return
        const bottom =
          document.querySelector('.quickbar')?.getBoundingClientRect().top ??
          window.innerHeight
        const available =
          bottom - Math.max(0, section.getBoundingClientRect().top) - 40
        setHeight(Math.max(320, Math.min(660, Math.floor(available))))
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(section.parentElement ?? section)
    window.addEventListener('resize', measure)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      cancelAnimationFrame(frame)
    }
  }, [blocked])
  useEffect(() => {
    const update = (): void => setNow(Date.now())
    const timer = setInterval(update, 30000)
    window.addEventListener('focus', update)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', update)
    }
  }, [])
  // On entering a date/view or changing the time-axis start, favor upcoming hours.
  useEffect(() => {
    const key = `${range?.start}:${range?.end}:${view}:${axisStart}`,
      entering = positionedView.current !== key,
      version = interactionVersion.current
    positionedView.current = key
    const frame = requestAnimationFrame(() => {
      const time = calendarFollowTime(Date.now(), range, view)
      if (
        time &&
        !latest.current.blocked &&
        (Date.now() >= interactionUntil.current ||
          (entering && version === interactionVersion.current))
      ) {
        calendar.current?.getApi().scrollToTime(time)
        const section = document.querySelector('.schedule-calendar'),
          bottom =
            document.querySelector('.quickbar')?.getBoundingClientRect().top ??
            window.innerHeight
        if (section && section.getBoundingClientRect().bottom > bottom)
          section.scrollIntoView({ block: 'nearest' })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [calendar, range?.start, range?.end, view, axisStart, height])
  // Keep the red line away from the bottom as time advances. Brief manual browsing takes priority.
  useEffect(() => {
    const time = calendarFollowTime(now, range, view)
    if (!time || blocked || Date.now() < interactionUntil.current) return
    const line = document.querySelector(
        '.schedule-calendar .fc-timegrid-now-indicator-line'
      ),
      scroller = line?.closest('.fc-scroller')
    if (!line || !scroller) return
    const marker = line.getBoundingClientRect(),
      frame = scroller.getBoundingClientRect()
    if (
      marker.top < frame.top + 24 ||
      marker.top > frame.top + frame.height * 0.65
    )
      calendar.current?.getApi().scrollToTime(time)
    const bottom =
      document.querySelector('.quickbar')?.getBoundingClientRect().top ??
      window.innerHeight
    if (frame.bottom > bottom || frame.top < 0)
      document
        .querySelector('.schedule-calendar')
        ?.scrollIntoView({ block: 'nearest' })
  }, [calendar, now, range, view, blocked])
  return {
    now,
    height,
    axisStart,
    scrollTime: following ?? preferred,
    noteInteraction: (): void => {
      interactionVersion.current++
      interactionUntil.current = Date.now() + 30000
    }
  }
}
