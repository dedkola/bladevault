'use client'

import { useMemo, useState } from 'react'
import { InsightsChart } from '@/components/insights-chart'
import {
  formatMetric,
  getHistogramOption,
  MEASUREMENT_KEYS,
} from '@/components/collection-insights'
import { useKnives } from '@/components/providers/knives-provider'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  createCollectionStats,
  type MeasurementKey,
} from '@/lib/collection-stats'

export function MeasurementDetail({
  initialTab,
}: {
  initialTab?: MeasurementKey
}) {
  const { knives } = useKnives()
  const stats = useMemo(() => createCollectionStats(knives, 'all'), [knives])
  const [selectedKey, setSelectedKey] = useState<MeasurementKey>(() =>
    initialTab && MEASUREMENT_KEYS.includes(initialTab)
      ? initialTab
      : 'bladeLength',
  )
  const measurement = stats.measurements[selectedKey]

  const summary = [
    { label: 'Known', value: measurement.knownCount },
    { label: 'Missing', value: measurement.missingCount },
    { label: 'Min', value: formatMetric(measurement.min, measurement.unit) },
    { label: 'Q1', value: formatMetric(measurement.q1, measurement.unit) },
    {
      label: 'Median',
      value: formatMetric(measurement.median, measurement.unit),
    },
    { label: 'Q3', value: formatMetric(measurement.q3, measurement.unit) },
    { label: 'Max', value: formatMetric(measurement.max, measurement.unit) },
  ]

  return (
    <div className="space-y-6">
      <Tabs
        value={selectedKey}
        onValueChange={(value) => setSelectedKey(value as MeasurementKey)}
      >
        <TabsList>
          {MEASUREMENT_KEYS.map((key) => (
            <TabsTrigger key={key} value={key}>
              {stats.measurements[key].label}
            </TabsTrigger>
          ))}
        </TabsList>

        {MEASUREMENT_KEYS.map((key) => (
          <TabsContent key={key} value={key}>
            {key === selectedKey && (
              <>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                  {summary.map((item) => (
                    <Card key={item.label}>
                      <CardContent className="p-3">
                        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                          {item.label}
                        </span>
                        <p className="mt-1 text-lg font-semibold tabular-nums">
                          {item.value}
                        </p>
                      </CardContent>
                    </Card>
                  ))}
                </div>

                {measurement.knownCount === 0 ? (
                  <p className="mt-6 text-center text-sm text-muted-foreground">
                    Not enough data
                  </p>
                ) : (
                  <InsightsChart
                    buildOption={(palette) =>
                      getHistogramOption(measurement, palette)
                    }
                    ariaLabel={`${measurement.label} distribution`}
                    className="mt-6 h-80 w-full"
                  />
                )}
              </>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
