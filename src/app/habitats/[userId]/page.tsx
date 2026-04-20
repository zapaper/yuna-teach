"use client";

import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type PetAnimations = {
  walk?: string;
  talk?: string;
  stretch?: string;
  smile?: string;
};

type Pet = {
  id: string;
  name: string;
  video: string; // idle clip shown in the gallery and as fallback
  bg?: "white" | "black";
  animations?: PetAnimations; // present for pets with a dark-bg action set
};

type Habitat = {
  id: string;
  name: string;
  image: string;
  thumb: string;
  pets: Pet[];
};
// Pet videos come with either a white studio background (most existing avatars)
// or a black one (some of the new pet-only assets). Pick a blend mode per bg so
// either overlays cleanly on the landscape.
//   white bg  → multiply (white becomes transparent)
//   black bg  → screen   (black becomes transparent)
function petBlendMode(bg?: "white" | "black"): "multiply" | "screen" {
  return bg === "black" ? "screen" : "multiply";
}

// Placement region for unlocked pets on the landscape (was the teal marker).
// Top 55%, height 20% → bottom 75% of the image.
const PET_REGION_TOP_PCT = 55;
const PET_REGION_HEIGHT_PCT = 20;
const PET_REGION_BOTTOM_PCT = PET_REGION_TOP_PCT + PET_REGION_HEIGHT_PCT;
// Pets further up in the region are further away → scaled down. Per rule:
// −5% scale per 1% of image-height above the region's base. Floor at 0.35
// so pets at the very back don't vanish.
function petScaleAtY(yPct: number): number {
  const offsetFromBase = PET_REGION_BOTTOM_PCT - yPct; // 0 at base, 20 at top
  return Math.max(0.35, 1 - 0.05 * offsetFromBase);
}
// Deterministic per-habitat random placement — seeded by the habitat id so
// positions are stable between renders (they don't jitter every state change).
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function seededRandom(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 100000) / 100000;
  };
}
// Pet unlock rules — expand as the rest of the feature comes online.
// For now: Jungle habitat unlocks the Bunny as a starter pet at 200 pts.
function isPetUnlocked(habitatId: string, petId: string, totalPoints: number): boolean {
  if (habitatId === "jungle" && petId === "bunny") return totalPoints >= 200;
  return false;
}
// Compute positions + scales for the unlocked pets of a habitat, sorted
// background-first so the JSX draw order matches depth.
function placePets(habitat: Habitat, totalPoints: number) {
  const unlocked = habitat.pets.filter(p => isPetUnlocked(habitat.id, p.id, totalPoints));
  if (unlocked.length === 0) return [];
  const rand = seededRandom(hashString(habitat.id));
  const placed = unlocked.map(pet => {
    const yPct = PET_REGION_TOP_PCT + rand() * PET_REGION_HEIGHT_PCT;
    const xPct = 12 + rand() * 76; // keep inside the horizontal range of the region
    return { ...pet, xPct, yPct, scale: petScaleAtY(yPct) };
  });
  // Smaller yPct = higher on image = further back → draw first so closer pets overlap them.
  placed.sort((a, b) => a.yPct - b.yPct);
  return placed;
}

// A pet with multiple animation clips walks/idles around the landscape.
// Picks a random clip every few seconds. When the walk clip is playing, the
// x-position eases to a new target inside the horizontal pet region; the
// sprite flips horizontally when the direction of travel is to the right.
function PetActor({ pet, startX, y, scale, widthPct }: {
  pet: Pet;
  startX: number;
  y: number;
  scale: number;
  widthPct: number;
}) {
  const anims = pet.animations!;
  const clipKeys = Object.keys(anims) as Array<keyof PetAnimations>;
  const [clip, setClip] = useState<keyof PetAnimations>("smile");
  const [x, setX] = useState(startX);
  const [facingRight, setFacingRight] = useState(false);
  const [walkMs, setWalkMs] = useState(0);
  const xRef = useRef(startX);
  xRef.current = x;

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    function pick() {
      if (cancelled) return;
      const next = clipKeys[Math.floor(Math.random() * clipKeys.length)] as keyof PetAnimations;
      setClip(next);
      if (next === "walk" && anims.walk) {
        // Pick a new target x within the region bounds and move there.
        const minX = 12.5;
        const maxX = 87.5;
        const target = minX + Math.random() * (maxX - minX);
        const goingRight = target > xRef.current;
        const distance = Math.abs(target - xRef.current);
        // ~3 seconds per 30% of width — steady, kid-friendly pace.
        const ms = Math.max(2000, Math.round((distance / 30) * 3000));
        setFacingRight(goingRight);
        setWalkMs(ms);
        setX(target);
        timer = window.setTimeout(pick, ms + 400);
      } else {
        // Idle clips play for 2.5–4s before the next pick.
        const hold = 2500 + Math.random() * 1500;
        timer = window.setTimeout(pick, hold);
      }
    }
    timer = window.setTimeout(pick, 600);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const src = anims[clip] ?? pet.video;
  return (
    <video
      key={src}
      src={src}
      autoPlay loop muted playsInline
      className="absolute pointer-events-none"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        width: `${widthPct * scale}%`,
        transform: `translate(-50%, -50%)${facingRight ? " scaleX(-1)" : ""}`,
        transition: clip === "walk" ? `left ${walkMs}ms linear` : "none",
        mixBlendMode: pet.bg === "black" ? "screen" : "multiply",
      }}
    />
  );
}

