'use client'

import dynamic from 'next/dynamic'
import Box from '@mui/material/Box'
import { useMemo } from 'react'
import { C, MONO } from '../lib/tokens'

// ApexCharts touches window at import time, so it only loads in the browser.
const Chart = dynamic(() => import('react-apexcharts'), {
  ssr: false,
  loading: () => <Box sx={{ height: '100%' }} />,
})

export interface Bucket {
  t: number
  total: number
  errors: number
}

/** Stacked columns: clean traffic plus errors, so a spike in failures is
 *  visible against volume rather than hidden inside it. Clicking a column
 *  narrows the time range to that interval. */
export function TrafficHistogram({
  buckets,
  height = 92,
  onPick,
}: {
  buckets: Bucket[]
  height?: number
  onPick?: (from: number, to: number) => void
}) {
  const { series, categories, step } = useMemo(() => {
    const step = buckets.length > 1 ? buckets[1].t - buckets[0].t : 3600_000
    return {
      step,
      categories: buckets.map((b) => b.t),
      series: [
        { name: 'Clean', data: buckets.map((b) => Math.max(0, b.total - b.errors)) },
        { name: 'Errors', data: buckets.map((b) => b.errors) },
      ],
    }
  }, [buckets])

  if (!buckets.length) {
    return (
      <Box sx={{ height, display: 'grid', placeItems: 'center', fontSize: 11, color: C.muted }}>
        No traffic in this range
      </Box>
    )
  }

  const perDay = step >= 86_400_000
  const perMinute = step < 3_600_000

  return (
    <Box sx={{ height, '& .apexcharts-canvas': { background: 'transparent' } }}>
      <Chart
        type="bar"
        height={height}
        series={series}
        options={{
          chart: {
            type: 'bar',
            stacked: true,
            background: 'transparent',
            toolbar: { show: false },
            animations: { enabled: false },
            fontFamily: MONO,
            events: {
              dataPointSelection: (_e: unknown, _ctx: unknown, cfg: { dataPointIndex: number }) => {
                const b = buckets[cfg.dataPointIndex]
                if (b && onPick) onPick(b.t, b.t + step)
              },
            },
          },
          theme: { mode: 'dark' },
          plotOptions: { bar: { columnWidth: '72%', borderRadius: 1 } },
          colors: [C.info, C.error],
          dataLabels: { enabled: false },
          legend: { show: false },
          grid: {
            borderColor: '#1A232C',
            strokeDashArray: 0,
            xaxis: { lines: { show: false } },
            yaxis: { lines: { show: true } },
            padding: { top: -8, right: 0, bottom: -8, left: 4 },
          },
          stroke: { width: 0 },
          xaxis: {
            type: 'category',
            categories,
            labels: {
              rotate: 0,
              hideOverlappingLabels: true,
              style: { colors: C.muted, fontSize: '9px' },
              formatter: (v: string) => {
                const d = new Date(Number(v))
                if (Number.isNaN(d.getTime())) return ''
                if (perDay) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
                const hh = String(d.getHours()).padStart(2, '0')
                return perMinute ? hh + ':' + String(d.getMinutes()).padStart(2, '0') : hh + ':00'
              },
            },
            axisBorder: { color: '#25313D' },
            axisTicks: { show: false },
            tooltip: { enabled: false },
          },
          yaxis: {
            labels: {
              style: { colors: C.muted, fontSize: '9px' },
              formatter: (v: number) => (v >= 1000 ? Math.round(v / 1000) + 'k' : String(Math.round(v))),
            },
            tickAmount: 2,
          },
          tooltip: {
            shared: true,
            intersect: false,
            theme: 'dark',
            x: {
              formatter: (_v: number, opts?: { dataPointIndex: number }) => {
                const b = buckets[opts?.dataPointIndex ?? 0]
                if (!b) return ''
                const d = new Date(b.t)
                return perDay
                  ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
                  : d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', ...(perMinute ? { second: '2-digit' } : {}) })
              },
            },
          },
          states: { hover: { filter: { type: 'lighten' } }, active: { filter: { type: 'none' } } },
        }}
      />
    </Box>
  )
}
