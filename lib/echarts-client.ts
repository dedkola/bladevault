import { BarChart, GaugeChart, PieChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { LabelLayout } from 'echarts/features'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'

echarts.use([
  BarChart,
  GaugeChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LabelLayout,
  SVGRenderer,
])

export const init = echarts.init
