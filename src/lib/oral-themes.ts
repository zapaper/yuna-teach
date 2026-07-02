// Themed practice catalogue for the Oral Coach.
//
// Each (year, day) is one 4-5 minute practice — Reading Aloud passage
// + Stimulus-Based Conversation (Q1/Q2/Q3). For 2016-2024 the
// stimulus + questions are Imagen-regenerated in the 2026 SBC format,
// so students don't practise a "2018 paper" — they practise a THEME.
// 2025 keeps the year label because it's the only authentic PSLE
// paper still driving the stimulus.

export type OralTheme = {
  id: string;         // `${year}_${day}` — matches the URL segments
  year: string;
  day: 1 | 2;
  theme: string;      // 2-4 word label shown in the picker
  blurb: string;      // one-sentence description shown under the theme
  category: string;   // used to group / colour-code the picker
  isAuthentic: boolean; // true = original PSLE paper, false = regen
};

export const ORAL_THEMES: OralTheme[] = [
  { id: "2025_1", year: "2025", day: 1, theme: "Queuing & orderliness",  blurb: "A long queue at an ice-cream cart — is it a good spot, and are Singaporeans orderly?", category: "Society",   isAuthentic: true  },
  { id: "2025_2", year: "2025", day: 2, theme: "Hawker culture",         blurb: "People eating at a hawker centre — home vs outside food, and should kids learn to cook?", category: "Culture",  isAuthentic: true  },
  { id: "2024_1", year: "2024", day: 1, theme: "Enjoying the outdoors",  blurb: "A family cycling in a Singapore park — do you like the outdoors, and are people considerate?", category: "Health",     isAuthentic: false },
  { id: "2024_2", year: "2024", day: 2, theme: "Appreciating helpers",   blurb: "Students thanking a school cleaner — how we show appreciation to community workers.",         category: "Community",  isAuthentic: false },
  { id: "2023_1", year: "2023", day: 1, theme: "Places of interest",     blurb: "Kids at a robot exhibition — visiting places in Singapore and the length of school holidays.", category: "Learning",   isAuthentic: false },
  { id: "2023_2", year: "2023", day: 2, theme: "Memories & keepsakes",   blurb: "A grandfather and granddaughter with a photo album — treasured items, keeping memories.",       category: "Values",     isAuthentic: false },
  { id: "2022_1", year: "2022", day: 1, theme: "Recycling & environment",blurb: "A void-deck recycling bin — recycling old items and taking care of the environment.",           category: "Environment",isAuthentic: false },
  { id: "2022_2", year: "2022", day: 2, theme: "Screen time",            blurb: "A student on a tablet while books lie ignored — devices for learning, daily timetables.",       category: "Health",     isAuthentic: false },
  { id: "2021_1", year: "2021", day: 1, theme: "Sleep & rest",           blurb: "A tired student walking to school — sleep habits and ideal school start times.",               category: "Health",     isAuthentic: false },
  { id: "2021_2", year: "2021", day: 2, theme: "Caring for pets",        blurb: "A boy tending to his dog at a park — pet ownership and the values it teaches kids.",             category: "Values",     isAuthentic: false },
  { id: "2020_1", year: "2020", day: 1, theme: "Neighbourhood ties",     blurb: "Neighbours sharing a meal at an HDB void deck — knowing your neighbours, being a good one.",    category: "Community",  isAuthentic: false },
  { id: "2020_2", year: "2020", day: 2, theme: "School performances",    blurb: "A school stage concert — being onstage vs backstage, why schools run performances.",             category: "School",     isAuthentic: false },
  { id: "2019_1", year: "2019", day: 1, theme: "Reading & libraries",    blurb: "Students reading in the school library — visiting libraries and habits of reading regularly.",  category: "Learning",   isAuthentic: false },
  { id: "2019_2", year: "2019", day: 2, theme: "Being responsible",      blurb: "A student who left his belongings behind — tracking your things, learning responsibility.",     category: "Values",     isAuthentic: false },
  { id: "2018_1", year: "2018", day: 1, theme: "Choosing activities",    blurb: "Students in an indoor sports hall — how you pick a CCA and why activities outside class matter.", category: "School",     isAuthentic: false },
  { id: "2018_2", year: "2018", day: 2, theme: "Public speaking",        blurb: "A student at a microphone — speaking to a crowd vs a few friends, and building confidence.",   category: "Skills",     isAuthentic: false },
  { id: "2017_1", year: "2017", day: 1, theme: "Appreciating teachers",  blurb: "Students giving a handmade card to a teacher — celebrating Teachers' Day and showing thanks.",  category: "Community",  isAuthentic: false },
  { id: "2017_2", year: "2017", day: 2, theme: "A clean classroom",      blurb: "Students cleaning their classroom — taking pride in shared spaces and respecting cleaners.",    category: "School",     isAuthentic: false },
  { id: "2016_1", year: "2016", day: 1, theme: "Supportive friends",     blurb: "A student helping a schoolmate at an HDB walkway — being helpful and building friendships.",     category: "Community",  isAuthentic: false },
  { id: "2016_2", year: "2016", day: 2, theme: "Cooking & eating well",  blurb: "A family cooking together — trying meals yourself and building healthy eating habits.",           category: "Home",       isAuthentic: false },
];

// Tailwind badge colours per category — keep in sync with UI.
export const CATEGORY_STYLES: Record<string, { bg: string; text: string; ring: string }> = {
  Society:     { bg: "bg-indigo-50",   text: "text-indigo-700",   ring: "ring-indigo-200"   },
  Culture:     { bg: "bg-amber-50",    text: "text-amber-700",    ring: "ring-amber-200"    },
  Health:      { bg: "bg-rose-50",     text: "text-rose-700",     ring: "ring-rose-200"     },
  Community:   { bg: "bg-emerald-50",  text: "text-emerald-700",  ring: "ring-emerald-200"  },
  Learning:    { bg: "bg-sky-50",      text: "text-sky-700",      ring: "ring-sky-200"      },
  Values:      { bg: "bg-purple-50",   text: "text-purple-700",   ring: "ring-purple-200"   },
  Environment: { bg: "bg-lime-50",     text: "text-lime-700",     ring: "ring-lime-200"     },
  School:      { bg: "bg-cyan-50",     text: "text-cyan-700",     ring: "ring-cyan-200"     },
  Skills:      { bg: "bg-fuchsia-50",  text: "text-fuchsia-700",  ring: "ring-fuchsia-200"  },
  Home:        { bg: "bg-orange-50",   text: "text-orange-700",   ring: "ring-orange-200"   },
};

export function getOralTheme(year: string, day: number): OralTheme | undefined {
  return ORAL_THEMES.find((t) => t.year === year && t.day === day);
}
