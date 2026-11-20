import { AchievementsDetail } from '@/components/insight-pages/achievements-detail'
import { InsightDetailShell } from '@/components/insight-pages/insight-detail-shell'

export default function AchievementsPage() {
  return (
    <InsightDetailShell
      eyebrow="Trophy case"
      title="Achievements"
      description="Every badge in the vault, what you have earned and how close the rest are."
    >
      <AchievementsDetail />
    </InsightDetailShell>
  )
}