// All four habitats and their pet rosters. HDB has no pets yet — placeholder.
const HABITATS: Habitat[] = [
  {
    id: "jungle", name: "Jungle",
    image: "/avatars/landscape_jungle.png",
    thumb: "/avatars/landscape_jungle_thumb.webp",
    pets: [
      {
        id: "bunny", name: "Bunny",
        video: "/avatars/bunny_smile.mp4",
        bg: "black",
        animations: {
          smile: "/avatars/bunny_smile.mp4",
          stretch: "/avatars/bunny_stretch.mp4",
          walk: "/avatars/bunny_walk.mp4",
          talk: "/avatars/bunny_talk.mp4",
        },
      },
      { id: "tiger",      name: "Tiger",       video: "/avatars/tiger1.mp4" },
      { id: "whitetiger", name: "White Tiger", video: "/avatars/whitetiger1.mp4" },
      { id: "bear",       name: "Bear",        video: "/avatars/bear1.mp4" },
      { id: "fox",        name: "Fox",         video: "/avatars/fox1.mp4" },
    ],
  },
  {
    id: "fantasy", name: "Fantasy",
    image: "/avatars/landscape_fantasy.jpeg",
    thumb: "/avatars/landscape_fantasy_thumb.webp",
    pets: [
      { id: "uni",    name: "Unicorn", video: "/avatars/uni1.mp4" },
      { id: "dragon", name: "Dragon",  video: "/avatars/dragon1.mp4" },
      { id: "qilin",  name: "Qilin",   video: "/avatars/qilin1.mp4" },
    ],
  },
  {
    id: "garden", name: "Garden",
    image: "/avatars/landscape_garden.png",
    thumb: "/avatars/landscape_garden_thumb.webp",
    pets: [
      { id: "otter",   name: "Otter",   video: "/avatars/otter1.mp4" },
      { id: "merlion", name: "Merlion", video: "/avatars/merlion1.mp4" },
    ],
  },
  {
    id: "hdb", name: "HDB",
    image: "/avatars/landscape_hdb.jpeg",
    thumb: "/avatars/landscape_hdb_thumb.webp",
    pets: [],
  },
];

