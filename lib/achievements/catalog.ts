import {
  buildAchievementSnapshot,
  type AchievementInput,
  type AchievementSnapshot,
} from '@/lib/achievements/snapshot'

export type AchievementCategory =
  | 'size'
  | 'makers'
  | 'steel'
  | 'handles'
  | 'shapes'
  | 'dimensions'
  | 'world'
  | 'catalogue'
  | 'care'
  | 'habits'
  | 'market'
  | 'rotation'

export type AchievementTier = 'bronze' | 'silver' | 'gold' | 'platinum'

/** How a progress number reads: a plain count unless stated. */
export type AchievementUnit =
  'count' | 'percent' | 'cm' | 'grams' | 'money' | 'years'

export type AchievementDefinition = {
  /** Stable id, stored with each unlock. Never rename one that has shipped. */
  id: string
  category: AchievementCategory
  tier: AchievementTier
  title: string
  description: string
  /** Hidden as "???" until unlocked. */
  secret?: boolean
  /** Only counted while price monitoring is on. */
  requiresPriceMonitoring?: boolean
  target: number
  unit?: AchievementUnit
  /** Progress towards `target`; the achievement unlocks at `measure >= target`. */
  measure: (snapshot: AchievementSnapshot) => number
}

export type AchievementProgress = {
  id: string
  current: number
  target: number
  done: boolean
  /** False when the feature it depends on (price monitoring) is off. */
  available: boolean
}

export const ACHIEVEMENT_CATEGORIES: ReadonlyArray<{
  id: AchievementCategory
  label: string
}> = [
  { id: 'size', label: 'Collection size' },
  { id: 'makers', label: 'Makers' },
  { id: 'steel', label: 'Steel' },
  { id: 'handles', label: 'Handles' },
  { id: 'shapes', label: 'Shapes & locks' },
  { id: 'dimensions', label: 'Dimensions' },
  { id: 'world', label: 'World' },
  { id: 'catalogue', label: 'Catalogue' },
  { id: 'care', label: 'Care' },
  { id: 'habits', label: 'Habits' },
  { id: 'market', label: 'Market' },
  { id: 'rotation', label: 'Rotation' },
]

export const ACHIEVEMENT_TIER_POINTS: Record<AchievementTier, number> = {
  bronze: 10,
  silver: 25,
  gold: 50,
  platinum: 100,
}

/** Collector ranks by minimum score; the last one needs ~90% of all points. */
export const ACHIEVEMENT_RANKS: ReadonlyArray<{
  title: string
  minScore: number
}> = [
  { title: 'Rookie', minScore: 0 },
  { title: 'Pocket Carrier', minScore: 100 },
  { title: 'Enthusiast', minScore: 250 },
  { title: 'Collector', minScore: 500 },
  { title: 'Curator', minScore: 850 },
  { title: 'Bladesmith', minScore: 1300 },
  { title: 'Grandmaster', minScore: 1900 },
  { title: 'Jedi Collector', minScore: 2600 },
]

type Def = AchievementDefinition
const flag = (value: boolean) => (value ? 1 : 0)
const atLeastOne = (value: number) => Math.min(value, 1)

const size = (
  id: string,
  tier: AchievementTier,
  title: string,
  target: number,
  description: string,
  secret = false,
): Def => ({
  id,
  category: 'size',
  tier,
  title,
  description,
  target,
  secret,
  measure: (s) => s.ownedCount,
})

