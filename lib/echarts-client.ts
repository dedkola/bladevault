import {
  BarChart,
  GaugeChart,
  LineChart,
  PieChart,
  ScatterChart,
} from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { LabelLayout } from 'echarts/features'
import * as echarts from 'echarts/core'
import { SVGRenderer } from 'echarts/renderers'

echarts.use([
  BarChart,
  GaugeChart,
  LineChart,
  PieChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LabelLayout,
  SVGRenderer,
])

export const init = echarts.init