export default function HabitatsPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string>("jungle");
  const [isPortraitMobile, setIsPortraitMobile] = useState(false);
  const [totalPoints, setTotalPoints] = useState(0);

  // Compute total points so we can lock habitats the student hasn't earned yet.
  useEffect(() => {
    fetch(`/api/exam?userId=${userId}`)
      .then(r => r.json())
      .then(d => {
        const pts = (d.papers ?? [])
          .filter((p: { completedAt?: string | null }) => p.completedAt)
          .reduce((s: number, p: { score?: number | null }) => s + (p.score ?? 0), 0);
        setTotalPoints(pts);
      })
      .catch(() => {});
  }, [userId]);

  // Unlock rules — easy to expand. For now only Jungle unlocks at 200 pts.
  const isHabitatUnlocked = (id: string) => {
    if (id === "jungle") return totalPoints >= 200;
    return false;
  };

  // Detect portrait-mobile so we can prompt to rotate — the layout needs
  // horizontal space (landscape + sidebar) to breathe.
  useEffect(() => {
    const check = () => {
      if (typeof window === "undefined") return;
      const mobile = window.innerWidth < 768;
      const portrait = window.innerHeight > window.innerWidth;
      setIsPortraitMobile(mobile && portrait);
    };
    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);

  const selected = HABITATS.find(h => h.id === selectedId) ?? HABITATS[0];

  if (isPortraitMobile) {
    return (
      <div className="fixed inset-0 bg-[#001e40] text-white flex flex-col items-center justify-center p-6 text-center">
        <span className="material-symbols-outlined text-6xl mb-4 animate-pulse">screen_rotation</span>
        <h1 className="font-headline font-extrabold text-xl mb-2">Rotate your device</h1>
        <p className="text-sm opacity-80">Habitats &amp; Pets looks best in landscape mode.</p>
        <button onClick={() => router.push(`/home/${userId}`)} className="mt-6 px-4 py-2 rounded-xl bg-white/10 text-sm font-bold">
          Go back
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f8f9ff] text-[#0b1c30]">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 md:px-8 py-3 bg-white/80 backdrop-blur-sm border-b border-[#e5eeff] sticky top-0 z-20">
        <button onClick={() => router.push(`/home/${userId}`)} className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-[#eff4ff] transition-colors">
          <span className="material-symbols-outlined text-[#001e40]">arrow_back</span>
        </button>
        <h1 className="font-headline font-extrabold text-lg text-[#001e40]">Habitats &amp; Pets</h1>
        <div className="w-10" />
      </header>

      <div className="flex gap-4 p-4 md:p-6">
        {/* Left sidebar — collectible habitats. Locked ones are greyed out. */}
        <aside className="w-[140px] md:w-[200px] shrink-0 space-y-3">
          <p className="text-[10px] md:text-xs font-extrabold uppercase tracking-wider text-[#43474f] px-1">Habitats</p>
          {HABITATS.map(h => {
            const isActive = h.id === selectedId;
            const unlocked = isHabitatUnlocked(h.id);
            return (
              <button
                key={h.id}
                onClick={() => setSelectedId(h.id)}
                className={`w-full rounded-2xl overflow-hidden border-2 transition-all text-left ${
                  isActive ? "border-[#006c49] shadow-lg" : "border-transparent hover:border-[#c3c6d1]"
                } ${unlocked ? "" : "grayscale opacity-60"}`}
              >
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={h.thumb} alt={h.name} className="w-full aspect-[16/10] object-cover" />
                  {!unlocked && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/25">
                      <span className="material-symbols-outlined text-white text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>lock</span>
                    </div>
                  )}
                  <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1">
                    <p className="text-xs md:text-sm font-bold text-white">{h.name}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </aside>

        {/* Right: selected habitat image + pets. Normal page flow → scrolls. */}
        <main className="flex-1 min-w-0 flex flex-col gap-3">
          <div className="relative rounded-3xl overflow-hidden border border-[#e5eeff] bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={selected.image} alt={selected.name} className="w-full aspect-[16/9] object-cover" />
            {/* Unlocked pets placed on the landscape. Draw order matches depth:
             * pets higher up in the region render first (background). Pets with
             * an animation set (walk/talk/stretch/smile) are handed to PetActor
             * which cycles through clips and walks around the landscape. */}
            {placePets(selected, totalPoints).map(pet => (
              pet.animations ? (
                <PetActor key={pet.id} pet={pet} startX={pet.xPct} y={pet.yPct} scale={pet.scale} widthPct={16} />
              ) : (
                <video
                  key={pet.id}
                  src={pet.video}
                  autoPlay loop muted playsInline
                  className="absolute pointer-events-none"
                  style={{
                    left: `${pet.xPct}%`,
                    top: `${pet.yPct}%`,
                    width: `${16 * pet.scale}%`,
                    transform: "translate(-50%, -50%)",
                    mixBlendMode: petBlendMode(pet.bg),
                  }}
                />
              )
            ))}
          </div>

          <div>
            <p className="text-xs font-extrabold uppercase tracking-wider text-[#43474f] mb-2">Pets that live in {selected.name}</p>
            {selected.pets.length === 0 ? (
              <p className="text-sm text-[#43474f] italic">No pets for this habitat yet.</p>
            ) : (
              <div className="grid grid-cols-3 md:grid-cols-5 gap-3 pb-6">
                {selected.pets.map(pet => {
                  const unlocked = isPetUnlocked(selected.id, pet.id, totalPoints);
                  return (
                    <div
                      key={pet.id}
                      className={`rounded-2xl border p-2 flex flex-col items-center gap-1 transition ${
                        unlocked
                          ? "border-[#006c49]/40 bg-[#6cf8bb]/10"
                          : "border-[#e5eeff] bg-white grayscale opacity-60"
                      }`}
                    >
                      <video
                        src={pet.video}
                        autoPlay loop muted playsInline
                        className="w-full aspect-square object-contain pointer-events-none"
                        style={{ mixBlendMode: petBlendMode(pet.bg) }}
                      />
                      <p className={`text-[11px] font-bold ${unlocked ? "text-[#006c49]" : "text-[#43474f]"}`}>{pet.name}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