export const ACHIEVEMENTS: readonly AchievementDefinition[] = [
  // Collection size
  size('first-blade', 'bronze', 'First Blade', 1, 'Add your first knife'),
  size('pocketful', 'bronze', 'Pocketful', 5, '5 knives in the vault'),
  size(
    'drawer-starter',
    'bronze',
    'Drawer Starter',
    10,
    '10 knives in the vault',
  ),
  size(
    'quarter-century',
    'silver',
    'Quarter Century',
    25,
    '25 knives in the vault',
  ),
  size('half-hundred', 'silver', 'Half Hundred', 50, '50 knives in the vault'),
  size('collector', 'gold', 'Collector', 100, '100 knives in the vault'),
  size('armory', 'gold', 'Armory', 250, '250 knives in the vault'),
  size('curator', 'platinum', 'Curator', 500, '500 knives in the vault'),
  size(
    'jedi-collector',
    'platinum',
    'Jedi Collector',
    1000,
    '1,000 knives in the vault',
  ),
  size(
    'dragons-hoard',
    'platinum',
    "Dragon's Hoard",
    2000,
    '2,000 knives in the vault',
    true,
  ),

  // Makers & designers
  {
    id: 'brand-curious',
    category: 'makers',
    tier: 'bronze',
    title: 'Brand Curious',
    description: 'Knives from 3 brands',
    target: 3,
    measure: (s) => s.brandCount,
  },
  {
    id: 'brand-hopper',
    category: 'makers',
    tier: 'silver',
    title: 'Brand Hopper',
    description: 'Knives from 10 brands',
    target: 10,
    measure: (s) => s.brandCount,
  },
  {
    id: 'maker-atlas',
    category: 'makers',
    tier: 'gold',
    title: 'Maker Atlas',
    description: 'Knives from 25 brands',
    target: 25,
    measure: (s) => s.brandCount,
  },
  {
    id: 'brand-encyclopedia',
    category: 'makers',
    tier: 'platinum',
    title: 'Brand Encyclopedia',
    description: 'Knives from 50 brands',
    target: 50,
    measure: (s) => s.brandCount,
  },
  {
    id: 'loyalist',
    category: 'makers',
    tier: 'silver',
    title: 'Loyalist',
    description: '10 knives from one brand',
    target: 10,
    measure: (s) => s.maxPerBrand,
  },
  {
    id: 'devotee',
    category: 'makers',
    tier: 'gold',
    title: 'Devotee',
    description: '25 knives from one brand',
    target: 25,
    measure: (s) => s.maxPerBrand,
  },
  {
    id: 'designer-fan',
    category: 'makers',
    tier: 'silver',
    title: 'Designer Fan',
    description: '5 knives by the same designer',
    target: 5,
    measure: (s) => s.maxPerDesigner,
  },
  {
    id: 'name-dropper',
    category: 'makers',
    tier: 'gold',
    title: 'Name Dropper',
    description: 'Knives by 10 different designers',
    target: 10,
    measure: (s) => s.designerCount,
  },

  // Steel
  {
    id: 'steel-curious',
    category: 'steel',
    tier: 'bronze',
    title: 'Steel Curious',
    description: '5 different blade steels',
    target: 5,
    measure: (s) => s.steelCount,
  },
  {
    id: 'metallurgist',
    category: 'steel',
    tier: 'silver',
    title: 'Metallurgist',
    description: '15 different blade steels',
    target: 15,
    measure: (s) => s.steelCount,
  },
  {
    id: 'alloy-alchemist',
    category: 'steel',
    tier: 'gold',
    title: 'Alloy Alchemist',
    description: '30 different blade steels',
    target: 30,
    measure: (s) => s.steelCount,
  },
  {
    id: 'super-steel',
    category: 'steel',
    tier: 'bronze',
    title: 'Super Steel',
    description: 'Own a super steel such as M390, 20CV, S90V, MagnaCut or K390',
    target: 1,
    measure: (s) => atLeastOne(s.superSteelCount),
  },
  {
    id: 'magna-cult',
    category: 'steel',
    tier: 'silver',
    title: 'Magna Cult',
    description: '5 MagnaCut knives',
    target: 5,
    measure: (s) => s.magnaCutCount,
  },
  {
    id: 'damascus-dreams',
    category: 'steel',
    tier: 'silver',
    title: 'Damascus Dreams',
    description: 'Own a Damascus blade',
    target: 1,
    measure: (s) => atLeastOne(s.damascusCount),
  },
  {
    id: 'old-school',
    category: 'steel',
    tier: 'bronze',
    title: 'Old School',
    description: 'Own a carbon steel such as 1095, O1, 52100 or A2',
    target: 1,
    measure: (s) => atLeastOne(s.carbonSteelCount),
  },
  {
    id: 'budget-hero',
    category: 'steel',
    tier: 'bronze',
    title: 'Budget Hero',
    description: 'Own an 8Cr13MoV, AUS-8 or 440A workhorse',
    target: 1,
    measure: (s) => atLeastOne(s.budgetSteelCount),
  },

  // Handles
  {
    id: 'get-a-grip',
    category: 'handles',
    tier: 'bronze',
    title: 'Get a Grip',
    description: '5 different handle materials',
    target: 5,
    measure: (s) => s.handleCount,
  },
  {
    id: 'carbon-copy',
    category: 'handles',
    tier: 'bronze',
    title: 'Carbon Copy',
    description: 'Own a carbon fiber handle',
    target: 1,
    measure: (s) => atLeastOne(s.carbonFiberCount),
  },
  {
    id: 'titanium-club',
    category: 'handles',
    tier: 'silver',
    title: 'Titanium Club',
    description: '10 titanium handles',
    target: 10,
    measure: (s) => s.titaniumCount,
  },
  {
    id: 'natural-born',
    category: 'handles',
    tier: 'bronze',
    title: 'Natural Born',
    description: 'Own a wood, bone, stag or micarta handle',
    target: 1,
    measure: (s) => atLeastOne(s.naturalHandleCount),
  },
  {
    id: 'plastic-fantastic',
    category: 'handles',
    tier: 'bronze',
    title: 'Plastic Fantastic',
    description: 'Own an FRN, Zytel or GRN handle',
    target: 1,
    measure: (s) => atLeastOne(s.plasticHandleCount),
  },

  // Shapes & locks
  {
    id: 'shape-shifter',
    category: 'shapes',
    tier: 'bronze',
    title: 'Shape Shifter',
    description: '5 different blade styles',
    target: 5,
    measure: (s) => s.styleCount,
  },
  {
    id: 'full-spectrum',
    category: 'shapes',
    tier: 'silver',
    title: 'Full Spectrum',
    description: '10 different blade styles',
    target: 10,
    measure: (s) => s.styleCount,
  },
  {
    id: 'tanto-time',
    category: 'shapes',
    tier: 'bronze',
    title: 'Tanto Time',
    description: 'Own a tanto',
    target: 1,
    measure: (s) => atLeastOne(s.tantoCount),
  },
  {
    id: 'straight-edge',
    category: 'shapes',
    tier: 'bronze',
    title: 'Straight Edge',
    description: 'Own a wharncliffe or sheepsfoot',
    target: 1,
    measure: (s) => atLeastOne(s.straightEdgeCount),
  },
  {
    id: 'lock-collector',
    category: 'shapes',
    tier: 'silver',
    title: 'Lock Collector',
    description: '5 different locking mechanisms',
    target: 5,
    measure: (s) => s.lockCount,
  },
  {
    id: 'frame-lock-fan',
    category: 'shapes',
    tier: 'silver',
    title: 'Frame Lock Fan',
    description: '10 frame locks',
    target: 10,
    measure: (s) => s.frameLockCount,
  },
  {
    id: 'gentlemans-carry',
    category: 'shapes',
    tier: 'bronze',
    title: "Gentleman's Carry",
    description: 'Own a slip joint or other non-locking knife',
    target: 1,
    measure: (s) => atLeastOne(s.slipJointCount),
  },

  // Dimensions
  {
    id: 'featherweight',
    category: 'dimensions',
    tier: 'bronze',
    title: 'Featherweight',
    description: 'A knife under 40 g',
    target: 1,
    measure: (s) => flag(s.lightestGrams < 40),
  },
  {
    id: 'heavyweight',
    category: 'dimensions',
    tier: 'bronze',
    title: 'Heavyweight',
    description: 'A knife over 250 g',
    target: 1,
    measure: (s) => flag(s.heaviestGrams > 250),
  },
  {
    id: 'tiny-titan',
    category: 'dimensions',
    tier: 'bronze',
    title: 'Tiny Titan',
    description: 'A blade under 2 in',
    target: 1,
    measure: (s) => flag(s.shortestBladeInches < 2),
  },
  {
    id: 'big-stick',
    category: 'dimensions',
    tier: 'silver',
    title: 'Big Stick',
    description: 'A blade over 5 in',
    target: 1,
    measure: (s) => flag(s.longestBladeInches > 5),
  },
  {
    id: 'sword-adjacent',
    category: 'dimensions',
    tier: 'silver',
    title: 'Sword Adjacent',
    description: 'A knife over 12 in overall',
    target: 1,
    measure: (s) => flag(s.longestOverallInches > 12),
  },
  {
    id: 'pry-bar',
    category: 'dimensions',
    tier: 'silver',
    title: 'Pry Bar',
    description: 'Blade stock of 5 mm or more',
    target: 1,
    measure: (s) => flag(s.thickestMm >= 5),
  },
  {
    id: 'laser-beam',
    category: 'dimensions',
    tier: 'silver',
    title: 'Laser Beam',
    description: 'Blade stock of 2.5 mm or less',
    target: 1,
    measure: (s) => flag(s.thinnestMm <= 2.5),
  },
  {
    id: 'metre-of-edge',
    category: 'dimensions',
    tier: 'silver',
    title: 'Metre of Edge',
    description: 'Blades add up to 1 metre',
    target: 100,
    unit: 'cm',
    measure: (s) => Math.floor(s.totalBladeCm),
  },
  {
    id: 'ten-metres',
    category: 'dimensions',
    tier: 'platinum',
    title: 'Ten Metres',
    description: 'Blades add up to 10 metres',
    target: 1000,
    unit: 'cm',
    measure: (s) => Math.floor(s.totalBladeCm),
  },
  {
    id: 'heavy-metal',
    category: 'dimensions',
    tier: 'gold',
    title: 'Heavy Metal',
    description: 'The whole collection weighs 10 kg',
    target: 10_000,
    unit: 'grams',
    measure: (s) => Math.floor(s.totalGrams),
  },

  // World
  {
    id: 'passport',
    category: 'world',
    tier: 'bronze',
    title: 'Passport',
    description: 'Knives from 3 countries',
    target: 3,
    measure: (s) => s.countryCount,
  },
  {
    id: 'world-tour',
    category: 'world',
    tier: 'silver',
    title: 'World Tour',
    description: 'Knives from 10 countries',
    target: 10,
    measure: (s) => s.countryCount,
  },
  {
    id: 'united-blades',
    category: 'world',
    tier: 'gold',
    title: 'United Blades',
    description: 'Knives from 20 countries',
    target: 20,
    measure: (s) => s.countryCount,
  },
  {
    id: 'seki-spirit',
    category: 'world',
    tier: 'bronze',
    title: 'Seki Spirit',
    description: 'Own a knife made in Japan',
    target: 1,
    measure: (s) => flag(s.hasJapan),
  },
  {
    id: 'continental',
    category: 'world',
    tier: 'gold',
    title: 'Continental',
    description: 'Knives from 4 continents',
    target: 4,
    measure: (s) => s.continentCount,
  },

  // Catalogue quality
  {
    id: 'detail-oriented',
    category: 'catalogue',
    tier: 'bronze',
    title: 'Detail Oriented',
    description: 'One knife with every core spec filled in',
    target: 1,
    measure: (s) => atLeastOne(s.fullySpeccedCount),
  },
  {
    id: 'spec-sheet',
    category: 'catalogue',
    tier: 'silver',
    title: 'Spec Sheet',
    description: '25 knives with every core spec filled in',
    target: 25,
    measure: (s) => s.fullySpeccedCount,
  },
  {
    id: 'perfectionist',
    category: 'catalogue',
    tier: 'platinum',
    title: 'Perfectionist',
    description: '100% catalogue coverage with 20 or more knives',
    target: 100,
    unit: 'percent',
    measure: (s) => (s.ownedCount >= 20 ? s.completenessPercent : 0),
  },
  {
    id: 'shutterbug',
    category: 'catalogue',
    tier: 'bronze',
    title: 'Shutterbug',
    description: 'A knife with 5 or more photos',
    target: 1,
    measure: (s) => flag(s.maxPhotos >= 5),
  },
  {
    id: 'photo-album',
    category: 'catalogue',
    tier: 'gold',
    title: 'Photo Album',
    description: '500 photos across the vault',
    target: 500,
    measure: (s) => s.totalPhotos,
  },
  {
    id: 'every-face-counts',
    category: 'catalogue',
    tier: 'silver',
    title: 'Every Face Counts',
    description: 'Every knife has a photo, with 10 or more knives',
    target: 100,
    unit: 'percent',
    measure: (s) => (s.ownedCount >= 10 ? s.photographedPercent : 0),
  },
  {
    id: 'storyteller',
    category: 'catalogue',
    tier: 'bronze',
    title: 'Storyteller',
    description: 'A description over 500 characters',
    target: 1,
    measure: (s) => flag(s.longestDescription > 500),
  },
  {
    id: 'note-taker',
    category: 'catalogue',
    tier: 'bronze',
    title: 'Note Taker',
    description: 'Write 10 knife notes',
    target: 10,
    measure: (s) => s.noteCount,
  },
  {
    id: 'journal-keeper',
    category: 'catalogue',
    tier: 'gold',
    title: 'Journal Keeper',
    description: 'Write 100 knife notes',
    target: 100,
    measure: (s) => s.noteCount,
  },
  {
    id: 'custom-tailor',
    category: 'catalogue',
    tier: 'silver',
    title: 'Custom Tailor',
    description: 'Fill one custom field on 10 knives',
    target: 10,
    measure: (s) => s.maxCustomFieldUse,
  },
  {
    id: 'source-hunter',
    category: 'catalogue',
    tier: 'silver',
    title: 'Source Hunter',
    description: '50 knives with a source link',
    target: 50,
    measure: (s) => s.sourcedCount,
  },

  // Care
  {
    id: 'first-shine',
    category: 'care',
    tier: 'bronze',
    title: 'First Shine',
    description: 'Log your first maintenance',
    target: 1,
    measure: (s) => atLeastOne(s.careCount),
  },
  {
    id: 'sharp-dressed',
    category: 'care',
    tier: 'bronze',
    title: 'Sharp Dressed',
    description: 'Log your first sharpening',
    target: 1,
    measure: (s) => atLeastOne(s.careOf('sharpening')),
  },
  {
    id: 'whetstone-monk',
    category: 'care',
    tier: 'gold',
    title: 'Whetstone Monk',
    description: 'Log 50 sharpenings',
    target: 50,
    measure: (s) => s.careOf('sharpening'),
  },
  {
    id: 'strop-star',
    category: 'care',
    tier: 'silver',
    title: 'Strop Star',
    description: 'Log 25 stroppings',
    target: 25,
    measure: (s) => s.careOf('stropping'),
  },
  {
    id: 'oil-baron',
    category: 'care',
    tier: 'silver',
    title: 'Oil Baron',
    description: 'Log 25 lubrications',
    target: 25,
    measure: (s) => s.careOf('lubrication'),
  },
  {
    id: 'clean-freak',
    category: 'care',
    tier: 'silver',
    title: 'Clean Freak',
    description: 'Log 50 cleanings',
    target: 50,
    measure: (s) => s.careOf('cleaning'),
  },
  {
    id: 'surgeon',
    category: 'care',
    tier: 'silver',
    title: 'Surgeon',
    description: 'Take a knife apart and put it back together on the same day',
    secret: true,
    target: 1,
    measure: (s) => atLeastOne(s.sameDayRebuilds),
  },
  {
    id: 'spare-parts',
    category: 'care',
    tier: 'bronze',
    title: 'Spare Parts',
    description: 'Log a part or hardware replacement',
    target: 1,
    measure: (s) =>
      atLeastOne(
        s.careOf('part_replacement') + s.careOf('hardware_replacement'),
      ),
  },
  {
    id: 'maintenance-marathon',
    category: 'care',
    tier: 'gold',
    title: 'Maintenance Marathon',
    description: 'Log 100 care events',
    target: 100,
    measure: (s) => s.careCount,
  },
  {
    id: 'caretaker',
    category: 'care',
    tier: 'silver',
    title: 'Caretaker',
    description: 'Care for a knife 7 days in a row',
    target: 7,
    measure: (s) => s.careStreak,
  },
  {
    id: 'inbox-zero',
    category: 'care',
    tier: 'silver',
    title: 'Inbox Zero',
    description:
      'Clear every care reminder in the Inbox, with 10 or more knives',
    target: 1,
    measure: (s) =>
      flag(
        s.ownedCount >= 10 &&
          s.openCareReminders === 0 &&
          s.clearedCareReminders > 0,
      ),
  },
  {
    id: 'every-edge-loved',
    category: 'care',
    tier: 'gold',
    title: 'Every Edge Loved',
    description: 'Every knife has a care event, with 10 or more knives',
    target: 100,
    unit: 'percent',
    measure: (s) => (s.ownedCount >= 10 ? s.caredForPercent : 0),
  },

  // Habits & time
  {
    id: 'shopping-spree',
    category: 'habits',
    tier: 'bronze',
    title: 'Shopping Spree',
    description: 'Add 5 knives in one day',
    target: 5,
    measure: (s) => s.maxAddedInDay,
  },
  {
    id: 'binge-mode',
    category: 'habits',
    tier: 'silver',
    title: 'Binge Mode',
    description: 'Add 20 knives in one day',
    target: 20,
    measure: (s) => s.maxAddedInDay,
  },
  {
    id: 'steady-hand',
    category: 'habits',
    tier: 'silver',
    title: 'Steady Hand',
    description: 'Add knives in 6 different months',
    target: 6,
    measure: (s) => s.addedMonths,
  },
  {
    id: 'anniversary',
    category: 'habits',
    tier: 'silver',
    title: 'Anniversary',
    description: 'Your vault turns 1 year old',
    target: 1,
    unit: 'years',
    measure: (s) => s.vaultYears,
  },
  {
    id: 'veteran',
    category: 'habits',
    tier: 'platinum',
    title: 'Veteran',
    description: 'Your vault turns 5 years old',
    target: 5,
    unit: 'years',
    measure: (s) => s.vaultYears,
  },
  {
    id: 'night-owl',
    category: 'habits',
    tier: 'bronze',
    title: 'Night Owl',
    description: 'Add a knife between midnight and 4 am',
    secret: true,
    target: 1,
    measure: (s) => atLeastOne(s.nightOwlAdds),
  },
  {
    id: 'the-answer',
    category: 'habits',
    tier: 'silver',
    title: 'The Answer',
    description: 'Exactly 42 knives in the vault',
    secret: true,
    target: 1,
    measure: (s) => flag(s.ownedCount === 42),
  },
  {
    id: 'weekend-warrior',
    category: 'habits',
    tier: 'bronze',
    title: 'Weekend Warrior',
    description: 'Add 10 knives on weekends',
    target: 10,
    measure: (s) => s.weekendAdds,
  },
  {
    id: 'daily-grinder',
    category: 'habits',
    tier: 'silver',
    title: 'Daily Grinder',
    description: 'Vault activity 7 days in a row',
    target: 7,
    measure: (s) => s.activityStreak,
  },
  {
    id: 'christmas-blade',
    category: 'habits',
    tier: 'silver',
    title: 'Christmas Blade',
    description: 'Add a knife on 25 December',
    secret: true,
    target: 1,
    measure: (s) => atLeastOne(s.christmasAdds),
  },
  {
    id: 'friday-the-13th',
    category: 'habits',
    tier: 'silver',
    title: 'Friday the 13th',
    description: 'Add a knife on Friday the 13th',
    secret: true,
    target: 1,
    measure: (s) => atLeastOne(s.fridayThirteenthAdds),
  },

  // Market
  {
    id: 'price-watcher',
    category: 'market',
    tier: 'bronze',
    title: 'Price Watcher',
    description: 'Watch your first price',
    requiresPriceMonitoring: true,
    target: 1,
    measure: (s) => atLeastOne(s.watchedKnives),
  },
  {
    id: 'deal-hunter',
    category: 'market',
    tier: 'bronze',
    title: 'Deal Hunter',
    description: 'Catch your first price drop',
    requiresPriceMonitoring: true,
    target: 1,
    measure: (s) => atLeastOne(s.dropCount),
  },
  {
    id: 'bargain-bin',
    category: 'market',
    tier: 'gold',
    title: 'Bargain Bin',
    description: 'Catch a price drop of 30% or more',
    requiresPriceMonitoring: true,
    target: 30,
    unit: 'percent',
    measure: (s) => Math.floor(s.biggestDropPercent),
  },
  {
    id: 'restock-radar',
    category: 'market',
    tier: 'silver',
    title: 'Restock Radar',
    description: 'Catch a knife back in stock',
    requiresPriceMonitoring: true,
    target: 1,
    measure: (s) => atLeastOne(s.backInStock),
  },
  {
    id: 'market-analyst',
    category: 'market',
    tier: 'silver',
    title: 'Market Analyst',
    description: 'Watch prices for 25 knives',
    requiresPriceMonitoring: true,
    target: 25,
    measure: (s) => s.watchedKnives,
  },
  {
    id: 'big-spender',
    category: 'market',
    tier: 'gold',
    title: 'Big Spender',
    description: 'Collection value of 10,000 or more',
    target: 10_000,
    unit: 'money',
    measure: (s) => Math.floor(s.collectionValue),
  },
  {
    id: 'grail',
    category: 'market',
    tier: 'gold',
    title: 'Grail',
    description: 'A single knife worth 1,000 or more',
    target: 1,
    measure: (s) => flag(s.mostExpensive >= 1000),
  },
  {
    id: 'gas-station-special',
    category: 'market',
    tier: 'bronze',
    title: 'Gas Station Special',
    description: 'A knife that cost under 20',
    secret: true,
    target: 1,
    measure: (s) => flag(s.cheapest < 20),
  },

  // Rotation & comparison
  {
    id: 'moving-on',
    category: 'rotation',
    tier: 'bronze',
    title: 'Moving On',
    description: 'Mark your first knife as sold',
    target: 1,
    measure: (s) => atLeastOne(s.soldCount),
  },
  {
    id: 'rotation',
    category: 'rotation',
    tier: 'silver',
    title: 'Rotation',
    description: 'Sell 10 knives',
    target: 10,
    measure: (s) => s.soldCount,
  },
  {
    id: 'favourites',
    category: 'rotation',
    tier: 'bronze',
    title: 'Favourites',
    description: 'Pin 5 knives',
    target: 5,
    measure: (s) => s.pinnedCount,
  },
  {
    id: 'head-to-head',
    category: 'rotation',
    tier: 'bronze',
    title: 'Head to Head',
    description: 'Compare 4 knives at once',
    target: 4,
    measure: (s) => s.largestComparison,
  },
  {
    id: 'the-judge',
    category: 'rotation',
    tier: 'silver',
    title: 'The Judge',
    description: 'Create 5 comparison lists',
    target: 5,
    measure: (s) => s.comparisonCount,
  },
]

