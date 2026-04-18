"use client";

import { useRef, useState, useEffect, useCallback } from "react";

type Tool = "pen" | "eraser" | "text";

interface DiagramEditorProps {
  imageBase64: string; // base64 without data: prefix
  onSave: (editedBase64: string) => void;
  onClose: () => void;
}

export default function DiagramEditor({ imageBase64, onSave, onClose }: DiagramEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [penSize, setPenSize] = useState(2);
  const [eraserSize, setEraserSize] = useState(20);
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const history = useRef<ImageData[]>([]);
  const [canUndo, setCanUndo] = useState(false);

  // Text tool state
  const [textInput, setTextInput] = useState("");
  const [textPos, setTextPos] = useState<{ x: number; y: number } | null>(null);
  const [fontSize, setFontSize] = useState(16);
  const textInputRef = useRef<HTMLInputElement>(null);

  const canvasDims = useRef({ w: 0, h: 0 });

  // Load background image and init canvas
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      bgImageRef.current = img;
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Scale to fit modal but maintain aspect ratio
      const maxW = Math.min(window.innerWidth - 48, 1200);
      const maxH = window.innerHeight - 200;
      const scale = Math.min(maxW / img.width, maxH / img.height, 2);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      canvas.width = img.width; // internal resolution = original image size
      canvas.height = img.height;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvasDims.current = { w: img.width, h: img.height };
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      saveSnapshot();
    };
    img.src = imageBase64.startsWith("data:") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
  }, [imageBase64]);

  function saveSnapshot() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    history.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (history.current.length > 50) history.current.shift();
    setCanUndo(history.current.length > 1);
  }

  function undo() {
    const canvas = canvasRef.current;
    if (!canvas || history.current.length <= 1) return;
    history.current.pop(); // remove current
    const prev = history.current[history.current.length - 1];
    canvas.getContext("2d")!.putImageData(prev, 0, 0);
    setCanUndo(history.current.length > 1);
  }

  function getPos(e: React.PointerEvent): { x: number; y: number } {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (tool === "text") {
      const pos = getPos(e);
      setTextPos(pos);
      setTextInput("");
      setTimeout(() => textInputRef.current?.focus(), 50);
      return;
    }
    e.preventDefault();
    isDrawing.current = true;
    lastPos.current = getPos(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    saveSnapshot();

    // Draw dot at start
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const pos = lastPos.current;
    if (tool === "eraser") {
      ctx.globalCompositeOperation = "source-over";
      // Erase by painting white
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, eraserSize / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#000000";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, penSize / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!isDrawing.current || !lastPos.current) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const pos = getPos(e);

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (tool === "eraser") {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = eraserSize;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = penSize;
    }
    ctx.beginPath();
    ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPos.current = pos;
  }

  function onPointerUp() {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    lastPos.current = null;
  }

  function placeText() {
    if (!textPos || !textInput.trim()) { setTextPos(null); return; }
    const canvas = canvasRef.current;
    if (!canvas) return;
    saveSnapshot();
    const ctx = canvas.getContext("2d")!;
    ctx.globalCompositeOperation = "source-over";
    ctx.font = `${fontSize}px Arial, sans-serif`;
    ctx.fillStyle = "#000000";
    ctx.textBaseline = "top";
    ctx.fillText(textInput, textPos.x, textPos.y);
    setTextPos(null);
    setTextInput("");
  }

  function handleSave() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Export as JPEG base64 (without data: prefix)
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    onSave(base64);
  }

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl flex flex-col max-h-[95vh] max-w-[95vw]" onClick={e => e.stopPropagation()}>
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 flex-wrap">
          <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1">
            <button
              onClick={() => setTool("pen")}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${tool === "pen" ? "bg-[#001e40] text-white" : "text-slate-600 hover:bg-slate-200"}`}
            >
              <span className="material-symbols-outlined text-sm align-middle mr-1">edit</span>
              Pen
            </button>
            <button
              onClick={() => setTool("eraser")}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${tool === "eraser" ? "bg-[#001e40] text-white" : "text-slate-600 hover:bg-slate-200"}`}
            >
              <span className="material-symbols-outlined text-sm align-middle mr-1">ink_eraser</span>
              Eraser
            </button>
            <button
              onClick={() => setTool("text")}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${tool === "text" ? "bg-[#001e40] text-white" : "text-slate-600 hover:bg-slate-200"}`}
            >
              <span className="material-symbols-outlined text-sm align-middle mr-1">text_fields</span>
              Text
            </button>
          </div>

          {/* Pen size */}
          {tool === "pen" && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-400 font-bold">SIZE</span>
              <input type="range" min={1} max={8} value={penSize} onChange={e => setPenSize(Number(e.target.value))}
                className="w-16 h-1.5 accent-[#001e40]" />
              <span className="text-[10px] text-slate-600 font-bold w-4">{penSize}</span>
            </div>
          )}

          {/* Eraser size */}
          {tool === "eraser" && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-400 font-bold">SIZE</span>
              <input type="range" min={5} max={60} value={eraserSize} onChange={e => setEraserSize(Number(e.target.value))}
                className="w-16 h-1.5 accent-[#001e40]" />
              <span className="text-[10px] text-slate-600 font-bold w-4">{eraserSize}</span>
            </div>
          )}

          {/* Text size */}
          {tool === "text" && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-400 font-bold">SIZE</span>
              <input type="range" min={10} max={80} value={fontSize} onChange={e => setFontSize(Number(e.target.value))}
                className="w-20 h-1.5 accent-[#001e40]" />
              <span
                className="text-[#001e40] font-bold leading-none select-none"
                style={{ fontSize: `${Math.max(10, fontSize * (canvasRef.current ? canvasRef.current.clientWidth / canvasRef.current.width : 0.5))}px` }}
              >A</span>
            </div>
          )}

          <button onClick={undo} disabled={!canUndo}
            className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-30 transition-colors">
            <span className="material-symbols-outlined text-sm align-middle mr-1">undo</span>
            Undo
          </button>

          <div className="flex-1" />

          <button onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-bold text-slate-500 hover:bg-slate-100 transition-colors">
            Cancel
          </button>
          <button onClick={handleSave}
            className="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#006c49] text-white hover:bg-[#005a3d] transition-colors">
            <span className="material-symbols-outlined text-sm align-middle mr-1">save</span>
            Save
          </button>
        </div>

        {/* Canvas area */}
        <div className="flex-1 overflow-auto p-4 bg-slate-50 flex items-center justify-center relative">
          <canvas
            ref={canvasRef}
            className="border border-slate-300 rounded-lg shadow-sm"
            style={{
              cursor: tool === "pen" ? "crosshair" : tool === "eraser" ? "cell" : "text",
              touchAction: "none",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {/* Text input overlay */}
          {textPos && (
            <div
              className="absolute flex items-center gap-1"
              style={{
                left: `${canvasRef.current ? canvasRef.current.getBoundingClientRect().left - (canvasRef.current.parentElement?.getBoundingClientRect().left ?? 0) + textPos.x * (canvasRef.current.clientWidth / canvasRef.current.width) : 0}px`,
                top: `${canvasRef.current ? canvasRef.current.getBoundingClientRect().top - (canvasRef.current.parentElement?.getBoundingClientRect().top ?? 0) + textPos.y * (canvasRef.current.clientHeight / canvasRef.current.height) : 0}px`,
              }}
            >
              <input
                ref={textInputRef}
                value={textInput}
                onChange={e => setTextInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") placeText(); if (e.key === "Escape") setTextPos(null); }}
                className="text-sm px-2 py-1 border-2 border-[#001e40] rounded bg-white/90 focus:outline-none"
                style={{ fontSize: `${Math.max(12, fontSize * (canvasRef.current ? canvasRef.current.clientWidth / canvasRef.current.width : 1))}px` }}
                placeholder="Type text..."
                autoFocus
              />
              <button onClick={placeText} className="px-2 py-1 bg-[#001e40] text-white text-xs rounded font-bold">Place</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
