"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Habitat = {
  id: string;
  name: string;
  image: string;
  pets: Array<{ id: string; name: string; video: string }>;
};

// All four habitats and their pet rosters. HDB has no pets yet — placeholder.
const HABITATS: Habitat[] = [
  {
    id: "jungle", name: "Jungle", image: "/avatars/landscape_jungle.png",
    pets: [
      { id: "bunny",      name: "Bunny",       video: "/avatars/bunny1.mp4" },
      { id: "tiger",      name: "Tiger",       video: "/avatars/tiger1.mp4" },
      { id: "whitetiger", name: "White Tiger", video: "/avatars/whitetiger1.mp4" },
      { id: "bear",       name: "Bear",        video: "/avatars/bear1.mp4" },
      { id: "fox",        name: "Fox",         video: "/avatars/fox1.mp4" },
    ],
  },
  {
    id: "fantasy", name: "Fantasy", image: "/avatars/landscape_fantasy.jpeg",
    pets: [
      { id: "uni",    name: "Unicorn", video: "/avatars/uni1.mp4" },
      { id: "dragon", name: "Dragon",  video: "/avatars/dragon1.mp4" },
      { id: "qilin",  name: "Qilin",   video: "/avatars/qilin1.mp4" },
    ],
  },
  {
    id: "garden", name: "Garden", image: "/avatars/landscape_garden.png",
    pets: [
      { id: "otter",   name: "Otter",   video: "/avatars/otter1.mp4" },
      { id: "merlion", name: "Merlion", video: "/avatars/merlion1.mp4" },
    ],
  },
  {
    id: "hdb", name: "HDB", image: "/avatars/landscape_hdb.jpeg",
    pets: [],
  },
];

export default function HabitatsPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = use(params);
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string>("jungle");
  const [isPortraitMobile, setIsPortraitMobile] = useState(false);

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

      <div className="flex gap-4 p-4 md:p-6 h-[calc(100vh-64px)]">
        {/* Left sidebar — collectible habitats */}
        <aside className="w-[140px] md:w-[200px] shrink-0 overflow-y-auto space-y-3">
          <p className="text-[10px] md:text-xs font-extrabold uppercase tracking-wider text-[#43474f] px-1">Habitats</p>
          {HABITATS.map(h => {
            const isActive = h.id === selectedId;
            return (
              <button
                key={h.id}
                onClick={() => setSelectedId(h.id)}
                className={`w-full rounded-2xl overflow-hidden border-2 transition-all text-left ${
                  isActive ? "border-[#006c49] shadow-lg" : "border-transparent hover:border-[#c3c6d1]"
                }`}
              >
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={h.image} alt={h.name} className="w-full aspect-[16/10] object-cover" />
                  <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1">
                    <p className="text-xs md:text-sm font-bold text-white">{h.name}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </aside>

        {/* Right: selected habitat image + pets */}
        <main className="flex-1 min-w-0 flex flex-col gap-3 overflow-hidden">
          <div className="relative rounded-3xl overflow-hidden border border-[#e5eeff] bg-white shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={selected.image} alt={selected.name} className="w-full aspect-[16/9] object-cover" />
            {/* Positioning marker — teal overlay roughly 75% × 30%, centred. */}
            <div
              className="absolute bg-teal-400/50 rounded-xl pointer-events-none"
              style={{
                left: "12.5%", top: "35%", width: "75%", height: "30%",
              }}
            />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            <p className="text-xs font-extrabold uppercase tracking-wider text-[#43474f] mb-2">Pets that live in {selected.name}</p>
            {selected.pets.length === 0 ? (
              <p className="text-sm text-[#43474f] italic">No pets for this habitat yet.</p>
            ) : (
              <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
                {selected.pets.map(pet => (
                  <div
                    key={pet.id}
                    className="rounded-2xl border border-[#e5eeff] bg-white p-2 flex flex-col items-center gap-1 grayscale opacity-60"
                  >
                    <video
                      src={pet.video}
                      autoPlay loop muted playsInline
                      className="w-full aspect-square object-contain pointer-events-none"
                      style={{ mixBlendMode: "multiply" }}
                    />
                    <p className="text-[11px] font-bold text-[#43474f]">{pet.name}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