export const ACHIEVEMENTS_BY_ID: ReadonlyMap<string, AchievementDefinition> =
  new Map(ACHIEVEMENTS.map((achievement) => [achievement.id, achievement]))

/** Progress for every achievement against the current vault. */
export function evaluateAchievements(
  input: AchievementInput,
): AchievementProgress[] {
  const snapshot = buildAchievementSnapshot(input)
  return ACHIEVEMENTS.map((achievement) => {
    const available =
      !achievement.requiresPriceMonitoring || snapshot.priceMonitoring
    const current = available ? achievement.measure(snapshot) : 0
    return {
      id: achievement.id,
      current,
      target: achievement.target,
      done: available && current >= achievement.target,
      available,
    }
  })
}

export function achievementPoints(id: string): number {
  const achievement = ACHIEVEMENTS_BY_ID.get(id)
  return achievement ? ACHIEVEMENT_TIER_POINTS[achievement.tier] : 0
}

export const MAX_ACHIEVEMENT_SCORE = ACHIEVEMENTS.reduce(
  (sum, achievement) => sum + ACHIEVEMENT_TIER_POINTS[achievement.tier],
  0,
)

/** Score, current rank and the next one for a set of unlocked ids. */
export function summarizeAchievements(unlockedIds: Iterable<string>) {
  const unlocked = new Set(
    [...unlockedIds].filter((id) => ACHIEVEMENTS_BY_ID.has(id)),
  )
  const score = [...unlocked].reduce(
    (sum, id) => sum + achievementPoints(id),
    0,
  )
  const rankIndex = ACHIEVEMENT_RANKS.findLastIndex(
    (rank) => score >= rank.minScore,
  )
  return {
    unlockedCount: unlocked.size,
    total: ACHIEVEMENTS.length,
    score,
    maxScore: MAX_ACHIEVEMENT_SCORE,
    rank: ACHIEVEMENT_RANKS[rankIndex],
    nextRank: ACHIEVEMENT_RANKS[rankIndex + 1] ?? null,
  }
}

/**
 * Locked, visible achievements ordered by how close they are, for the
 * "Next up" list. Binary (target 1) and unavailable ones are left out.
 */
export function nextAchievements(
  progress: readonly AchievementProgress[],
  limit = 3,
): AchievementProgress[] {
  return progress
    .filter((entry) => {
      const achievement = ACHIEVEMENTS_BY_ID.get(entry.id)
      return (
        entry.available &&
        !entry.done &&
        entry.target > 1 &&
        entry.current > 0 &&
        !achievement?.secret
      )
    })
    .sort(
      (left, right) =>
        right.current / right.target - left.current / left.target ||
        left.target - right.target,
    )
    .slice(0, limit)
}
