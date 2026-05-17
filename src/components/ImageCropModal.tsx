"use client";

import { useEffect, useRef, useState } from "react";

// Drag-a-box-on-the-page cropper. Used by EnglishEditView's
// QuestionRow to attach a freshly-cropped picture (e.g. the 短信 /
// phone-note diagram that the PSLE 华文 五-A long OEQ needs) without
// the admin having to leave the app for a screenshot tool.
//
// Lifecycle:
//   open = true → render the modal, load the source page image,
//                 let the user draw a rectangle with the mouse / touch
//   confirm    → canvas.drawImage(...) crops the source to that
//                 rectangle, emits a JPEG data URL via onCropped
//   close      → onClose, no save
export default function ImageCropModal({
  open,
  pageImageSrc,
  initialBox,
  onClose,
  onCropped,
}: {
  open: boolean;
  pageImageSrc: string;
  /** Optional initial bounding box in percentages of the source image
   *  (top/left/right/bottom 0-100). When provided, the cropper opens
   *  pre-populated with that box so the admin can fine-tune the
   *  existing crop instead of starting from scratch. */
  initialBox?: { topPct: number; leftPct: number; rightPct: number; bottomPct: number } | null;
  onClose: () => void;
  onCropped: (dataUrl: string) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Box stored in CSS pixels relative to the displayed image. We
  // convert to source-image coordinates only at crop time.
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  // Reset when the modal re-opens with a different page image.
  useEffect(() => {
    if (!open) return;
    setBox(null);
    setImgLoaded(false);
    setBusy(false);
  }, [open, pageImageSrc]);

  // Seed initialBox once the image has dimensions to convert against.
  useEffect(() => {
    if (!open || !imgLoaded || !initialBox) return;
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    const container = containerRef.current?.getBoundingClientRect();
    if (!container) return;
    const offsetX = rect.left - container.left;
    const offsetY = rect.top - container.top;
    setBox({
      x: offsetX + (initialBox.leftPct / 100) * rect.width,
      y: offsetY + (initialBox.topPct / 100) * rect.height,
      w: ((initialBox.rightPct - initialBox.leftPct) / 100) * rect.width,
      h: ((initialBox.bottomPct - initialBox.topPct) / 100) * rect.height,
    });
  }, [open, imgLoaded, initialBox]);

  if (!open) return null;

  function getPosInImage(e: React.PointerEvent | React.MouseEvent) {
    const img = imgRef.current;
    const container = containerRef.current;
    if (!img || !container) return null;
    const imgRect = img.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const clientX = "clientX" in e ? e.clientX : 0;
    const clientY = "clientY" in e ? e.clientY : 0;
    // Clamp to the image bounds — drag-outside should stop at the edge.
    const x = Math.max(imgRect.left, Math.min(imgRect.right, clientX)) - containerRect.left;
    const y = Math.max(imgRect.top, Math.min(imgRect.bottom, clientY)) - containerRect.top;
    return { x, y };
  }

  function onPointerDown(e: React.PointerEvent) {
    const pos = getPosInImage(e);
    if (!pos) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    dragStart.current = pos;
    setDragging(true);
    setBox({ x: pos.x, y: pos.y, w: 0, h: 0 });
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging || !dragStart.current) return;
    const pos = getPosInImage(e);
    if (!pos) return;
    const start = dragStart.current;
    setBox({
      x: Math.min(start.x, pos.x),
      y: Math.min(start.y, pos.y),
      w: Math.abs(pos.x - start.x),
      h: Math.abs(pos.y - start.y),
    });
  }
  function onPointerUp() {
    setDragging(false);
    dragStart.current = null;
  }

  async function handleConfirm() {
    const img = imgRef.current;
    const container = containerRef.current;
    if (!img || !container || !box || box.w < 5 || box.h < 5) return;
    setBusy(true);
    try {
      // Convert displayed-pixel coords → source-image-pixel coords.
      const imgRect = img.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const offsetX = imgRect.left - containerRect.left;
      const offsetY = imgRect.top - containerRect.top;
      const xRatio = img.naturalWidth / imgRect.width;
      const yRatio = img.naturalHeight / imgRect.height;
      const sx = Math.max(0, Math.round((box.x - offsetX) * xRatio));
      const sy = Math.max(0, Math.round((box.y - offsetY) * yRatio));
      const sw = Math.min(img.naturalWidth - sx, Math.round(box.w * xRatio));
      const sh = Math.min(img.naturalHeight - sy, Math.round(box.h * yRatio));
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas 2D unavailable");
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
      onCropped(dataUrl);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 flex flex-col items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-slate-100">
          <div>
            <h3 className="font-headline text-lg font-extrabold text-[#001e40]">Re-crop image from page</h3>
            <p className="text-xs text-[#737780] mt-0.5">Drag a rectangle on the page below to mark the region to crop.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-full text-[#737780] hover:text-[#001e40] hover:bg-slate-100 transition-colors">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div
          ref={containerRef}
          className="relative flex-1 overflow-auto bg-slate-50"
          style={{ touchAction: "none" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={pageImageSrc}
            alt="Page"
            className="block max-w-full mx-auto select-none"
            draggable={false}
            onLoad={() => setImgLoaded(true)}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {box && (
            <div
              className="absolute border-2 border-blue-500 bg-blue-500/10 pointer-events-none"
              style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
            />
          )}
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-slate-100">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl border-2 border-[#c3c6d1] text-[#001e40] font-bold text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={busy || !box || box.w < 5 || box.h < 5}
            className="px-4 py-2 rounded-xl bg-[#003366] text-white font-bold text-sm hover:bg-[#001e40] transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {busy && <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>}
            Crop &amp; save
          </button>
        </div>
      </div>
    </div>
  );
}
