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
  // "alpha" = the asset is a transparent WebM (no blend mode needed).
  // "white" / "black" = flat-background clip that relies on mix-blend-mode.
  bg?: "white" | "black" | "alpha";
  animations?: PetAnimations; // present for pets with a dark-bg action set
};

type Habitat = {
  id: string;
  name: string;
  image: string;
  thumb: string;
  pets: Pet[];
};
// Pet videos come in three flavours:
//   "alpha"  → transparent WebM; no blend mode needed.
//   "black"  → flat black studio background; use lighten to drop bg.
//   "white"  → flat white studio background; use multiply to drop bg.
type PetBlend = "multiply" | "lighten" | "normal";
function petBlendMode(bg?: "white" | "black" | "alpha"): PetBlend {
  if (bg === "alpha") return "normal";
  if (bg === "black") return "lighten";
  return "multiply";
}

// Placement region for unlocked pets on the landscape (was the teal marker).
// Top 55%, height 15% → bottom 70% of the image.
const PET_REGION_TOP_PCT = 55;
const PET_REGION_HEIGHT_PCT = 15;
const PET_REGION_BOTTOM_PCT = PET_REGION_TOP_PCT + PET_REGION_HEIGHT_PCT;
// Pets further up in the region are further away → scaled down. Halved the
// shrinkage per feedback: −2.5% scale per 1% above the region base (was 5%).
// Floor at 0.5 so far-back pets stay visibly sized.
function petScaleAtY(yPct: number): number {
  const offsetFromBase = PET_REGION_BOTTOM_PCT - yPct; // 0 at base, 15 at top
  return Math.max(0.5, 1 - 0.025 * offsetFromBase);
}
// Walkable x-range narrows with depth: each limit moves inward by 1% per 1%
// above the region base, so background pets have less horizontal space than
// foreground ones (perspective cue).
const PET_X_MIN_BASE = 12.5;
const PET_X_MAX_BASE = 87.5;
function petXBoundsAtY(yPct: number): { min: number; max: number } {
  const offsetFromBase = Math.max(0, PET_REGION_BOTTOM_PCT - yPct);
  const inset = offsetFromBase;
  return {
    min: PET_X_MIN_BASE + inset,
    max: PET_X_MAX_BASE - inset,
  };
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
// Pet unlock thresholds — mirror the avatar picker so any avatar unlocked at
// home is also unlocked in the habitat.
const PET_UNLOCK_POINTS: Record<string, number> = {
  bunny: 0,
  bear: 0,
  tiger: 250,
  fox: 500,
  otter: 750,
  uni: 1000,
  dragon: 1250,
  merlion: 1500,
  qilin: 1750,
  // whitetiger: not point-gated, unlocked via settings.whitetiger flag.
};
// Crystal-gated pets — unlocked with parent-reviewed-quiz currency.
const PET_UNLOCK_CRYSTALS: Record<string, number> = {
  whitetiger: 10,
  boar: 10,
  pangolin: 10,
};

function isPetUnlocked(petId: string, totalPoints: number, crystals: number, whitetigerUnlocked: boolean, override: boolean): boolean {
  if (override) return true;
  if (petId in PET_UNLOCK_CRYSTALS) {
    // Whitetiger can also come from the legacy settings.whitetiger avatar flag.
    if (petId === "whitetiger" && whitetigerUnlocked) return true;
    return crystals >= PET_UNLOCK_CRYSTALS[petId];
  }
  const threshold = PET_UNLOCK_POINTS[petId];
  if (threshold === undefined) return false;
  return totalPoints >= threshold;
}
// Compute positions + scales for the unlocked pets of a habitat, sorted
// background-first so the JSX draw order matches depth.
function placePets(habitat: Habitat, totalPoints: number, crystals: number, whitetigerUnlocked: boolean, override: boolean) {
  const unlocked = habitat.pets.filter(p => isPetUnlocked(p.id, totalPoints, crystals, whitetigerUnlocked, override));
  if (unlocked.length === 0) return [];
  const rand = seededRandom(hashString(habitat.id));
  const placed = unlocked.map(pet => {
    const yPct = PET_REGION_TOP_PCT + rand() * PET_REGION_HEIGHT_PCT;
    const { min, max } = petXBoundsAtY(yPct);
    const xPct = min + rand() * (max - min);
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
//
// `positionsRef` is a shared bag of current x positions keyed by pet id. Each
// actor writes its own position in and reads others' to gate the "talk"
// action — talk only fires when another pet is within ~one avatar width,
// and the sprite turns to face that neighbour.
// Shared shape for the per-pet "jump into talk" handles. When one pet picks
// talk, it calls the partner's handle so both pets enter talk mode on the
// same tick and face each other.
type ForceTalkFn = (facingRight: boolean, durationMs: number) => void;

function PetActor({ pet, startX, y, scale, widthPct, positionsRef, actionsRef }: {
  pet: Pet;
  startX: number;
  y: number;
  scale: number;
  widthPct: number;
  positionsRef: React.RefObject<Record<string, number>>;
  actionsRef: React.RefObject<Record<string, ForceTalkFn>>;
}) {
  const anims = pet.animations!;
  const clipKeys = Object.keys(anims) as Array<keyof PetAnimations>;
  const [clip, setClip] = useState<keyof PetAnimations>("smile");
  const [x, setX] = useState(startX);
  const [facingRight, setFacingRight] = useState(false);
  const [walkMs, setWalkMs] = useState(0);
  const xRef = useRef(startX);
  xRef.current = x;

  // Keep the shared positions bag in sync with our current x — and scrub the
  // entry on unmount. Without scrubbing, switching habitats (or unlocking /
  // hiding pets) leaves a ghost coordinate behind; other PetActors then "talk"
  // toward a neighbour that no longer exists, which reads as talking into empty
  // space.
  useEffect(() => {
    if (positionsRef.current) positionsRef.current[pet.id] = x;
  }, [x, pet.id, positionsRef]);
  useEffect(() => {
    const id = pet.id;
    return () => {
      if (positionsRef.current) delete positionsRef.current[id];
    };
  }, [pet.id, positionsRef]);

  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    function pick() {
      if (cancelled) return;
      // Find the nearest other pet that's reasonably close. Talk only fires
      // when a neighbour is within TALK_RANGE_PCT of the landscape width, so
      // the pet isn't turning to face a sibling on the opposite side of the
      // screen. Capping the range also prevents ghost-entries that sneak
      // through cleanup from triggering "talk into empty space".
      const TALK_RANGE_PCT = 35;
      const others = positionsRef.current ?? {};
      let nearestId: string | null = null;
      let nearestX = 0;
      let nearestDist = Infinity;
      for (const [id, ox] of Object.entries(others)) {
        if (id === pet.id) continue;
        const d = Math.abs(ox - xRef.current);
        if (d < nearestDist) { nearestDist = d; nearestX = ox; nearestId = id; }
      }
      const canTalk = nearestId !== null && nearestDist <= TALK_RANGE_PCT && !!anims.talk;
      // Weighted pick: walk runs at half the frequency of smile / stretch /
      // talk so movement is a punctuation between idle poses.
      const weight = (k: keyof PetAnimations) => (k === "walk" ? 1 : 2);
      const weighted: Array<keyof PetAnimations> = [];
      for (const k of clipKeys) {
        if (k === "talk" && !canTalk) continue;
        const w = weight(k);
        for (let i = 0; i < w; i++) weighted.push(k);
      }
      const next = weighted[Math.floor(Math.random() * weighted.length)] as keyof PetAnimations;
      setClip(next);
      if (next === "walk" && anims.walk) {
        // Pick a new target x within the depth-narrowed region bounds.
        const { min: minX, max: maxX } = petXBoundsAtY(y);
        const target = minX + Math.random() * (maxX - minX);
        const goingRight = target > xRef.current;
        const distance = Math.abs(target - xRef.current);
        // Slower: ~5s per 30% of width. Pets further back walk even more
        // slowly (+5% per 1% above the region base), matching the depth cue.
        const offsetFromBase = PET_REGION_BOTTOM_PCT - y;
        const speedFactor = 1 + 0.05 * Math.max(0, offsetFromBase);
        const ms = Math.max(3500, Math.round((distance / 30) * 5000 * speedFactor));
        setFacingRight(goingRight);
        setWalkMs(ms);
        setX(target);
        timerRef.current = window.setTimeout(pick, ms + 400);
      } else if (next === "talk" && canTalk && nearestId) {
        // Face the neighbour we're talking to, and pull them into a matching
        // talk clip facing back at us so the two sprites look engaged with
        // each other for the duration.
        const aFacingRight = nearestX > xRef.current;
        setFacingRight(aFacingRight);
        const hold = 3000 + Math.random() * 1500;
        const partnerForce = actionsRef.current?.[nearestId];
        if (partnerForce) partnerForce(!aFacingRight, hold);
        timerRef.current = window.setTimeout(pick, hold);
      } else {
        const hold = 2500 + Math.random() * 1500;
        timerRef.current = window.setTimeout(pick, hold);
      }
    }

    // Expose a force-talk handle so a partner pet can flip us into talk mode
    // on the same tick it picks talk itself.
    if (actionsRef.current) {
      actionsRef.current[pet.id] = (faceRight, ms) => {
        if (cancelled) return;
        if (timerRef.current) clearTimeout(timerRef.current);
        setClip("talk");
        setFacingRight(faceRight);
        timerRef.current = window.setTimeout(pick, ms);
      };
    }

    timerRef.current = window.setTimeout(pick, 600);
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (actionsRef.current) delete actionsRef.current[pet.id];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // All clips mount at the same position; only the active one has opacity 1.
  // Black-background pets chroma-key via canvas for crisp transparent edges
  // (no "lighten" glow). White-background pets just render the raw video and
  // let multiply blend out the white (cheap path).
  const transform = `translate(-50%, -50%)${facingRight ? " scaleX(-1)" : ""}`;
  const baseStyle: React.CSSProperties = {
    left: `${x}%`,
    top: `${y}%`,
    width: `${widthPct * scale}%`,
    transition: clip === "walk" ? `left ${walkMs}ms linear` : "none",
    transform,
  };
  const blend = petBlendMode(pet.bg);
  // Serve the right sources per clip format:
  //   .webm  → dual source with .mov fallback (Safari picks MOV, others WebM)
  //   .mp4   → plain <source type="video/mp4"> (opaque clip, no transparency)
  const sourceSet = (path: string | undefined) => {
    if (!path) return null;
    if (/\.mp4$/i.test(path)) {
      return <source src={path} type="video/mp4" />;
    }
    const mov = path.replace(/\.webm$/i, ".mov");
    return (
      <>
        <source src={mov} type="video/quicktime" />
        <source src={path} type="video/webm" />
      </>
    );
  };
  return (
    <>
      {clipKeys.map(k => (
        <video
          key={k}
          autoPlay loop muted playsInline preload="auto"
          className="absolute pointer-events-none"
          style={{ ...baseStyle, mixBlendMode: blend, opacity: clip === k ? 1 : 0 }}
        >
          {sourceSet(anims[k])}
        </video>
      ))}
    </>
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
        video: "/avatars/bunny_smile.webm",
        bg: "alpha",
        animations: {
          smile: "/avatars/bunny_smile.webm",
          stretch: "/avatars/bunny_stretch.webm",
          walk: "/avatars/bunny_walk.webm",
          talk: "/avatars/bunny_talk.webm",
        },
      },
      {
        id: "tiger", name: "Tiger",
        video: "/avatars/tiger_smile.webm",
        bg: "alpha",
        animations: {
          smile: "/avatars/tiger_smile.webm",
          stretch: "/avatars/tiger_stretch.webm",
          walk: "/avatars/tiger_walk.webm",
          talk: "/avatars/tiger_talk.webm",
        },
      },
      {
        id: "whitetiger", name: "White Tiger",
        video: "/avatars/whitetiger_smile.webm",
        bg: "alpha",
        animations: {
          smile: "/avatars/whitetiger_smile.webm",
          stretch: "/avatars/whitetiger_stretch.webm",
          walk: "/avatars/whitetiger_walk.webm",
          talk: "/avatars/whitetiger_talk.webm",
        },
      },
      {
        id: "bear", name: "Bear",
        video: "/avatars/bear_smile.webm",
        bg: "alpha",
        animations: {
          smile: "/avatars/bear_smile.webm",
          stretch: "/avatars/bear_stretch.webm",
          walk: "/avatars/bear_walk.webm",
          talk: "/avatars/bear_talk.webm",
        },
      },
      {
        id: "fox", name: "Fox",
        video: "/avatars/fox_smile.webm",
        bg: "alpha",
        animations: {
          smile: "/avatars/fox_smile.webm",
          stretch: "/avatars/fox_stretch.webm",
          walk: "/avatars/fox_walk.webm",
          talk: "/avatars/fox_talk.webm",
        },
      },
    ],
  },
  {
    id: "fantasy", name: "Fantasy",
    image: "/avatars/landscape_fantasy.jpeg",
    thumb: "/avatars/landscape_fantasy_thumb.webp",
    pets: [
      {
        id: "uni", name: "Unicorn",
        video: "/avatars/unicorn_smile.mp4",
        animations: {
          smile: "/avatars/unicorn_smile.mp4",
          stretch: "/avatars/unicorn_stretch.mp4",
          walk: "/avatars/unicorn_walk.mp4",
          talk: "/avatars/unicorn_talk.mp4",
        },
      },
      {
        id: "dragon", name: "Dragon",
        video: "/avatars/dragon_smile.mp4",
        animations: {
          smile: "/avatars/dragon_smile.mp4",
          stretch: "/avatars/dragon_stretch.mp4",
          walk: "/avatars/dragon_walk.mp4",
          talk: "/avatars/dragon_talk.mp4",
        },
      },
      {
        id: "qilin", name: "Qilin",
        video: "/avatars/qilin_smile.mp4",
        animations: {
          smile: "/avatars/qilin_smile.mp4",
          stretch: "/avatars/qilin_stretch.mp4",
          walk: "/avatars/qilin_walk.mp4",
          talk: "/avatars/qilin_talk.mp4",
        },
      },
    ],
  },
  {
    id: "garden", name: "Garden",
    image: "/avatars/landscape_garden.png",
    thumb: "/avatars/landscape_garden_thumb.webp",
    pets: [
      {
        id: "otter", name: "Otter",
        video: "/avatars/otter_smile.webm",
        bg: "alpha",
        animations: {
          smile: "/avatars/otter_smile.webm",
          stretch: "/avatars/otter_stretch.webm",
          walk: "/avatars/otter_walk.webm",
          talk: "/avatars/otter_talk.webm",
        },
      },
      {
        id: "merlion", name: "Merlion",
        video: "/avatars/merlion_smile.mp4",
        animations: {
          smile: "/avatars/merlion_smile.mp4",
          stretch: "/avatars/merlion_stretch.mp4",
          walk: "/avatars/merlion_walk.mp4",
          talk: "/avatars/merlion_talk.mp4",
        },
      },
      {
        id: "boar", name: "Boar",
        video: "/avatars/boar_smile.webm",
        bg: "alpha",
        animations: {
          smile: "/avatars/boar_smile.webm",
          stretch: "/avatars/boar_stretch.webm",
          walk: "/avatars/boar_walk.webm",
          talk: "/avatars/boar_talk.webm",
        },
      },
      {
        id: "pangolin", name: "Pangolin",
        video: "/avatars/pangolin_smile.webm",
        bg: "alpha",
        animations: {
          smile: "/avatars/pangolin_smile.webm",
          stretch: "/avatars/pangolin_stretch.webm",
          walk: "/avatars/pangolin_walk.webm",
          talk: "/avatars/pangolin_talk.webm",
        },
      },
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
  const [totalPoints, setTotalPoints] = useState(0);
  const [crystals, setCrystals] = useState(0);
  const [whitetigerUnlocked, setWhitetigerUnlocked] = useState(false);
  // Test / admin flag — when settings.habitatOverride is true, every habitat
  // and pet is treated as unlocked regardless of points / crystals.
  const [habitatOverride, setHabitatOverride] = useState(false);
  // Live positions of every rendered pet. PetActors write their own x here
  // and read others' so "talk" only fires when a neighbour is in range.
  const positionsRef = useRef<Record<string, number>>({});
  // Per-pet "force into talk" handles so a PetActor can flip its partner
  // into a mirrored talk clip on the same tick it picks talk.
  const actionsRef = useRef<Record<string, ForceTalkFn>>({});

  useEffect(() => {
    // Load settings first so bonusPoints is available when we sum scores.
    let bonusPts = 0;
    Promise.all([
      fetch(`/api/users?userId=${userId}`).then(r => r.json()).catch(() => null),
      fetch(`/api/exam?userId=${userId}`).then(r => r.json()).catch(() => null),
    ]).then(([userRes, examRes]) => {
      const settings = (userRes?.user?.settings ?? {}) as Record<string, unknown>;
      if (settings.whitetiger === true) setWhitetigerUnlocked(true);
      if (settings.habitatOverride === true) setHabitatOverride(true);
      bonusPts = (settings.bonusPoints as number | undefined) ?? 0;

      const papers = examRes?.papers ?? [];
      const pts = papers
        .filter((p: { completedAt?: string | null }) => p.completedAt)
        .reduce((s: number, p: { score?: number | null }) => s + (p.score ?? 0), 0) + bonusPts;
      setTotalPoints(pts);
      setCrystals(papers.filter((p: { markingStatus?: string | null }) => p.markingStatus === "released").length);
    });
  }, [userId]);

  // Unlock rules. Jungle is the free starter at 200 pts. Fantasy and Garden
  // each cost 30 crystals (1 crystal = 1 parent-reviewed quiz), OR unlock
  // automatically once any of their pets is earned — otherwise a student who
  // crosses a pet-points threshold has nowhere to see their new pet. HDB
  // stays locked until we add more content. settings.habitatOverride
  // bypasses everything — for admin / test accounts.
  const isHabitatUnlocked = (id: string) => {
    if (habitatOverride) return true;
    if (id === "jungle") return totalPoints >= 200;
    if (id === "fantasy" || id === "garden") {
      if (crystals >= 30) return true;
      const habitat = HABITATS.find(h => h.id === id);
      return !!habitat?.pets.some(p =>
        isPetUnlocked(p.id, totalPoints, crystals, whitetigerUnlocked, false)
      );
    }
    return false;
  };

  // Detect mobile (by screen width OR touch-only input). Habitats & Pets runs
  const selected = HABITATS.find(h => h.id === selectedId) ?? HABITATS[0];

  return (
    <div className="min-h-screen bg-[#f8f9ff] text-[#0b1c30]">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 md:px-8 py-3 bg-white/80 backdrop-blur-sm border-b border-[#e5eeff] sticky top-0 z-20">
        <button onClick={() => router.push(`/home/${userId}`)} className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-[#eff4ff] transition-colors">
          <span className="material-symbols-outlined text-[#001e40]">arrow_back</span>
        </button>
        <h1 className="font-headline font-extrabold text-lg text-[#001e40]">Habitats &amp; Pets</h1>
        <div className="flex items-center gap-1.5 bg-[#e5eeff] text-[#001e40] rounded-full pl-2 pr-3 py-1" title="Crystals — spend to unlock more habitats">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/stickers/crystal_t.PNG" alt="crystal" className="w-7 h-7 object-contain" />
          <span className="text-sm font-extrabold">{crystals}</span>
        </div>
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
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/35 gap-0.5">
                      <span className="material-symbols-outlined text-white text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>lock</span>
                      {(h.id === "fantasy" || h.id === "garden") && (
                        <div className="flex items-center gap-1 bg-white/90 rounded-full px-2 py-0.5">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src="/stickers/crystal_t.PNG" alt="crystal" className="w-4 h-4 object-contain" />
                          <span className="text-[10px] font-extrabold text-[#001e40]">30</span>
                        </div>
                      )}
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
            {placePets(selected, totalPoints, crystals, whitetigerUnlocked, habitatOverride).map(pet => (
              pet.animations ? (
                <PetActor key={pet.id} pet={pet} startX={pet.xPct} y={pet.yPct} scale={pet.scale} widthPct={16} positionsRef={positionsRef} actionsRef={actionsRef} />
              ) : (
                <video
                  key={pet.id}
                  autoPlay loop muted playsInline
                  className="absolute pointer-events-none"
                  style={{
                    left: `${pet.xPct}%`,
                    top: `${pet.yPct}%`,
                    width: `${16 * pet.scale}%`,
                    transform: "translate(-50%, -50%)",
                    mixBlendMode: petBlendMode(pet.bg),
                  }}
                >
                  {pet.video.endsWith(".webm") && <source src={pet.video.replace(/\.webm$/i, ".mov")} type="video/quicktime" />}
                  <source src={pet.video} type={pet.video.endsWith(".webm") ? "video/webm" : "video/mp4"} />
                </video>
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
                  const unlocked = isPetUnlocked(pet.id, totalPoints, crystals, whitetigerUnlocked, habitatOverride);
                  const crystalCost = PET_UNLOCK_CRYSTALS[pet.id];
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
                        autoPlay loop muted playsInline
                        className="w-full aspect-square object-contain pointer-events-none"
                      >
                        {pet.video.endsWith(".webm") && <source src={pet.video.replace(/\.webm$/i, ".mov")} type="video/quicktime" />}
                        <source src={pet.video} type={pet.video.endsWith(".webm") ? "video/webm" : "video/mp4"} />
                      </video>
                      <p className={`text-[11px] font-bold ${unlocked ? "text-[#006c49]" : "text-[#43474f]"}`}>{pet.name}</p>
                      {!unlocked && crystalCost && (
                        <div className="flex items-center gap-0.5 bg-[#e5eeff] rounded-full px-1.5 py-0.5">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src="/stickers/crystal_t.PNG" alt="crystal" className="w-3 h-3 object-contain" />
                          <span className="text-[9px] font-extrabold text-[#001e40]">{crystalCost}</span>
                        </div>
                      )}
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
